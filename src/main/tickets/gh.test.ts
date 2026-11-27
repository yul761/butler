import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { applyGhResolution, ghAuthState, ghAvailable, probeGh, branchRuns, checksOf, ciOf, failedLog, failedLogDetail, ghBinary, ghErrorSummary, ghLogGone, compareFiles, mergedPrs, prInfo, reviewRequestedPrs, prLessonData, prLessonDataDetail, prRead, prStatus, prsForBranch, ghNotFound, ghPrNotFound, repoCurrentSlug, latestReviewers, reviewAuthors, reviewComments, reviewerKind, resetGhBinary, setGhBinary, resetGhEtags, ghApiGet, prBatch, prBatchable, PR_BATCH_CHUNK, prBatchQuery, prBatchResult, GH_NOT_FOUND } from "./gh";

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
    // 先按一页带 ETag 取（-i）；回的不是 HTTP 响应，退回 --paginate
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n")).toEqual([
      "api repos/{owner}/{repo}/pulls/5/reviews?per_page=100 -i",
      "api repos/{owner}/{repo}/pulls/5/reviews --paginate --jq .[] | {node_id, user: {login: .user.login, type: .user.type}}",
    ]);
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
      "api repos/{owner}/{repo}/pulls/5/comments?per_page=100 -i",
      "api repos/{owner}/{repo}/pulls/5/comments --paginate --jq .[]",
      "api repos/{owner}/{repo}/pulls/5/reviews?per_page=100 -i",
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

  it("reviewComments does not try the paginated read again after the first read timed out (BTL-276)", async () => {
    const dir = fakeGh(`echo "$@" >> "$(dirname "$0")/args.txt"\nsleep 5`);
    expect(await reviewComments(dir, 5, 300)).toBeNull();
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n")).toEqual(["api repos/{owner}/{repo}/pulls/5/comments?per_page=100 -i"]);
  });

  it("reviewComments keeps no ETag for a first page that is exactly full, so the 101st comment on page two is still read (BTL-276)", async () => {
    resetGhEtags();
    const c = (id: number) => ({ id, user: { login: "a" }, body: `b${id}`, created_at: "2026-01-02T00:00:00Z" });
    const page = Array.from({ length: 100 }, (_, i) => c(i + 1));
    // 第一页一直是前 100 条、ETag 不变；带着它来就 304。--paginate 给全部（count 文件里的条数）。
    const dir = fakeGh(`echo "$@" >> "$(dirname "$0")/args.txt"
case "$*" in
*'If-None-Match: "p1"'*) printf 'HTTP/2.0 304 Not Modified\nEtag: "p1"\n\n'; echo 'gh: HTTP 304' >&2; exit 1;;
*reviews*-i*) printf 'HTTP/2.0 200 OK\nEtag: "r"\n\n[]'; exit 0;;
*-i*) printf 'HTTP/2.0 200 OK\nEtag: "p1"\n\n'; cat "$(dirname "$0")/page.json"; exit 0;;
*comments*--paginate*) cat "$(dirname "$0")/all.jsonl"; exit 0;;
esac`);
    writeFileSync(join(dir, "page.json"), JSON.stringify(page));
    writeFileSync(join(dir, "all.jsonl"), page.map((x) => JSON.stringify(x)).join("\n"));
    expect(await reviewComments(dir, 5, 5000)).toHaveLength(100);
    writeFileSync(join(dir, "all.jsonl"), [...page, c(101)].map((x) => JSON.stringify(x)).join("\n"));
    expect((await reviewComments(dir, 5, 5000))?.map((x) => x.id).at(-1)).toBe("101");
    const calls = readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n").filter((l) => l.includes("/comments"));
    expect(calls.some((l) => l.includes("If-None-Match"))).toBe(false);
    expect(calls.filter((l) => l.includes("--paginate"))).toHaveLength(2);
  });

  it("ghApiGet answers a 304 from the cache with an empty stderr, so the 304 never shows up as a gh error (BTL-276)", async () => {
    resetGhEtags();
    const dir = fakeGh(`case "$*" in
*'If-None-Match: "e9"'*) printf 'HTTP/2.0 304 Not Modified\nEtag: "e9"\n\n'; echo 'gh: HTTP 304' >&2; exit 1;;
esac
printf 'HTTP/2.0 200 OK\nEtag: "e9"\n\n[1,2]'`);
    expect(await ghApiGet(dir, "repos/{owner}/{repo}/pulls/5/comments?per_page=100", 5000, 1 << 20, undefined, { perPage: 100 })).toEqual({ body: [1, 2], next: false, stderr: "" });
    expect(await ghApiGet(dir, "repos/{owner}/{repo}/pulls/5/comments?per_page=100", 5000, 1 << 20, undefined, { perPage: 100 })).toEqual({ body: [1, 2], next: false, stderr: "" });
  });

  it("reviewComments reads one object per line, even when a body has brackets, quotes and newlines, and returns null if any line is bad", async () => {
    const c = (id: number, body: string) => ({ id, user: { login: "a" }, body, created_at: "2026-01-02T00:00:00Z" });
    const dir = restGh(`${JSON.stringify(c(1, 'x ] [ "y"\nz'))}\n\n${JSON.stringify(c(2, "z"))}`, "");
    expect((await reviewComments(dir, 5, 5000))?.map((x) => [x.id, x.body])).toEqual([["1", 'x ] [ "y"\nz'], ["2", "z"]]);
    restGh(`${JSON.stringify(c(1, "a"))}\n{broken`, "");
    expect(await reviewComments(dir, 5, 5000)).toBeNull();
  });

  it("branchRuns keeps only the newest head sha, and sends the last ETag so an unchanged list costs nothing, even when the branch has more runs (BTL-276)", async () => {
    resetGhEtags();
    const runs = { workflow_runs: [
      { id: 3, head_sha: "new", status: "in_progress", conclusion: null, name: "CI" },
      { id: 2, head_sha: "new", status: "completed", conclusion: "failure", name: "Release" },
      { id: 1, head_sha: "old", status: "completed", conclusion: "success", name: "CI" },
    ] };
    // 带着上次的 ETag 来：304（gh 退出 1，头照打）；否则 200 和列表
    const dir = fakeGh(`echo "$@" >> "$(dirname "$0")/args.txt"
case "$*" in
*'If-None-Match: "e1"'*) printf 'HTTP/2.0 304 Not Modified\nEtag: "e1"\n\n'; echo 'gh: HTTP 304' >&2; exit 1;;
esac
printf 'HTTP/2.0 200 OK\r\nEtag: "e1"\r\nLink: <https://api.github.com/x?page=2>; rel="next"\r\n\r\n'
cat <<'JSON'
${JSON.stringify(runs)}
JSON`);
    const want = { headSha: "new", checks: [{ name: "CI", state: "pending", runId: 3 }, { name: "Release", state: "failing", runId: 2 }], ci: "failing" };
    expect(await branchRuns(dir, "feat/x", 5000)).toEqual(want);
    expect(await branchRuns(dir, "feat/x", 5000)).toEqual(want);
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n")).toEqual([
      "api repos/{owner}/{repo}/actions/runs?branch=feat%2Fx&per_page=20 -i",
      'api repos/{owner}/{repo}/actions/runs?branch=feat%2Fx&per_page=20 -i -H If-None-Match: "e1"',
    ]);
    resetGhEtags();
    fakeGh(`printf 'HTTP/2.0 200 OK\n\n{"workflow_runs":[]}'`);
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
    expect(readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n")).toEqual(["pr", "pr", "api", "run"]);
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

describe("prBatch: one GraphQL call for all due PRs of a repo (BTL-276)", () => {
  /** runs：每个检查 [check run id, status, conclusion]。 */
  const tip = (state: string | null, runs: [number, string, string | null][] = []) => ({
    nodes: [{ commit: { statusCheckRollup: state === null ? null : { state, contexts: {
      totalCount: runs.length + 1,
      nodes: [...runs.map(([databaseId, status, conclusion]) => ({ __typename: "CheckRun", databaseId, status, conclusion })), { __typename: "StatusContext", context: "ci/ext", state: "SUCCESS" }],
    } } } }],
  });
  const cheap = (n: number, o: Record<string, unknown> = {}) => ({
    number: n, url: `https://github.com/o/app/pull/${n}`, state: "OPEN", updatedAt: "2026-11-20T00:00:00Z", lastEditedAt: null, headRefOid: "a1",
    headRefName: "feat", baseRefName: "main", title: "T", isDraft: false,
    reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", comments: { totalCount: 1 }, reviews: { totalCount: 1 },
    labelCount: { totalCount: 1 },
    requested: { totalCount: 2, nodes: [{ requestedReviewer: { __typename: "User", login: "bob" } }, { requestedReviewer: { __typename: "Team", slug: "core" } }] },
    recentComments: { nodes: [{ id: "C1", lastEditedAt: null }] },
    recentReviews: { nodes: [{ id: "R1", state: "APPROVED", lastEditedAt: null }] },
    tip: tip("PENDING", [[101, "IN_PROGRESS", null]]), ...o,
  });
  const full = (n: number, o: Record<string, unknown> = {}) => ({
    ...cheap(n), createdAt: "2026-11-19T00:00:00Z", mergedAt: null, closedAt: null, body: "B", author: { login: "me" },
    labels: { totalCount: 1, nodes: [{ name: "ui" }] },
    reviewRequests: { totalCount: 2, nodes: [{ requestedReviewer: { __typename: "User", login: "bob" } }, { requestedReviewer: { __typename: "Team", slug: "core", name: "Core" } }] },
    allReviews: { totalCount: 1, nodes: [{ id: "R1", author: { login: "alice" }, state: "APPROVED", body: "", submittedAt: "2026-11-19T01:00:00Z" }] },
    allComments: { totalCount: 1, nodes: [{ id: "C1", author: { login: "carol" }, body: "hi", createdAt: "2026-11-19T02:00:00Z", url: "https://x/c1" }] },
    commits: { nodes: [{ commit: { authoredDate: "2026-11-18T00:00:00Z" } }, { commit: { authoredDate: "2026-11-18T05:00:00Z" } }] },
    head: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/app/actions/runs/9/job/1" },
      { __typename: "StatusContext", context: "ci/ext", state: "SUCCESS", targetUrl: "https://ext" },
    ] } } } }] },
    ...o,
  });
  const reply = (repository: Record<string, unknown> | null, errors?: unknown[]) =>
    JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-11-20T01:00:00Z" }, repository }, ...(errors && { errors }) });

  it("asks for every PR under its own alias, with only the cheap fields unless reading in full", () => {
    const q = prBatchQuery([7, 12], "cheap");
    expect(q).toContain("p7: pullRequest(number: 7)");
    expect(q).toContain("p12: pullRequest(number: 12)");
    expect(q).toContain("rateLimit");
    expect(q).not.toContain("reviews(first");
    for (const f of ["baseRefName", "headRefName", "title", "lastEditedAt", "labelCount: labels", "requested: reviewRequests(first: 20)", "recentComments: comments(last: 20)", "recentReviews: reviews(last: 20)"]) expect(q).toContain(f);
    expect(() => prBatchQuery([2 ** 31], "cheap")).toThrow();
    expect(q).not.toMatch(/\bmutation\b/);
    expect(prBatchQuery([7], "full")).toContain("reviews(first: 100)");
  });

  it("reads a full PR into the same shape as gh pr view, and gives the same fingerprint as the cheap read", () => {
    const c = prBatchResult(reply({ p7: cheap(7) }), [7], "cheap")!;
    const f = prBatchResult(reply({ p7: full(7) }), [7], "full")!;
    const ci = c.prs.get(7) as { sig: string; pr: null };
    const fi = f.prs.get(7) as { sig: string; pr: ReturnType<typeof Object> };
    expect(ci.pr).toBeNull();
    expect(fi.sig).toBe(ci.sig);
    expect(f.rate).toEqual({ cost: 1, remaining: 4999, resetAt: Date.parse("2026-11-20T01:00:00Z") });
    expect(fi.pr).toMatchObject({
      number: 7, state: "OPEN", review: "pending", headSha: "a1", headBranch: "feat", author: "me", baseBranch: "main", title: "T", body: "B", labels: ["ui"],
      reviewRequests: [{ kind: "user", name: "bob" }, { kind: "team", name: "core" }], mergeable: "mergeable", mergeState: "blocked",
      reviews: [{ id: "R1", author: "alice", state: "APPROVED" }], comments: [{ id: "C1", author: "carol", body: "hi", url: "https://x/c1" }],
      firstCommitAt: Date.parse("2026-11-18T00:00:00Z"), ci: "failing",
      checks: [{ name: "test", state: "failing", runId: 9 }, { name: "ci/ext", state: "passing", runId: null }],
    });
  });

  it("changes the fingerprint when the head, the update time, the comment or review count, or any check changes (also when updatedAt stays)", () => {
    const sig = (o: Record<string, unknown>) => (prBatchResult(reply({ p7: cheap(7, o) }), [7], "cheap")!.prs.get(7) as { sig: string }).sig;
    const base = sig({});
    expect(sig({ headRefOid: "b2" })).not.toBe(base);
    expect(sig({ updatedAt: "2026-11-21T00:00:00Z" })).not.toBe(base);
    expect(sig({ comments: { totalCount: 2 } })).not.toBe(base);
    expect(sig({ reviews: { totalCount: 2 } })).not.toBe(base);
    expect(sig({ tip: tip("FAILURE", [[101, "COMPLETED", "FAILURE"]]) })).not.toBe(base);
    expect(sig({ tip: tip("PENDING", [[101, "IN_PROGRESS", null], [102, "COMPLETED", "SUCCESS"]]) })).not.toBe(base);
    expect(sig({ tip: tip(null) })).not.toBe(base);
    // 重跑一遍、结果一样：新的 check run id。
    const failed = sig({ tip: tip("FAILURE", [[101, "COMPLETED", "FAILURE"]]) });
    expect(sig({ tip: tip("FAILURE", [[201, "COMPLETED", "FAILURE"]]) })).not.toBe(failed);
    // 两个检查互换结果：失败的个数一样，指纹也不一样。
    expect(sig({ tip: tip("FAILURE", [[101, "COMPLETED", "FAILURE"], [102, "COMPLETED", "SUCCESS"]]) }))
      .not.toBe(sig({ tip: tip("FAILURE", [[101, "COMPLETED", "SUCCESS"], [102, "COMPLETED", "FAILURE"]]) }));
    // 栈依赖 base、轮到谁看 review 请求：这些变了 updatedAt 不一定变。改名后链接变了，要全读一次才知道仓库搬了。
    expect(sig({ baseRefName: "feature/x" })).not.toBe(base);
    expect(sig({ headRefName: "feat2" })).not.toBe(base);
    expect(sig({ title: "T2" })).not.toBe(base);
    expect(sig({ url: "https://github.com/o/app2/pull/7" })).not.toBe(base);
    expect(sig({ lastEditedAt: "2026-11-20T01:00:00Z" })).not.toBe(base);
    expect(sig({ labelCount: { totalCount: 2 } })).not.toBe(base);
    expect(sig({ requested: { totalCount: 2, nodes: [{ requestedReviewer: { __typename: "User", login: "carol" } }, { requestedReviewer: { __typename: "Team", slug: "core" } }] } })).not.toBe(base);
    expect(sig({ recentComments: { nodes: [{ id: "C1", lastEditedAt: "2026-11-20T02:00:00Z" }] } })).not.toBe(base);
    expect(sig({ recentReviews: { nodes: [{ id: "R1", state: "APPROVED", lastEditedAt: "2026-11-20T02:00:00Z" }] } })).not.toBe(base);
    // 检查的顺序不算。
    expect(sig({ tip: tip("FAILURE", [[101, "COMPLETED", "FAILURE"], [102, "COMPLETED", "SUCCESS"]]) }))
      .toBe(sig({ tip: tip("FAILURE", [[102, "COMPLETED", "SUCCESS"], [101, "COMPLETED", "FAILURE"]]) }));
  });

  it("marks a PR GitHub says does not exist as not found, and leaves other per-PR errors and truncated lists for gh pr view", () => {
    const r = prBatchResult(reply({ p7: full(7), p8: null, p9: null, p10: full(10, { allReviews: { totalCount: 150, nodes: [] } }) }, [
      { type: "NOT_FOUND", path: ["repository", "p8"], message: "Could not resolve to a PullRequest with the number of 8." },
      { type: "FORBIDDEN", path: ["repository", "p9"], message: "Resource not accessible" },
    ]), [7, 8, 9, 10, 11], "full")!;
    expect((r.prs.get(7) as { pr: unknown }).pr).not.toBeNull();
    expect(r.prs.get(8)).toBe(GH_NOT_FOUND);
    expect(r.prs.get(9)).toBeNull();
    expect((r.prs.get(10) as { pr: unknown }).pr).toBeNull();
    expect(r.prs.get(11)).toBeNull();
  });

  it("fails as a whole when the repository itself cannot be read or the output is not the expected JSON", () => {
    expect(prBatchResult(reply(null, [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository with the name 'o/app'." }]), [7], "cheap")).toBeNull();
    expect(prBatchResult(reply({ p7: cheap(7) }, [{ message: "Something went wrong" }]), [7], "cheap")).toBeNull();
    expect(prBatchResult("not json", [7], "cheap")).toBeNull();
    expect(prBatchResult(null, [7], "cheap")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("runs gh api graphql against the PR's host and reads the JSON even when gh exits 1 for a missing PR", async () => {
    const out = reply({ p7: cheap(7), p8: null }, [{ type: "NOT_FOUND", path: ["repository", "p8"], message: "Could not resolve to a PullRequest with the number of 8." }]);
    const dir = fakeGh(`echo "$1 $2 $GH_HOST $GH_REPO" > "$(dirname "$0")/args.txt"\nfor a in "$@"; do case "$a" in owner=*|name=*) echo "$a" >> "$(dirname "$0")/args.txt";; esac; done\ncat <<'JSON'\n${out}\nJSON\nexit 1`);
    const r = await prBatch(dir, "ghe.example.com/o/app", [7, 8], "cheap", 5000);
    expect(r?.prs.get(8)).toBe(GH_NOT_FOUND);
    expect(r?.prs.get(7)).toMatchObject({ pr: null });
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n")).toEqual(["api graphql ghe.example.com ghe.example.com/o/app", "owner=o", "name=app"]);
  });

  it.skipIf(process.platform === "win32")("splits a long list into calls of PR_BATCH_CHUNK, leaves out numbers GraphQL cannot take, and keeps the chunks that worked when one fails", async () => {
    // 每次调用：查询里的别名数记一行；第二块失败。
    const dir = fakeGh(`q=""; for a in "$@"; do case "$a" in query=*) q="$a";; esac; done
n=$(printf '%s' "$q" | grep -o 'pullRequest(number' | wc -l | tr -d ' ')
echo "$n" >> "$(dirname "$0")/calls.txt"
c=$(wc -l < "$(dirname "$0")/calls.txt" | tr -d ' ')
[ "$c" = 2 ] && exit 1
printf '%s' "$q" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r={};for(const m of s.matchAll(/p(\\d+): pullRequest/g))r["p"+m[1]]=${JSON.stringify(cheap(0))};console.log(JSON.stringify({data:{rateLimit:{cost:1,remaining:4000,resetAt:null},repository:r}}))})'`);
    const numbers = [...Array.from({ length: PR_BATCH_CHUNK * 2 + 5 }, (_, i) => i + 1), 0, 2 ** 31, 1.5];
    const r = await prBatch(dir, "o/app", numbers, "cheap", 10_000);
    expect(readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n")).toEqual([String(PR_BATCH_CHUNK), String(PR_BATCH_CHUNK), "5"]);
    expect(r?.prs.has(1)).toBe(true);
    expect(r?.prs.has(PR_BATCH_CHUNK + 1)).toBe(false);
    expect(r?.prs.has(PR_BATCH_CHUNK * 2 + 1)).toBe(true);
    for (const bad of [0, 2 ** 31, 1.5]) expect(r?.prs.has(bad)).toBe(false);
    expect(r?.rate).toMatchObject({ remaining: 4000 });
    expect([0, -1, 1.5, 2 ** 31, Number.NaN].some(prBatchable)).toBe(false);
    expect(prBatchable(2 ** 31 - 1)).toBe(true);
  });
});
