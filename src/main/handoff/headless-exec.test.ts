import { describe, expect, it, vi } from "vitest";
import type { ClaudeResult, HeadlessOutcome } from "../claude/headless";
import { SessionsRepo } from "../db/sessions-repo";
import { memDb } from "../test-utils";
import type { RegistryModel, Tier } from "../../shared/model-routing";
import { migrate } from "../db/database";
import { RoutingRepo } from "../db/routing-repo";
import { UsageRepo } from "../db/usage-repo";
import { RoutingService } from "../routing/routing-service";
import { execHeadlessJson, jobOf, withModel, type HeadlessExecDeps } from "./headless-exec";
import { DEV_BASE_MODEL_USAGE, F1, FORK_OPUS, T1, T3 } from "../../shared/__fixtures__/cli-cost";
import { cumulativeWeight } from "../../shared/run-cost";
import type { CostBase } from "../fork/cost-base";
import { parseClaudeJson } from "../claude/headless";

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
const o = { task: "handoff" as const, label: "handoff BTL-1", args: [], prompt: "p", cwd: "/r" };

describe("execHeadlessJson usage", () => {
  it("reports usage of a successful run", async () => {
    const { d, onUsage } = setup({ ok: true, result: result() });
    await execHeadlessJson(d, o);
    expect(onUsage).toHaveBeenCalledWith({ runId: "run-7", label: "handoff BTL-1", at: 99, model: "claude-sonnet-5-5", usage: USAGE });
  });

  it("carries the ticket the call was made for", async () => {
    const { d, onUsage } = setup({ ok: true, result: result() });
    await execHeadlessJson(d, { ...o, ticketKey: "BTL-1" });
    expect(onUsage.mock.calls[0]![0]).toMatchObject({ ticketKey: "BTL-1" });
  });
});

