import { describe, expect, it, vi } from "vitest";
import type { ClaudeResult, HeadlessOutcome } from "../claude/headless";
import { SessionsRepo } from "../db/sessions-repo";
import { memDb } from "../test-utils";
import { execHeadlessJson, jobOf, type HeadlessExecDeps } from "./headless-exec";

const USAGE = { input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4, output: 5 };
const result = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({
  sessionId: "s1", isError: false, subtype: "success", resultText: "{}", structured: {}, permissionDenials: [], apiErrorStatus: null, costUsd: 0,
  usage: USAGE, model: "claude-sonnet-5-5", durationMs: 1200, ...over,
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
    const { d, onUsage } = setup({ ok: false, reason: "claude_error", message: "x", result: result({ isError: true }), limit: null, stderr: "" });
    const r = await execHeadlessJson(d, o);
    expect(r.ok).toBe(false);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("does not call onUsage when the result has no usage", async () => {
    const a = setup({ ok: true, result: result({ usage: null }) });
    await execHeadlessJson(a.d, o);
    const b = setup({ ok: false, reason: "timeout", message: "x", result: null, limit: null, stderr: "" });
    await execHeadlessJson(b.d, o);
    expect(a.onUsage).not.toHaveBeenCalled();
    expect(b.onUsage).not.toHaveBeenCalled();
  });
});

describe("execHeadlessJson hooks and failure detail", () => {
  const hit = { kind: "usage_limit" as const, resetsAt: 5, message: "limit" };
  const limited = { ok: false as const, reason: "rate_limited" as const, message: "m", result: result({ isError: true, resultText: "raw" }), limit: hit, stderr: "err" };

  it("calls onLimit with the job and the hit", async () => {
    const { d } = setup(limited);
    const onLimit = vi.fn();
    await execHeadlessJson({ ...d, onLimit }, o);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(onLimit).toHaveBeenCalledWith(hit, "handoff");
  });

  it("calls onSuccess once on success", async () => {
    const { d } = setup({ ok: true, result: result() });
    const onSuccess = vi.fn();
    const onLimit = vi.fn();
    const r = await execHeadlessJson({ ...d, onSuccess, onLimit }, o);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(99, "handoff");
    expect(onLimit).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, result: { sessionId: "s1" } });
  });

  it("onSuccess gets the time the run started, not when it ended", async () => {
    const { d } = setup({ ok: true, result: result() });
    let t = 10;
    const onSuccess = vi.fn();
    await execHeadlessJson({ ...d, now: () => t, run: async () => { t = 500; return { ok: true, result: result() }; }, onSuccess }, o);
    expect(onSuccess).toHaveBeenCalledWith(10, "handoff");
  });

  it("a throwing onLimit does not change the result", async () => {
    const { d } = setup(limited);
    const log = vi.fn();
    const r = await execHeadlessJson({ ...d, log, onLimit: () => { throw new Error("x"); } }, o);
    expect(r).toMatchObject({ ok: false, reason: "rate_limited", limit: hit });
    expect(log.mock.calls.some((c) => String(c[0]).includes("onLimit threw"))).toBe(true);
    const s = setup({ ok: true, result: result() });
    const log2 = vi.fn();
    expect(await execHeadlessJson({ ...s.d, log: log2, onSuccess: () => { throw new Error("y"); } }, o)).toMatchObject({ ok: true });
    expect(log2.mock.calls.some((c) => String(c[0]).includes("onSuccess threw"))).toBe(true);
  });

  it("failure carries stderr, result and rawText", async () => {
    const { d } = setup(limited);
    const r = await execHeadlessJson(d, o);
    expect(r).toMatchObject({ ok: false, stderr: "err", rawText: "raw", result: { sessionId: "s1" } });
    const t = await execHeadlessJson(setup({ ok: false, reason: "timeout", message: "x", result: null, limit: null, stderr: "" }).d, o);
    expect(t).toMatchObject({ ok: false, rawText: null, result: null, limit: null });
  });
});

describe("jobOf", () => {
  it("strips a trailing ticket key or number", () => {
    expect(jobOf("handoff BTL-1")).toBe("handoff");
    expect(jobOf("feature summary 3")).toBe("feature summary");
    expect(jobOf("stuck judge")).toBe("stuck judge");
  });
});
