import { describe, expect, it, vi } from "vitest";
import type { ClaudeResult, HeadlessOutcome } from "../claude/headless";
import { SessionsRepo } from "../db/sessions-repo";
import { memDb } from "../test-utils";
import { execHeadlessJson, jobOf, type HeadlessExecDeps } from "./headless-exec";

const USAGE = { input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4, output: 5 };
const result = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({
  sessionId: "s1", isError: false, subtype: "success", resultText: "{}", structured: {}, permissionDenials: [], apiErrorStatus: null, costUsd: 0,
  usage: USAGE, model: "claude-sonnet-5-5", ...over,
});

function setup(out: HeadlessOutcome) {
  const onUsage = vi.fn();
  const d: HeadlessExecDeps = {
    run: async () => out,
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/p" }),
    baseEnv: {},
    sessions: new SessionsRepo(memDb()),
    now: () => 99,
    newRunId: () => "run-7",
    onUsage,
  };
  return { d, onUsage };
}
const o = { label: "handoff BTL-1", args: [], prompt: "p", cwd: "/r" };

describe("execHeadlessJson usage", () => {
  it("reports usage of a successful run", async () => {
    const { d, onUsage } = setup({ ok: true, result: result() });
    await execHeadlessJson(d, o);
    expect(onUsage).toHaveBeenCalledWith({ runId: "run-7", label: "handoff BTL-1", at: 99, model: "claude-sonnet-5-5", usage: USAGE });
  });

  it("records usage of a failed run", async () => {
    const { d, onUsage } = setup({ ok: false, reason: "claude_error", message: "x", result: result({ isError: true }) });
    const r = await execHeadlessJson(d, o);
    expect(r.ok).toBe(false);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("does not call onUsage when the result has no usage", async () => {
    const a = setup({ ok: true, result: result({ usage: null }) });
    await execHeadlessJson(a.d, o);
    const b = setup({ ok: false, reason: "timeout", message: "x", result: null });
    await execHeadlessJson(b.d, o);
    expect(a.onUsage).not.toHaveBeenCalled();
    expect(b.onUsage).not.toHaveBeenCalled();
  });
});

describe("jobOf", () => {
  it("strips a trailing ticket key or number", () => {
    expect(jobOf("handoff BTL-1")).toBe("handoff");
    expect(jobOf("feature summary 3")).toBe("feature summary");
    expect(jobOf("stuck judge")).toBe("stuck judge");
  });
});