describe("execHeadlessJson cost gate (workstream L)", () => {
  it("does not run when the breaker paused the ticket's background work", async () => {
    const { d } = setup({ ok: true, result: result() });
    const run = vi.fn(d.run);
    const gate = vi.fn(() => "pause" as const);
    const r = await execHeadlessJson({ ...d, run, costGate: gate }, { ...o, ticketKey: "BTL-1" });
    expect(gate).toHaveBeenCalledWith({ task: "handoff", ticketKey: "BTL-1", label: "handoff BTL-1" });
    expect(r).toMatchObject({ ok: false, reason: "cost_paused" });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs normally when the gate says ok or throws", async () => {
    const { d } = setup({ ok: true, result: result() });
    expect((await execHeadlessJson({ ...d, costGate: () => "ok" }, o)).ok).toBe(true);
    expect((await execHeadlessJson({ ...d, costGate: () => { throw new Error("x"); } }, o)).ok).toBe(true);
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

describe("execHeadlessJson routing", () => {
  const reg = (name: string, tier: Tier): RegistryModel => ({ name, tier, enabled: true, account: "default", priceIn: null, priceOut: null, note: "" });
  const limited = (model: string): HeadlessOutcome => ({
    ok: false, reason: "rate_limited", message: `429 for ${model}`, stderr: "",
    result: result({ isError: true, model }), limit: { kind: "rate_limit", resetsAt: null, message: "429" },
  });

  function routed(models: RegistryModel[], runs: (model: string | null) => HeadlessOutcome) {
    const db = memDb();
    migrate(db);
    const repo = new RoutingRepo(db);
    for (const m of models) repo.upsertModel(m);
    const usage = new UsageRepo(db);
    const routing = new RoutingService({
      repo, usage, now: () => 1000, probe: async () => ({ ok: true }),
      settings: () => ({ quotas: "", thresholds: "70,90", periodStartDay: 1, effort: "", maxConcurrent: "", autoSwitch: false }),
      flags: () => ({ model: true, effort: true }), setTimer: () => 0, clearTimer: () => undefined,
    });
    const argv: string[][] = [];
    const reports: unknown[] = [];
    const d: HeadlessExecDeps = {
      run: async (spec) => {
        argv.push(spec.args);
        const i = spec.args.indexOf("--model");
        return runs(i >= 0 ? spec.args[i + 1]! : null);
      },
      ready: async () => undefined,
      claude: () => ({ path: "/bin/claude", pathValue: "/p" }),
      baseEnv: {}, sessions: new SessionsRepo(db), now: () => 1000, newRunId: () => "r",
      onUsage: (u) => reports.push(u), routing,
    };
    return { d, routing, repo, argv, reports };
  }
  const lo = { task: "lesson_analyze" as const, label: "lessons", args: ["-p", "--output-format", "json"], prompt: "p", cwd: "/r" };

  it("a model marked limited is skipped and the record shows fallback_from (acceptance 1)", async () => {
    const { d, routing, argv, reports } = routed([reg("M1", "mid"), reg("M2", "mid")], () => ({ ok: true, result: result() }));
    routing.onLimit("M1", { kind: "rate_limit", resetsAt: null, message: "simulated" }, { task: null, accountLevel: false });
    const r = await execHeadlessJson(d, lo);
    expect(r).toMatchObject({ ok: true, route: { actualModel: "M2", fallbackFrom: "M1", requestedTier: "mid", degraded: false } });
    expect(argv).toEqual([["-p", "--model", "M2", "--output-format", "json"]]);
    expect(reports[0]).toMatchObject({ task: "lesson_analyze", requestedTier: "mid", fallbackFrom: "M1" });
  });

  it("a downgrade verdict from the cost gate plans one tier lower (workstream L)", async () => {
    const { d, argv } = routed([reg("M1", "mid"), reg("L1", "low")], () => ({ ok: true, result: result() }));
    const r = await execHeadlessJson({ ...d, costGate: () => "downgrade" }, { ...lo, ticketKey: "T-1" });
    expect(argv.map((a) => a[a.indexOf("--model") + 1])).toEqual(["L1"]);
    expect(r).toMatchObject({ ok: true, route: { actualModel: "L1", degraded: true } });
  });

  it("a downgrade verdict with nowhere lower to go keeps the requested tier", async () => {
    const { d, argv } = routed([reg("L1", "low")], () => ({ ok: true, result: result() }));
    const r = await execHeadlessJson({ ...d, costGate: () => "downgrade" }, { ...lo, task: "needs_you", ticketKey: "T-1" });
    expect(argv.map((a) => a[a.indexOf("--model") + 1])).toEqual(["L1"]);
    expect(r.ok).toBe(true);
  });

  it("starting below the requested tier because that tier has no models is not degraded", async () => {
    const { d } = routed([reg("H1", "high"), reg("L1", "low")], () => ({ ok: true, result: result() }));
    const r = await execHeadlessJson(d, lo);
    expect(r).toMatchObject({ ok: true, route: { actualModel: "L1", requestedTier: "mid", fallbackFrom: null, degraded: false } });
  });

  it("a limit hit mid-run falls back to the next model, down a tier for fallback tasks", async () => {
    const { d, routing, argv } = routed([reg("M1", "mid"), reg("L1", "low")], (m) => (m === "M1" ? limited("M1") : { ok: true, result: result() }));
    const r = await execHeadlessJson(d, lo);
    expect(argv.map((a) => a[a.indexOf("--model") + 1])).toEqual(["M1", "L1"]);
    expect(r).toMatchObject({ ok: true, route: { actualModel: "L1", fallbackFrom: "M1", degraded: true } });
    expect(routing.health.usable("M1")).toBe(false);
    expect(routing.view().events.map((e) => e.kind)).toContain("fallback");
  });

  it("a wait task never drops a tier: it reports when to retry instead", async () => {
    const { d, routing, argv } = routed([reg("H1", "high"), reg("M1", "mid")], () => ({ ok: true, result: result() }));
    routing.onLimit("H1", { kind: "rate_limit", resetsAt: 5_000_000, message: "x" }, { task: null, accountLevel: false });
    const r = await execHeadlessJson(d, { ...lo, task: "pre_review" });
    expect(argv).toEqual([]);
    expect(r).toMatchObject({ ok: false, reason: "rate_limited", waitUntil: routing.health.recoversAt("H1") });
  });

  it("the chain running out is a rate limit with a retry time, not a drop", async () => {
    const { d, argv } = routed([reg("M1", "mid"), reg("M2", "mid")], (m) => limited(m!));
    const r = await execHeadlessJson(d, lo);
    expect(argv).toHaveLength(2);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("rate_limited");
      expect(r.route).toMatchObject({ actualModel: "M2", fallbackFrom: "M1" });
      expect(r.waitUntil).not.toBeUndefined();
    }
  });

  it("non-limit failures are not retried", async () => {
    const { d, argv } = routed([reg("M1", "mid"), reg("M2", "mid")], () => ({ ok: false, reason: "timeout", message: "t", stderr: "", result: null, limit: null }));
    expect((await execHeadlessJson(d, lo)).ok).toBe(false);
    expect(argv).toHaveLength(1);
  });

  it("session tasks keep the session's model", async () => {
    const { d, argv } = routed([reg("M1", "mid")], () => ({ ok: true, result: result() }));
    await execHeadlessJson(d, { ...o, args: ["-p"], sessionModel: "opus" });
    expect(argv).toEqual([["-p", "--model", "opus"]]);
  });

  it("no routing configured: today's models, no extra flags, usage rows unchanged (acceptance 3)", async () => {
    const { d, argv, reports } = routed([], () => ({ ok: true, result: result() }));
    await execHeadlessJson(d, { ...lo, task: "needs_you" });
    await execHeadlessJson(d, { ...lo, task: "handoff_refresh" });
    await execHeadlessJson(d, lo);
    await execHeadlessJson(d, { ...o, args: ["-p"] });
    expect(argv).toEqual([
      ["-p", "--model", "haiku", "--output-format", "json"],
      ["-p", "--model", "sonnet", "--output-format", "json"],
      ["-p", "--output-format", "json"],
      ["-p"],
    ]);
    expect(reports[0]).toEqual({ runId: "r", label: "lessons", at: 1000, model: "claude-sonnet-5-5", usage: USAGE, task: "needs_you", costUsd: 0, requestedTier: null, fallbackFrom: null });
  });

  // BTL-239：--resume X --fork-session 时 CLI 的 total_cost_usd 带着 X 以前的全部花费，用量行要记的是这一轮自己的：
  // 跟分叉讨论一样取 T1 − X 存下的累计（base，起跑前读、跑完核对没变）；用不上就不记金额（用量页按价格表估），绝不记累计，也不把份额约数当准数记。
  describe("a forked run (handoff, feature summary)", () => {
    const args = ["-p", "--resume", "dev-1", "--fork-session", "--output-format", "json"];
    const devBase = { totalUsd: 4, weight: cumulativeWeight(DEV_BASE_MODEL_USAGE)! };
    const fork = parseClaudeJson(JSON.stringify(FORK_OPUS), args)!;
    const withBase = (bases: (CostBase | null)[]) => {
      const calls: string[] = [];
      const costBase = async (id: string) => {
        calls.push(id);
        return bases.length > 1 ? bases.shift()! : bases[0]!;
      };
      return { costBase, calls };
    };

    it("records T1 minus the dev session's saved total, read before the run and checked after", async () => {
      const { d, reports } = routed([], () => ({ ok: true, result: fork }));
      const b = withBase([devBase]);
      await execHeadlessJson({ ...d, costBase: b.costBase }, { ...o, args, resumedId: "dev-1" });
      expect((reports[0] as { costUsd: number }).costUsd).toBeCloseTo(0.3, 9);
      expect(b.calls).toEqual(["dev-1", "dev-1"]);
    });
    it("the real CLI's numbers: a fork taken after t3 records F1 − T3, never the cumulative", async () => {
      const f1 = parseClaudeJson(JSON.stringify(F1), args)!;
      const { d, reports } = routed([], () => ({ ok: true, result: f1 }));
      const b = withBase([{ totalUsd: T3.total_cost_usd, weight: cumulativeWeight(T3.modelUsage)! }]);
      await execHeadlessJson({ ...d, costBase: b.costBase }, { ...o, args, resumedId: "dev-1" });
      expect((reports[0] as { costUsd: number }).costUsd).toBeCloseTo(F1.total_cost_usd - T3.total_cost_usd, 12);
    });
    it("no saved total (no transcript, no cost-state line): no amount, not the share split", async () => {
      const { d, reports } = routed([], () => ({ ok: true, result: fork }));
      await execHeadlessJson({ ...d, costBase: withBase([null]).costBase }, { ...o, args, resumedId: "dev-1" });
      expect(reports[0]).toMatchObject({ costUsd: null });
    });
    it("the saved total changed during the run (the dev session exited): no amount", async () => {
      const { d, reports } = routed([], () => ({ ok: true, result: fork }));
      const b = withBase([devBase, { totalUsd: 4.2, weight: devBase.weight + 1 }]);
      await execHeadlessJson({ ...d, costBase: b.costBase }, { ...o, args, resumedId: "dev-1" });
      expect(reports[0]).toMatchObject({ costUsd: null });
    });
    it("reading the saved total throws: logged, no amount, the run itself is unaffected", async () => {
      const { d, reports } = routed([], () => ({ ok: true, result: fork }));
      const log = vi.fn();
      const r = await execHeadlessJson({ ...d, log, costBase: async () => { throw new Error("EACCES"); } }, { ...o, args, resumedId: "dev-1" });
      expect(r.ok).toBe(true);
      expect(reports[0]).toMatchObject({ costUsd: null });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("cost base"), expect.any(Error));
    });
    it("no costBase wired: no amount", async () => {
      const { d, reports } = routed([], () => ({ ok: true, result: fork }));
      await execHeadlessJson(d, { ...o, args, resumedId: "dev-1" });
      expect(reports[0]).toMatchObject({ costUsd: null });
    });
    it("no modelUsage to check the base against: no amount", async () => {
      const { d, reports } = routed([], () => ({ ok: true, result: result({ costUsd: 5 }) }));
      await execHeadlessJson({ ...d, costBase: withBase([devBase]).costBase }, { ...o, args, resumedId: "dev-1" });
      expect(reports[0]).toMatchObject({ costUsd: null });
    });
    it("a failed forked run is recorded the same way", async () => {
      const failed = { ...fork, isError: true };
      const { d, reports } = routed([], () => ({ ok: false, reason: "claude_error", message: "x", limit: null, stderr: "", result: failed }));
      await execHeadlessJson({ ...d, costBase: withBase([devBase]).costBase }, { ...o, args, resumedId: "dev-1" });
      expect((reports[0] as { costUsd: number }).costUsd).toBeCloseTo(0.3, 9);
    });
  });
  it("a fresh run's total is this run's cost and is recorded as is; no saved total is read", async () => {
    const args = ["-p", "--output-format", "json"];
    const fresh = parseClaudeJson(JSON.stringify(T1), args)!;
    const { d, reports } = routed([], () => ({ ok: true, result: fresh }));
    const costBase = vi.fn(async () => null);
    await execHeadlessJson({ ...d, costBase }, { ...lo, args });
    expect((reports[0] as { costUsd: number }).costUsd).toBe(T1.total_cost_usd);
    expect(costBase).not.toHaveBeenCalled();
  });

  it("no routing configured: a limit goes to the account-wide hooks and nothing retries", async () => {
    const { d, argv } = routed([], () => limited("x"));
    const onLimit = vi.fn();
    const r = await execHeadlessJson({ ...d, onLimit }, lo);
    expect(argv).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(onLimit).toHaveBeenCalledWith(expect.objectContaining({ kind: "rate_limit" }), "lessons");
  });

  it("withModel puts the flags after -p and drops stale ones", () => {
    expect(withModel(["-p", "--model", "old", "--x"], "new", "low")).toEqual(["-p", "--model", "new", "--effort", "low", "--x"]);
    expect(withModel(["-p", "--x"], null, null)).toEqual(["-p", "--x"]);
  });
});
