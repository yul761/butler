import { describe, expect, it } from "vitest";
import { APPEAR_TIMEOUT_MS, ciVerdict, MAX_WAIT_MS, NOT_ON_MAIN_GRACE_MS, type WorkflowRun } from "../../scripts/wait-for-ci.mjs";

// BTL-262：发版要等 tag 指向的 commit 在 main 上的 CI 全绿（scripts/wait-for-ci.mjs，release.yml 的 ci-gate job）。
const SHA = "a".repeat(40);
let n = 0;
const run = (o: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: ++n, run_number: n, head_sha: SHA, head_branch: "main", event: "push", status: "completed", conclusion: "success",
  html_url: `https://github.com/o/r/actions/runs/${n}`, created_at: "2026-11-23T00:00:00Z", ...o,
});

describe("ciVerdict", () => {
  it("passes when the main push run for the commit succeeded", () => {
    expect(ciVerdict({ sha: SHA, runs: [run()], waitedMs: 0 }).state).toBe("pass");
  });

  it("fails when it finished any other way (failure, cancelled, timed out)", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", null]) {
      const v = ciVerdict({ sha: SHA, runs: [run({ conclusion })], waitedMs: 0 });
      expect(v.state, String(conclusion)).toBe("fail");
      expect(v.message).toContain("no release is drafted");
    }
  });

  it("waits while CI is still running, the way the release flow starts both at once (4.1.2: run 45062021490 was red)", () => {
    for (const status of ["queued", "in_progress", "waiting", "pending"]) {
      expect(ciVerdict({ sha: SHA, runs: [run({ status, conclusion: null })], waitedMs: 60_000 }).state, status).toBe("wait");
    }
    expect(ciVerdict({ sha: SHA, runs: [run({ status: "in_progress", conclusion: null })], waitedMs: MAX_WAIT_MS }).state).toBe("fail");
  });

  it("waits for the run to appear for a while, then fails with what to do", () => {
    expect(ciVerdict({ sha: SHA, runs: [], waitedMs: 0 }).state).toBe("wait");
    const v = ciVerdict({ sha: SHA, runs: [], waitedMs: APPEAR_TIMEOUT_MS });
    expect(v.state).toBe("fail");
    expect(v.message).toContain("Push the version commit to main");
    expect(v.message).toContain("skip_ci_check");
  });

  it("fails fast, with what to do, when the tagged commit is not on main (a tag on a release branch)", () => {
    expect(ciVerdict({ sha: SHA, runs: [], waitedMs: 0, onMain: false }).state).toBe("wait");
    const v = ciVerdict({ sha: SHA, runs: [run({ head_branch: "release/4.2" })], waitedMs: NOT_ON_MAIN_GRACE_MS, onMain: false });
    expect(v.state).toBe("fail");
    expect(v.message).toContain("is not on main");
    expect(v.message).toContain("skip_ci_check");
    expect(NOT_ON_MAIN_GRACE_MS).toBeLessThan(APPEAR_TIMEOUT_MS);
    // On main (or unknown, when the compare call failed): keep waiting for the run as before.
    for (const onMain of [true, null]) expect(ciVerdict({ sha: SHA, runs: [], waitedMs: NOT_ON_MAIN_GRACE_MS, onMain }).state).toBe("wait");
    // A main push run settles it whatever the compare said.
    expect(ciVerdict({ sha: SHA, runs: [run()], waitedMs: NOT_ON_MAIN_GRACE_MS, onMain: false }).state).toBe("pass");
  });

  it("only counts push runs on main for exactly this commit", () => {
    const others = [run({ head_sha: "b".repeat(40) }), run({ event: "pull_request" }), run({ head_branch: "feature/x" }), run({ head_branch: null })];
    expect(ciVerdict({ sha: SHA, runs: others, waitedMs: 0 }).state).toBe("wait");
    expect(ciVerdict({ sha: SHA, runs: [...others, run({ conclusion: "failure" })], waitedMs: 0 }).state).toBe("fail");
  });

  it("looks at the newest run when there are several", () => {
    const old = run({ conclusion: "failure" });
    const latest = run();
    expect(ciVerdict({ sha: SHA, runs: [latest, old], waitedMs: 0 }).state).toBe("pass");
    expect(ciVerdict({ sha: SHA, runs: [old, run({ status: "in_progress", conclusion: null })], waitedMs: 0 }).state).toBe("wait");
  });
});
