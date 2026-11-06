import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { branchRuns, checksOf, ciOf, failedLog, prInfo, prStatus } from "./gh";

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
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
    });
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe("pr view feat --json number,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup");
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
});
