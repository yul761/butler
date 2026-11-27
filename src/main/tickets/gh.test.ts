import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { applyGhResolution, ghAuthState, ghAvailable, probeGh, branchRuns, checksOf, ciOf, failedLog, failedLogDetail, ghBinary, ghErrorSummary, ghLogGone, compareFiles, mergedPrs, prInfo, reviewRequestedPrs, prLessonData, prLessonDataDetail, prRead, prStatus, prsForBranch, ghNotFound, ghPrNotFound, repoCurrentSlug, latestReviewers, reviewAuthors, reviewComments, reviewerKind, aiReviewerOf, resetGhBinary, setGhBinary } from "./gh";

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  resetGhBinary();
});

/** PATH 最前面放一个假的 gh。 */
function fakeGh(script: string): string {
  const dir = tempDir();
  writeFileSync(join(dir, "gh"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
  return dir;
}

describe.skipIf(process.platform === "win32")("prInfo", () => {
  it("parses gh's JSON and passes the pr argument", async () => {
    const dir = fakeGh(
      `echo "$@" > "$(dirname "$0")/args.txt"\ncat <<'JSON'\n{"number":7,"url":"https://x/pull/7","headRefName":"feat","baseRefName":"main","state":"OPEN","autoMergeRequest":{"enabledAt":"x"}}\nJSON`,
    );
    expect(await prInfo(dir, "7", 5000)).toEqual({ number: 7, url: "https://x/pull/7", head: "feat", base: "main", state: "OPEN", autoMerge: true });
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe("pr view 7 --json number,url,headRefName,baseRefName,state,autoMergeRequest");
  });

  it("autoMerge is false when autoMergeRequest is null", async () => {
    const dir = fakeGh(`echo '{"number":1,"url":"u","headRefName":"h","baseRefName":"b","state":"MERGED","autoMergeRequest":null}'`);
    expect((await prInfo(dir, null, 5000))?.autoMerge).toBe(false);
  });

  it("returns null when gh fails, prints junk, is missing, or times out", async () => {
    const dir = fakeGh("exit 1");
    expect(await prInfo(dir, null, 5000)).toBeNull();
    fakeGh("echo not json");
    expect(await prInfo(dir, null, 5000)).toBeNull();
    fakeGh("sleep 5");
    const t = Date.now();
    expect(await prInfo(dir, null, 200)).toBeNull();
    expect(Date.now() - t).toBeLessThan(3000);
    process.env.PATH = tempDir();
    expect(await prInfo(dir, null, 5000)).toBeNull();
  });
});

describe("checksOf / ciOf", () => {
  it("maps check runs and status contexts", () => {
    const checks = checksOf([
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/123/job/9" },
      { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://github.com/o/r/actions/runs/124/job/1" },
      { __typename: "CheckRun", name: "pkg", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: "https://x/y" },
      { __typename: "StatusContext", context: "ci/legacy", state: "PENDING" },
      { __typename: "StatusContext", context: "ci/ok", state: "SUCCESS" },
      { __typename: "StatusContext", context: "ci/bad", state: "ERROR" },
    ]);
    expect(checks).toEqual([
      { name: "test", state: "failing", runId: 123 },
      { name: "lint", state: "pending", runId: 124 },
      { name: "pkg", state: "passing", runId: null },
      { name: "ci/legacy", state: "pending", runId: null },
      { name: "ci/ok", state: "passing", runId: null },
      { name: "ci/bad", state: "failing", runId: null },
    ]);
    expect(checksOf(null)).toEqual([]);
  });

  it("a finished check with an unrecognised conclusion counts as passing", () => {
    // 不然 CI 永远停在 pending：结论永远出不来，仓库一直按 1 分钟查。
    const checks = checksOf([
      { __typename: "CheckRun", name: "stale", status: "COMPLETED", conclusion: "STALE" },
      { __typename: "CheckRun", name: "blank", status: "COMPLETED", conclusion: "" },
      { __typename: "CheckRun", name: "future", status: "completed", conclusion: "something_new" },
      { __typename: "CheckRun", name: "bad", status: "completed", conclusion: "timed_out" },
    ]);
    expect(checks.map((c) => c.state)).toEqual(["passing", "passing", "passing", "failing"]);
  });

  it("ciOf prefers failing over pending", () => {
    const c = (state: "pending" | "passing" | "failing") => ({ name: "x", state, runId: null });
    expect(ciOf([c("passing"), c("pending"), c("failing")])).toBe("failing");
    expect(ciOf([c("passing"), c("pending")])).toBe("pending");
    expect(ciOf([c("passing")])).toBe("passing");
    expect(ciOf([])).toBe("none");
  });
});

describe.skipIf(process.platform === "win32")("prStatus / branchRuns / failedLog", () => {
  it("prStatus parses the PR with checks and review decision", async () => {
    const dir = fakeGh(
      `echo "$@" > "$(dirname "$0")/args.txt"\ncat <<'JSON'\n{"number":5,"url":"u","state":"OPEN","isDraft":true,"reviewDecision":"REVIEW_REQUIRED","headRefOid":"abc","statusCheckRollup":[{"__typename":"CheckRun","name":"t","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://g/actions/runs/9/job/1"}]}\nJSON`,
    );
    expect(await prStatus(dir, "feat", 5000)).toEqual({
      number: 5, url: "u", state: "OPEN", isDraft: true, review: "pending", headSha: "abc",
      checks: [{ name: "t", state: "passing", runId: 9 }], ci: "passing",
      headBranch: "", author: "", reviews: [], comments: [], firstCommitAt: null, createdAt: null, mergedAt: null, closedAt: null,
      baseBranch: null, title: null, labels: [], reviewRequests: [], mergeable: null, mergeState: null, body: null,
    });
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe(
      "pr view feat --json number,url,state,isDraft,reviewDecision,headRefOid,headRefName,statusCheckRollup,author,reviews,comments,commits,createdAt,mergedAt,closedAt,baseRefName,title,labels,reviewRequests,mergeable,mergeStateStatus,body",
    );
  });

  it("prStatus parses base, title, labels, review requests and merge state", async () => {
    const json = {
      number: 5, url: "u", state: "OPEN", isDraft: false, reviewDecision: "", headRefOid: "abc", statusCheckRollup: [],
      baseRefName: "feat/lower", title: "[ui] Add page", labels: [{ name: "frontend" }, { name: "" }, { nope: 1 }, { name: "needs-docs" }],
      reviewRequests: [{ __typename: "User", login: "alice" }, { __typename: "Team", name: "Core", slug: "core" }, { __typename: "Bot", login: "x[bot]" }, { junk: true }],
      mergeable: "CONFLICTING", mergeStateStatus: "DIRTY",
    };
    const dir = fakeGh(`cat <<'JSON'\n${JSON.stringify(json)}\nJSON`);
    const s = await prStatus(dir, "feat", 5000);
    expect(s?.baseBranch).toBe("feat/lower");
    expect(s?.title).toBe("[ui] Add page");
    expect(s?.labels).toEqual(["frontend", "needs-docs"]);
    expect(s?.reviewRequests).toEqual([{ kind: "user", name: "alice" }, { kind: "team", name: "core" }, { kind: "user", name: "x[bot]" }]);
    expect(s?.mergeable).toBe("conflicting");
    expect(s?.mergeState).toBe("dirty");
  });

  it("prStatus maps unknown mergeable / merge state values to unknown", async () => {
    const dir = fakeGh(`echo '{"number":1,"url":"u","state":"OPEN","isDraft":false,"reviewDecision":"","headRefOid":"a","statusCheckRollup":[],"mergeable":"WHATEVER","mergeStateStatus":"NEW_THING"}'`);
    const s = await prStatus(dir, "b", 5000);
    expect(s?.mergeable).toBe("unknown");
    expect(s?.mergeState).toBe("unknown");
  });

  it("prStatus maps empty reviewDecision to null and returns null when there is no PR", async () => {
    const dir = fakeGh(`echo '{"number":1,"url":"u","state":"MERGED","isDraft":false,"reviewDecision":"","headRefOid":"a","statusCheckRollup":[]}'`);
    const s = await prStatus(dir, "b", 5000);
    expect(s?.review).toBeNull();
    expect(s?.ci).toBe("none");
    fakeGh("echo 'no pull requests found' >&2; exit 1");
    expect(await prStatus(dir, "b", 5000)).toBeNull();
    fakeGh("echo not json");
    expect(await prStatus(dir, "b", 5000)).toBeNull();
  });

  it("prStatus parses author, reviews, comments and the first commit time", async () => {
    const json = {
      number: 5, url: "u", state: "OPEN", isDraft: false, reviewDecision: "", headRefOid: "abc", statusCheckRollup: [],
      author: { login: "me" },
      reviews: [
        { id: "R1", author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED", body: "nit", submittedAt: "2026-01-02T00:00:00Z" },
        { id: "R2", author: { login: "alice" }, state: "APPROVED", body: "", submittedAt: "2026-01-03T00:00:00Z" },
        { id: "R3", author: { login: "bad" }, state: "WEIRD", body: "", submittedAt: "2026-01-03T00:00:00Z" },
      ],
      comments: [{ id: "C1", author: { login: "alice" }, body: "hi", createdAt: "2026-01-02T12:00:00Z", url: "https://x/c1" }, { body: "no id" }],
      commits: [{ authoredDate: "2026-01-05T00:00:00Z" }, { authoredDate: "2026-01-01T00:00:00Z" }],
      createdAt: "2026-01-06T00:00:00Z", mergedAt: "2026-01-07T00:00:00Z", closedAt: null,
    };
    const dir = fakeGh(`cat <<'JSON'\n${JSON.stringify(json)}\nJSON`);
    const s = await prStatus(dir, "feat", 5000);
    expect(s?.author).toBe("me");
    expect(s?.reviews).toEqual([
      { id: "R1", author: "copilot-pull-request-reviewer", state: "COMMENTED", body: "nit", submittedAt: Date.parse("2026-01-02T00:00:00Z") },
      { id: "R2", author: "alice", state: "APPROVED", body: "", submittedAt: Date.parse("2026-01-03T00:00:00Z") },
    ]);
    expect(s?.comments).toEqual([
      { id: "C1", author: "alice", body: "hi", createdAt: Date.parse("2026-01-02T12:00:00Z"), url: "https://x/c1", path: null, line: null, reviewId: null },
    ]);
    expect(s?.firstCommitAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect([s?.createdAt, s?.mergedAt, s?.closedAt]).toEqual([Date.parse("2026-01-06T00:00:00Z"), Date.parse("2026-01-07T00:00:00Z"), null]);
  });

  it("prStatus does not retry when the branch simply has no PR", async () => {
    const dir = fakeGh(`echo "$@" >> "$(dirname "$0")/args.txt"\necho 'no pull requests found for branch "b"' >&2; exit 1`);
    expect(await prStatus(dir, "b", 5000)).toBeNull();
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("reviewAuthors maps review node ids to bot-ness and collects bot logins; null on failure", async () => {
    const rows = [
      { node_id: "PRR_1", user: { login: "chatgpt-codex-connector[bot]", type: "Bot" } },
      { node_id: "PRR_2", user: { login: "alice", type: "User" } },
    ];
    const dir = fakeGh(`echo "$@" >> "$(dirname "$0")/args.txt"\ncat <<'JSON'\n${rows.map((x) => JSON.stringify(x)).join("\n")}\nJSON`);
    expect(await reviewAuthors(dir, 5, 5000)).toEqual({ botReviewIds: new Set(["PRR_1"]), botLogins: new Set(["chatgpt-codex-connector"]) });
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe("api repos/{owner}/{repo}/pulls/5/reviews --paginate --jq .[] | {node_id, user: {login: .user.login, type: .user.type}}");
    fakeGh("exit 1");
    expect(await reviewAuthors(dir, 5, 5000)).toBeNull();
  });

  /** 假 gh：按调用的端点（$2）给不同的输出。 */
  const restGh = (comments: string, reviews: string, args = "") =>
    fakeGh(`${args}case "$2" in\n*/comments) cat <<'JSON'\n${comments}\nJSON\n;;\n*/reviews) cat <<'JSON'\n${reviews}\nJSON\n;;\nesac`);

  it("reviewComments maps REST review comments to the GraphQL review node id and returns null on failure", async () => {
    const rest = [
      { id: 11, user: { login: "copilot-pull-request-reviewer[bot]" }, body: "b1", created_at: "2026-01-02T00:00:00Z", html_url: "https://x/r1", path: "a.ts", line: 3, pull_request_review_id: 77 },
      { id: 12, user: { login: "alice" }, body: "b2", created_at: "2026-01-03T00:00:00Z", html_url: "https://x/r2", path: "b.ts", line: null, pull_request_review_id: null },
    ];
    const reviews = [{ id: 77, node_id: "PRR_kwDOabc77" }, { id: 78, node_id: "PRR_kwDOabc78" }];
    const dir = restGh(rest.map((x) => JSON.stringify(x)).join("\n"), reviews.map((x) => JSON.stringify(x)).join("\n"), `echo "$@" >> "$(dirname "$0")/args.txt"\n`);
    expect(await reviewComments(dir, 5, 5000)).toEqual([
      { id: "11", author: "copilot-pull-request-reviewer[bot]", body: "b1", createdAt: Date.parse("2026-01-02T00:00:00Z"), url: "https://x/r1", path: "a.ts", line: 3, reviewId: "PRR_kwDOabc77" },
      { id: "12", author: "alice", body: "b2", createdAt: Date.parse("2026-01-03T00:00:00Z"), url: "https://x/r2", path: "b.ts", line: null, reviewId: null },
    ]);
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n")).toEqual([
      "api repos/{owner}/{repo}/pulls/5/comments --paginate --jq .[]",
      "api repos/{owner}/{repo}/pulls/5/reviews --paginate --jq .[] | {id, node_id}",
    ]);
    fakeGh("exit 1");
    expect(await reviewComments(dir, 5, 5000)).toBeNull();
    fakeGh("echo not json");
    expect(await reviewComments(dir, 5, 5000)).toBeNull();
    // 评论拉到了、reviews 列表失败：整体失败。
    fakeGh(`case "$2" in\n*/comments) echo '{"id":1,"created_at":"2026-01-02T00:00:00Z"}';;\n*) exit 1;;\nesac`);
    expect(await reviewComments(dir, 5, 5000)).toBeNull();
  });

  it("reviewComments reads one object per line, even when a body has brackets, quotes and newlines, and returns null if any line is bad", async () => {
    const c = (id: number, body: string) => ({ id, user: { login: "a" }, body, created_at: "2026-01-02T00:00:00Z" });
    const dir = restGh(`${JSON.stringify(c(1, 'x ] [ "y"\nz'))}\n\n${JSON.stringify(c(2, "z"))}`, "");
    expect((await reviewComments(dir, 5, 5000))?.map((x) => [x.id, x.body])).toEqual([["1", 'x ] [ "y"\nz'], ["2", "z"]]);
    restGh(`${JSON.stringify(c(1, "a"))}\n{broken`, "");
    expect(await reviewComments(dir, 5, 5000)).toBeNull();
  });

  it("branchRuns keeps only the newest head sha", async () => {
    const dir = fakeGh(
      `cat <<'JSON'\n[{"databaseId":3,"headSha":"new","status":"in_progress","conclusion":"","workflowName":"CI"},{"databaseId":2,"headSha":"new","status":"completed","conclusion":"failure","workflowName":"Release"},{"databaseId":1,"headSha":"old","status":"completed","conclusion":"success","workflowName":"CI"}]\nJSON`,
    );
    expect(await branchRuns(dir, "feat", 5000)).toEqual({
      headSha: "new",
      checks: [{ name: "CI", state: "pending", runId: 3 }, { name: "Release", state: "failing", runId: 2 }],
      ci: "failing",
    });
    fakeGh("echo '[]'");
    expect(await branchRuns(dir, "feat", 5000)).toBeNull();
    fakeGh("exit 1");
    expect(await branchRuns(dir, "feat", 5000)).toBeNull();
  });

  it("failedLog returns the last lines", async () => {
    const dir = fakeGh(`echo "$@" > "$(dirname "$0")/args.txt"\nprintf 'a\\nb\\nc\\nd\\n'`);
    expect(await failedLog(dir, 42, 2, 5000)).toBe("c\nd");
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe("run view 42 --log-failed");
    fakeGh("exit 1");
    expect(await failedLog(dir, 42, 2, 5000)).toBeNull();
  });

  it("failedLogDetail says why it failed (the first stderr line) and whether trying again can help", async () => {
    const dir = fakeGh(`printf 'a\\nb\\n'`);
    expect(await failedLogDetail(dir, 42, 1, 5000)).toEqual({ log: "b", error: null, permanent: false, missing: false });
    fakeGh(`printf '\\nHTTP 410: Gone (https://api.github.com/repos/o/r/actions/runs/42/logs)\\nmore\\n' >&2; exit 1`);
    expect(await failedLogDetail(dir, 42, 1, 5000)).toEqual({ log: null, error: "HTTP 410: Gone (https://api.github.com/repos/o/r/actions/runs/42/logs)", permanent: true, missing: false });
    fakeGh(`echo 'HTTP 404: Not Found (https://api.github.com/repos/o/r/actions/runs/42/logs)' >&2; exit 1`);
    expect(await failedLogDetail(dir, 42, 1, 5000)).toMatchObject({ log: null, permanent: false, missing: true });
    fakeGh(`echo 'HTTP 502: Bad Gateway' >&2; exit 1`);
    expect(await failedLogDetail(dir, 42, 1, 5000)).toEqual({ log: null, error: "HTTP 502: Bad Gateway", permanent: false, missing: false });
    fakeGh("exit 1");
    expect(await failedLogDetail(dir, 42, 1, 5000)).toEqual({ log: null, error: "gh failed with no output", permanent: false, missing: false });
    fakeGh("sleep 2");
    expect(await failedLogDetail(dir, 42, 1, 200)).toEqual({ log: null, error: "timed out after 0.2s", permanent: false, missing: false });
  });
});

describe("gh binary (resolved like git: a GUI app's PATH often lacks Homebrew)", () => {
  it("defaults to plain gh, takes a found path, and keeps the best one it has when a later lookup finds nothing (warning once)", () => {
    const logs: string[] = [];
    expect(ghBinary()).toBe("gh");
    applyGhResolution(null, "darwin", (m) => logs.push(m));
    applyGhResolution(null, "darwin", (m) => logs.push(m));
    expect(ghBinary()).toBe("gh");
    expect(logs).toEqual(["gh not found on PATH: falling back to plain gh"]);
    applyGhResolution("/opt/homebrew/bin/gh", "darwin", (m) => logs.push(m));
    expect(ghBinary()).toBe("/opt/homebrew/bin/gh");
    applyGhResolution(null, "darwin", (m) => logs.push(m));
    expect(ghBinary()).toBe("/opt/homebrew/bin/gh");
    setGhBinary("/usr/local/bin/gh");
    expect(ghBinary()).toBe("/usr/local/bin/gh");
  });

  it.skipIf(process.platform === "win32")("ghAvailable is false on macOS when gh is not on PATH and the probe fails", async () => {
    process.env.PATH = tempDir();
    applyGhResolution(null, "darwin", () => undefined);
    expect(ghAvailable()).toBe(false);
    expect(await probeGh(5000)).toBe(false);
    expect(ghAvailable()).toBe(false);
  });

  it.skipIf(process.platform === "win32")("ghAuthState tells missing, logged out and logged in apart from the exit code", async () => {
    process.env.PATH = tempDir();
    applyGhResolution(null, "darwin", () => undefined);
    expect(await ghAuthState(5000)).toBe("missing");
    fakeGh('[ "$1 $2" = "auth token" ] && exit 1; exit 0');
    expect(await ghAuthState(5000)).toBe("logged_out");
    fakeGh('[ "$1 $2" = "auth token" ] && { echo gho_x; exit 0; }; exit 1');
    expect(await ghAuthState(5000)).toBe("ok");
    expect(ghAvailable()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("ghAvailable is true after a successful probe, and a new resolution clears the cached probe", async () => {
    fakeGh("exit 0");
    applyGhResolution(null, "darwin", () => undefined);
    expect(ghAvailable()).toBe(false);
    expect(await probeGh(5000)).toBe(true);
    expect(ghAvailable()).toBe(true);
    process.env.PATH = tempDir();
    applyGhResolution("/opt/homebrew/bin/gh", "darwin", () => undefined);
    expect(ghBinary()).toBe("/opt/homebrew/bin/gh");
    expect(ghAvailable()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("re-applying the same resolution keeps a successful probe", async () => {
    fakeGh("exit 0");
    applyGhResolution(null, "darwin", () => undefined);
    expect(await probeGh(5000)).toBe(true);
    applyGhResolution(null, "darwin", () => undefined);
    expect(ghAvailable()).toBe(true);
  });

  it("ghAvailable is true when a path was found", () => {
    applyGhResolution("/opt/homebrew/bin/gh", "darwin", () => undefined);
    expect(ghAvailable()).toBe(true);
  });

  it("on Windows, with no gh found, runs nothing: a bare gh would pick up a gh.exe in the repo (I5)", async () => {
    const logs: string[] = [];
    // PATH 上有一个 gh：真去执行就会留下记录。
    const dir = fakeGh(`echo "$1" >> "$(dirname "$0")/calls.txt"\nexit 1`);
    applyGhResolution(null, "win32", (m) => logs.push(m));
    applyGhResolution(null, "win32", (m) => logs.push(m));
    expect(ghBinary()).toBeNull();
    expect(logs).toEqual(["gh not found on PATH: PR and CI checks are disabled"]);
    expect(await prInfo(dir, null, 5000)).toBeNull();
    expect(await prStatus(dir, "b", 5000)).toBeNull();
    expect(await branchRuns(dir, "b", 5000)).toBeNull();
    expect(await failedLog(dir, 1, 10, 5000)).toBeNull();
    expect(existsSync(join(dir, "calls.txt"))).toBe(false);
    // 之后找到了就用它。
    applyGhResolution("C:\\Program Files\\GitHub CLI\\gh.exe", "win32", (m) => logs.push(m));
    expect(ghBinary()).toBe("C:\\Program Files\\GitHub CLI\\gh.exe");
  });

  it.skipIf(process.platform === "win32")("prInfo, prStatus, branchRuns and failedLog run the resolved gh, not the one on PATH", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "my-gh"), `#!/bin/sh
echo "$1" >> "$(dirname "$0")/calls.txt"
exit 1
`);
    chmodSync(join(dir, "my-gh"), 0o755);
    // PATH 上的 gh 一调用就留痕：用了它就说明没走解析出来的路径。
    const onPath = fakeGh(`echo used > "$(dirname "$0")/wrong.txt"
exit 1`);
    setGhBinary(join(dir, "my-gh"));
    await prInfo(dir, null, 5000);
    await prStatus(dir, "b", 5000);
    await branchRuns(dir, "b", 5000);
    await failedLog(dir, 1, 60, 5000);
    expect(readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n")).toEqual(["pr", "pr", "run", "run"]);
    expect(() => readFileSync(join(onPath, "wrong.txt"))).toThrow();
  });
});

describe("ghLogGone / ghErrorSummary", () => {
  it("expired logs and no access are gone, a 404 is missing; rate limits, auth, network and a running run are neither", () => {
    for (const e of ["HTTP 410: Gone", "HTTP 403: Resource not accessible by integration", "GraphQL: Could not resolve to a Repository with the name 'o/r'."]) expect(ghLogGone(e), e).toBe("gone");
    for (const e of ["HTTP 404: Not Found (https://api.github.com/repos/o/r/actions/runs/1)", "failed to get run log: log not found"]) expect(ghLogGone(e), e).toBe("missing");
    for (const e of ["HTTP 403: API rate limit exceeded for user ID 1.", "HTTP 401: Bad credentials", "error connecting to api.github.com",
      "Could not resolve host: api.github.com", "run 1 is still in progress; logs will be available when it is complete", "HTTP 502: Bad Gateway", "",
      "HTTP 403: Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization."]) expect(ghLogGone(e), e).toBeNull();
  });

  it("summarizes a failure in one short line", () => {
    expect(ghErrorSummary({ stderr: "\r\n  first\r\nsecond" }, 5000)).toBe("first");
    expect(ghErrorSummary({ stderr: "x".repeat(300) }, 5000)).toBe(`${"x".repeat(200)}…`);
    expect(ghErrorSummary({ stderr: "partial", timedOut: true }, 5000)).toBe("timed out after 5s");
    expect(ghErrorSummary({ stderr: "", spawnError: "ENOENT" }, 5000)).toBe("gh failed (ENOENT)");
  });
});

describe("reviewerKind", () => {
  it("treats chatgpt-codex-connector and chatgpt-codex-connector[bot] as copilot", () => {
    expect(reviewerKind("chatgpt-codex-connector", "me")).toBe("copilot");
    expect(reviewerKind("chatgpt-codex-connector[bot]", "me")).toBe("copilot");
    expect(reviewerKind("copilot-pull-request-reviewer[bot]", "me")).toBe("copilot");
    expect(reviewerKind("dependabot[bot]", "me")).toBe("bot");
  });

  it("classifies logins", () => {
    expect(reviewerKind("copilot-pull-request-reviewer", "me")).toBe("copilot");
    expect(reviewerKind("Copilot", "me")).toBe("copilot");
    expect(reviewerKind("me", "me")).toBe("author");
    expect(reviewerKind("github-actions[bot]", "me")).toBe("bot");
    expect(reviewerKind("dependabot", "me")).toBe("bot");
    expect(reviewerKind("alice", "me")).toBe("human");
    for (const app of ["CodeRabbitai", "coderabbitai", "gemini-code-assist", "sourcery-ai", "codecov", "sonarcloud", "vercel", "netlify", "github-advanced-security", "cursor"]) {
      expect(reviewerKind(app, "me")).toBe("bot");
    }
  });
});

describe.skipIf(process.platform === "win32")("per-PR gh additions", () => {
  it("prsForBranch parses gh pr list and returns [] for an empty list and null on a non-zero exit", async () => {
    const dir = fakeGh(`echo "$@" > "$(dirname "$0")/args.txt"
echo '[{"number":3,"url":"https://github.com/o/r/pull/3","state":"MERGED","headRefName":"feat","createdAt":"2026-11-01T00:00:00Z","mergedAt":"2026-11-02T00:00:00Z","closedAt":"2026-11-02T00:00:00Z"},{"number":4,"url":"u4","state":"OPEN","headRefName":"feat","createdAt":"2026-11-03T00:00:00Z","mergedAt":null,"closedAt":null}]'`);
    const list = await prsForBranch(dir, "feat", 5000);
    expect(list).toEqual([
      { number: 3, url: "https://github.com/o/r/pull/3", state: "MERGED", headRefName: "feat", createdAt: Date.parse("2026-11-01T00:00:00Z"), mergedAt: Date.parse("2026-11-02T00:00:00Z"), closedAt: Date.parse("2026-11-02T00:00:00Z") },
      { number: 4, url: "u4", state: "OPEN", headRefName: "feat", createdAt: Date.parse("2026-11-03T00:00:00Z"), mergedAt: null, closedAt: null },
    ]);
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe("pr list --head feat --state all --limit 30 --json number,url,state,headRefName,createdAt,mergedAt,closedAt");
    fakeGh("echo '[]'");
    expect(await prsForBranch(dir, "feat", 5000)).toEqual([]);
    fakeGh("exit 1");
    expect(await prsForBranch(dir, "feat", 5000)).toBeNull();
  });

  it("prStatus accepts a URL ref and reads headRefName", async () => {
    const dir = fakeGh(`echo "$@" > "$(dirname "$0")/args.txt"
echo '{"number":5,"url":"https://github.com/o/r/pull/5","state":"OPEN","isDraft":false,"reviewDecision":"","headRefOid":"abc","headRefName":"feat/x","statusCheckRollup":[]}'`);
    const s = await prStatus(dir, "https://github.com/o/r/pull/5", 5000);
    expect(s?.headBranch).toBe("feat/x");
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toContain("pr view https://github.com/o/r/pull/5 --json");
  });

  it("reviewComments with a repo sets GH_REPO and GH_HOST for an enterprise slug", async () => {
    const dir = fakeGh(`echo "GH_REPO=$GH_REPO" >> "$(dirname "$0")/env.txt"
echo "GH_HOST=$GH_HOST" >> "$(dirname "$0")/env.txt"
exit 0`);
    await reviewComments(dir, 5, 5000, "ghe.acme.io/team/app");
    const env = readFileSync(join(dir, "env.txt"), "utf8");
    expect(env).toContain("GH_REPO=ghe.acme.io/team/app");
    expect(env).toContain("GH_HOST=ghe.acme.io");
  });

  it("failedLog with a repo passes GH_REPO to gh", async () => {
    const dir = fakeGh(`echo "GH_REPO=$GH_REPO" > "$(dirname "$0")/env.txt"`);
    await failedLog(dir, 1, 10, 5000, "o/r");
    expect(readFileSync(join(dir, "env.txt"), "utf8").trim()).toBe("GH_REPO=o/r");
  });

  it("prsForBranch with a repo passes GH_REPO to gh", async () => {
    const dir = fakeGh(`echo "GH_REPO=$GH_REPO" > "$(dirname "$0")/env.txt"
echo '[]'`);
    expect(await prsForBranch(dir, "feat", 5000, "o/r")).toEqual([]);
    expect(readFileSync(join(dir, "env.txt"), "utf8").trim()).toBe("GH_REPO=o/r");
  });

  it("a github.com slug sets GH_HOST=github.com", async () => {
    const dir = fakeGh(`echo "GH_REPO=$GH_REPO GH_HOST=$GH_HOST" > "$(dirname "$0")/env.txt"`);
    await reviewAuthors(dir, 5, 5000, "o/r");
    expect(readFileSync(join(dir, "env.txt"), "utf8").trim()).toBe("GH_REPO=o/r GH_HOST=github.com");
  });
});

describe.skipIf(process.platform === "win32")("mergedPrs", () => {
  const rows = `echo '{"number":2,"mergedAt":"2026-11-03T00:00:00Z","headRefName":"b"}'\necho '{"number":1,"mergedAt":"2026-11-01T00:00:00Z","headRefName":"a"}'`;

  it("sorts by mergedAt ascending and adds --search only with an after date", async () => {
    const dir = fakeGh(`echo "$@" > "$(dirname "$0")/args.txt"\n${rows}`);
    const list = await mergedPrs(dir, "2026-11-01T00:00:00Z", 50, 5000);
    expect(list?.map((p) => p.number)).toEqual([1, 2]);
    expect(list?.[0]).toEqual({ number: 1, mergedAt: "2026-11-01T00:00:00Z", headRefName: "a" });
    const args = readFileSync(join(dir, "args.txt"), "utf8");
    expect(args).toContain("--search");
    expect(args).toContain("merged:>2026-11-01T00:00:00Z");
    await mergedPrs(dir, null, 50, 5000);
    expect(readFileSync(join(dir, "args.txt"), "utf8")).not.toContain("--search");
  });

  it("returns null when gh fails", async () => {
    const dir = fakeGh("exit 1");
    expect(await mergedPrs(dir, null, 50, 5000)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("prLessonData", () => {
  const script = (view: string) => `case "$1 $2" in
"pr view")
${view}
;;
"api repos/{owner}/{repo}/pulls/5/comments") echo '{"id":11,"user":{"login":"bot"},"body":"nit","created_at":"2026-11-02T00:00:00Z","path":"a.ts","line":3,"pull_request_review_id":99}' ;;
"api repos/{owner}/{repo}/pulls/5/reviews") echo '{"id":99,"node_id":"PRR_1","user":{"login":"coderabbitai[bot]","type":"Bot"}}' ;;
*) exit 1 ;;
esac`;
  const view = `cat <<'JSON'
{"number":5,"title":"T","body":"B","url":"https://x/pull/5","author":{"login":"me"},"headRefName":"feat","mergedAt":"2026-11-03T00:00:00Z","reviews":[{"id":"PRR_1","author":{"login":"coderabbitai"},"state":"COMMENTED","body":"r","submittedAt":"2026-11-02T00:00:00Z"}],"comments":[{"id":"IC_1","author":{"login":"me"},"body":"c","createdAt":"2026-11-02T01:00:00Z","url":"u"}],"commits":[{"oid":"abc","committedDate":"2026-11-01T00:00:00Z","messageHeadline":"fix it","messageBody":"why"}]}
JSON`;

  it("combines pr view, inline comments and bot authors", async () => {
    const dir = fakeGh(script(view));
    const d = await prLessonData(dir, 5, 5000);
    expect(d?.title).toBe("T");
    expect(d?.author).toBe("me");
    expect(d?.commits[0]).toEqual({ oid: "abc", committedDate: "2026-11-01T00:00:00Z", headline: "fix it", body: "why" });
    expect(d?.reviews).toHaveLength(1);
    expect(d?.comments).toHaveLength(1);
    expect(d?.inline.length).toBe(1);
    expect(d?.botLogins.has("coderabbitai")).toBe(true);
  });

  it("returns null when pr view fails", async () => {
    const dir = fakeGh(script("exit 1"));
    expect(await prLessonData(dir, 5, 5000)).toBeNull();
  });

  it("prLessonDataDetail returns stderr when pr view fails", async () => {
    const dir = fakeGh(script(`echo "GraphQL: Could not resolve to a PullRequest with the number of 5." >&2\nexit 1`));
    expect(await prLessonDataDetail(dir, 5, 5000)).toEqual({ data: null, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 5." });
  });

  it("prLessonDataDetail returns stderr when the review comments call fails, and data with empty stderr on success", async () => {
    const failing = fakeGh(`case "$1 $2" in
"pr view")
${view}
;;
*) echo "HTTP 404: Not Found" >&2; exit 1 ;;
esac`);
    expect(await prLessonDataDetail(failing, 5, 5000)).toEqual({ data: null, stderr: "HTTP 404: Not Found" });
    const ok = await prLessonDataDetail(fakeGh(script(view)), 5, 5000);
    expect(ok.data?.title).toBe("T");
    expect(ok.stderr).toBe("");
  });
});

describe.skipIf(process.platform === "win32")("compareFiles", () => {
  it("maps files and uses an empty patch when missing", async () => {
    const dir = fakeGh(`echo "$@" > "$(dirname "$0")/args.txt"\necho '{"filename":"a.ts","patch":"@@ ..."}'\necho '{"filename":"b.png","patch":null}'\necho '{"filename":"c.bin"}'`);
    expect(await compareFiles(dir, "base", "head", 5000)).toEqual([
      { filename: "a.ts", patch: "@@ ..." },
      { filename: "b.png", patch: "" },
      { filename: "c.bin", patch: "" },
    ]);
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toContain("repos/{owner}/{repo}/compare/base...head");
  });

  it("returns null when gh fails", async () => {
    const dir = fakeGh("exit 1");
    expect(await compareFiles(dir, "a", "b", 5000)).toBeNull();
  });
});

describe("latestReviewers", () => {
  const rv = (author: string, state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING", at: number) => ({ id: `${author}${at}`, author, state, body: "", submittedAt: at });
  it("keeps each person's latest decisive state; later comments do not change it", () => {
    expect(latestReviewers([rv("alice", "CHANGES_REQUESTED", 1), rv("alice", "APPROVED", 3), rv("alice", "COMMENTED", 5), rv("bob", "COMMENTED", 2)], "me")).toEqual([
      { login: "bob", state: "commented", at: 2, bot: false },
      { login: "alice", state: "approved", at: 5, bot: false },
    ]);
  });
  it("skips the author, pending reviews and empty logins; marks bots and Copilot", () => {
    expect(latestReviewers([rv("me", "APPROVED", 1), rv("x", "PENDING", 2), rv("", "APPROVED", 3), rv("copilot-pull-request-reviewer", "COMMENTED", 4), rv("ci[bot]", "APPROVED", 5)], "me")).toEqual([
      { login: "copilot-pull-request-reviewer", state: "commented", at: 4, bot: true },
      { login: "ci[bot]", state: "approved", at: 5, bot: true },
    ]);
  });
  it("a dismissal replaces an approval; sorts input by time first", () => {
    expect(latestReviewers([rv("a", "DISMISSED", 9), rv("a", "APPROVED", 1)], "me")).toEqual([{ login: "a", state: "dismissed", at: 9, bot: false }]);
  });
});

describe.skipIf(process.platform === "win32")("reviewRequestedPrs", () => {
  it("passes the search args and parses items, enterprise hosts keep their host in the slug", async () => {
    const dir = fakeGh(`echo "$@" >> "$(dirname "$0")/args.txt"\necho '[{"number":7,"title":"Fix","url":"https://github.com/o/r/pull/7","repository":{"nameWithOwner":"o/r"},"author":{"login":"amy"},"updatedAt":"2026-11-19T00:00:00Z"},{"number":8,"title":"X","url":"https://ghe.co/o/r/pull/8","repository":{"nameWithOwner":"o/r"},"author":{"login":"bob"},"updatedAt":"2026-11-19T00:00:00Z"},{"number":9,"title":"bad","url":"nope","repository":{},"author":{}}]'`);
    expect(await reviewRequestedPrs(5000)).toEqual([
      { url: "https://github.com/o/r/pull/7", slug: "o/r", number: 7, title: "Fix", author: "amy" },
      { url: "https://ghe.co/o/r/pull/8", slug: "ghe.co/o/r", number: 8, title: "X", author: "bob" },
    ]);
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toContain("search prs --review-requested=@me --state=open");
  });
  it("returns null when gh fails", async () => {
    fakeGh("exit 1");
    expect(await reviewRequestedPrs(5000)).toBeNull();
  });
});

describe("ghNotFound (BTL-261)", () => {
  it("tells GitHub's not-found answers from network failures", () => {
    expect(ghNotFound("GraphQL: Could not resolve to a Repository with the name 'yuchenlin/butler'. (repository)")).toBe(true);
    expect(ghNotFound("GraphQL: Could not resolve to a PullRequest with the number of 99999. (repository.pullRequest)")).toBe(true);
    expect(ghNotFound("HTTP 404: Not Found (https://api.github.com/repos/a/b)")).toBe(true);
    expect(ghNotFound("error connecting to api.github.com\ncheck your internet connection")).toBe(false);
    expect(ghNotFound("Could not resolve host: api.github.com")).toBe(false);
    expect(ghNotFound("HTTP 502: Bad Gateway")).toBe(false);
    expect(ghNotFound("")).toBe(false);
  });

  it("only a PR GitHub cannot resolve in a visible repo is a strong not-found (a hidden private repo looks like a missing one)", () => {
    expect(ghPrNotFound("GraphQL: Could not resolve to a PullRequest with the number of 99999. (repository.pullRequest)")).toBe(true);
    expect(ghPrNotFound("GraphQL: Could not resolve to a Repository with the name 'o/private'. (repository)")).toBe(false);
    expect(ghPrNotFound("HTTP 404: Not Found (https://api.github.com/repos/a/b)")).toBe(false);
    expect(ghPrNotFound("error connecting to api.github.com")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("prRead and repoCurrentSlug (BTL-261)", () => {
  it("prRead returns not_found when GitHub cannot resolve the PR, null on other failures; prStatus turns both into null", async () => {
    const dir = fakeGh(`echo "GraphQL: Could not resolve to a PullRequest with the number of 1. (repository.pullRequest)" >&2\nexit 1`);
    expect(await prRead(dir, "https://github.com/o/a/pull/1", 5000)).toBe("not_found");
    expect(await prStatus(dir, "https://github.com/o/a/pull/1", 5000)).toBeNull();
    // 仓库解析不到：可能只是当前账号看不到这个私有仓库，按 gh 失败处理。
    fakeGh(`echo "GraphQL: Could not resolve to a Repository with the name 'o/gone'. (repository)" >&2\nexit 1`);
    expect(await prRead(dir, "https://github.com/o/gone/pull/1", 5000)).toBeNull();
    fakeGh(`echo "error connecting to api.github.com" >&2\nexit 1`);
    expect(await prRead(dir, "https://github.com/o/a/pull/1", 5000)).toBeNull();
  });

  it("repoCurrentSlug gives GitHub's current name (lower case), keeps the host of non-github slugs, and not_found for a missing repo", async () => {
    const dir = fakeGh(`echo "$@ GH_HOST=$GH_HOST" > "$(dirname "$0")/args.txt"\necho '{"nameWithOwner":"Yul761/Shipherd"}'`);
    expect(await repoCurrentSlug(dir, "yul761/butler", 5000)).toBe("yul761/shipherd");
    // 主机跟着 slug 走，不看环境里的 GH_HOST。
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe("repo view yul761/butler --json nameWithOwner GH_HOST=github.com");
    expect(await repoCurrentSlug(dir, "ghe.acme.io/team/old", 5000)).toBe("ghe.acme.io/yul761/shipherd");
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe("repo view ghe.acme.io/team/old --json nameWithOwner GH_HOST=ghe.acme.io");
    fakeGh(`echo "GraphQL: Could not resolve to a Repository with the name 'x/y'. (repository)" >&2\nexit 1`);
    expect(await repoCurrentSlug(dir, "x/y", 5000)).toBe("not_found");
    fakeGh(`echo '{"nameWithOwner":""}'`);
    expect(await repoCurrentSlug(dir, "x/y", 5000)).toBeNull();
  });
});

describe("aiReviewerOf (BTL-273)", () => {
  it("tells Codex from Copilot among the logins reviewerKind calls copilot, and nothing else", () => {
    expect(aiReviewerOf("chatgpt-codex-connector")).toBe("codex");
    expect(aiReviewerOf("chatgpt-codex-connector[bot]")).toBe("codex");
    expect(aiReviewerOf("copilot-pull-request-reviewer")).toBe("copilot");
    expect(aiReviewerOf("Copilot")).toBe("copilot");
    expect(aiReviewerOf("dependabot[bot]")).toBeNull();
    expect(aiReviewerOf("alice")).toBeNull();
  });
});
