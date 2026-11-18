import { afterEach, describe, expect, it } from "vitest";
import type { RegistryModel, Tier } from "../../shared/model-routing";
import { classifyLimitDetailed } from "../claude/limits";
import { migrate } from "../db/database";
import { RoutingRepo } from "../db/routing-repo";
import { UsageRepo } from "../db/usage-repo";
import { memDb } from "../test-utils";
import { compileRules, setActiveRules } from "./rules";
import { RoutingService, parseEffort, parseMaxConcurrent, type ProbeOutcome, type RoutingSettings } from "./routing-service";

const reg = (name: string, tier: Tier, over: Partial<RegistryModel> = {}): RegistryModel => ({
  name, tier, enabled: true, account: "default", priceIn: null, priceOut: null, note: "", ...over,
});

function setup(models: RegistryModel[] = [], settings: Partial<RoutingSettings> = {}) {
  const db = memDb();
  migrate(db);
  const repo = new RoutingRepo(db);
  for (const m of models) repo.upsertModel(m);
  const usage = new UsageRepo(db);
  let now = Date.UTC(2026, 10, 17, 12);
  const probes: string[] = [];
  let probeResult: ProbeOutcome = { ok: true };
  const s = new RoutingService({
    repo, usage, now: () => now,
    settings: () => ({ quotas: "", thresholds: "70,90", periodStartDay: 1, effort: "", maxConcurrent: "", autoSwitch: false, ...settings }),
    flags: () => ({ model: true, effort: true }),
    probe: async (m) => {
      probes.push(m);
      return probeResult;
    },
    setTimer: () => 0, clearTimer: () => undefined,
  });
  return { s, repo, usage, probes, setProbe: (r: ProbeOutcome) => void (probeResult = r), tick: (ms: number) => void (now += ms), now: () => now };
}

afterEach(() => setActiveRules(compileRules([])));

describe("RoutingService", () => {
  it("unconfigured: legacy plans, generic signals only recorded", () => {
    const { s, repo } = setup();
    expect(s.configured()).toBe(false);
    expect(s.plan("needs_you")).toMatchObject({ mode: "legacy", model: "haiku" });
    expect(s.onFailure(null, "API Error: 402 Payment Required", 402, "needs_you")).toBeNull();
    expect(repo.unrecognized()).toHaveLength(1);
    expect(s.lessonsBlockedUntil()).toBeNull();
  });

  it("an unknown error: suspected → listed → confirmed → recognised next time (acceptance 2)", async () => {
    const { s, repo } = setup([reg("M1", "mid"), reg("M2", "mid")]);
    const text = "Gateway: team allotment exhausted for org 42 (billing)";
    expect(classifyLimitDetailed({ text, apiStatus: null, now: 0 })).toBeNull();
    const hit = s.onFailure("M1", text, null, "lesson_analyze");
    expect(hit).toMatchObject({ kind: "usage_limit" });
    expect(s.health.get("M1")).toMatchObject({ state: "limited", suspected: true });
    const [u] = repo.unrecognized();
    expect(u).toMatchObject({ status: "open", signal: "generic", models: ["M1"] });
    expect(await s.act({ op: "confirmError", id: u!.id, category: "usage_limit", accountLevel: true })).toBeNull();
    expect(classifyLimitDetailed({ text: "Gateway: team allotment exhausted for org 7 (billing)", apiStatus: null, now: 0 })).toMatchObject({
      ruleId: `learned:${u!.id}`, accountLevel: true, hit: { kind: "usage_limit" },
    });
    expect(s.view().rules.some((r) => r.source === "learned")).toBe(true);
  });

  it("correlated: the same model failing three times while another succeeds", () => {
    const { s, repo, tick } = setup([reg("M1", "mid"), reg("M2", "mid")]);
    const text = "something odd happened";
    expect(s.onFailure("M1", text, null, "lesson_analyze")).toBeNull();
    tick(10);
    s.onSuccess("M2", Date.now());
    tick(10);
    expect(s.onFailure("M1", text, null, "lesson_analyze")).toBeNull();
    expect(s.onFailure("M1", text, null, "lesson_analyze")).toMatchObject({ kind: "usage_limit" });
    expect(repo.unrecognized()[0]).toMatchObject({ signal: "correlated" });
  });

  it("dismissing clears the suspicion and stops the signal for that error", async () => {
    const { s, repo } = setup([reg("M1", "mid")]);
    const text = "billing hiccup at the proxy";
    s.onFailure("M1", text, null, null);
    expect(s.health.usable("M1")).toBe(false);
    await s.act({ op: "dismissError", id: repo.unrecognized()[0]!.id });
    expect(s.health.usable("M1")).toBe(true);
    expect(s.onFailure("M1", text, null, null)).toBeNull();
    expect(s.health.usable("M1")).toBe(true);
  });

  it("account-level limits mark same-account models of the same or a higher tier", () => {
    const { s } = setup([reg("H", "high"), reg("M", "mid"), reg("L", "low"), reg("X", "high", { account: "other" })]);
    const marked = s.onLimit("M", { kind: "usage_limit", resetsAt: null, message: "x" }, { task: null, accountLevel: true });
    expect(marked.sort()).toEqual(["H", "M"]);
    expect(s.health.usable("L")).toBe(true);
    expect(s.health.usable("X")).toBe(true);
    s.onLimit("L", { kind: "rate_limit", resetsAt: null, message: "x" }, { task: null, accountLevel: false });
    expect(s.health.usable("M")).toBe(false);
  });

  it("lessons gate closes only when lesson_analyze can run nowhere", () => {
    const { s } = setup([reg("M", "mid"), reg("L", "low")]);
    s.onLimit("M", { kind: "rate_limit", resetsAt: null, message: "x" }, { task: null, accountLevel: false });
    expect(s.lessonsBlockedUntil()).toBeNull();
    s.onLimit("L", { kind: "rate_limit", resetsAt: null, message: "x" }, { task: null, accountLevel: false });
    expect(s.lessonsBlockedUntil()).not.toBeNull();
  });

  it("Now-page attention: limited models and fallbacks in the last hour, only when configured", () => {
    expect(setup().s.attention()).toBeNull();
    const { s, tick } = setup([reg("H", "high"), reg("M", "mid")]);
    expect(s.attention()).toBeNull();
    s.event("fallback", { task: "pr_brief", model: "H", toModel: "M" });
    tick(2 * 3_600_000);
    s.event("fallback", { task: "pr_brief", model: "H", toModel: "M" });
    s.onLimit("H", { kind: "rate_limit", resetsAt: null, message: "x" }, { task: null, accountLevel: false });
    expect(s.attention()).toEqual({ limited: ["H"], fallbacks: 1 });
  });

  it("manual probe recovers a model", async () => {
    const { s, probes } = setup([reg("M", "mid")]);
    s.onLimit("M", { kind: "rate_limit", resetsAt: null, message: "x" }, { task: null, accountLevel: false });
    await s.act({ op: "probe", model: "M" });
    expect(probes).toEqual(["M"]);
    expect(s.health.usable("M")).toBe(true);
    expect(s.view().events.map((e) => e.kind)).toContain("probe_ok");
  });

  it("session models: tiers, names, old aliases, next healthy, refusal", () => {
    const none = setup().s;
    expect(none.sessionModel("high")).toMatchObject({ ok: true, model: "opus" });
    expect(none.sessionModel("sonnet")).toMatchObject({ ok: true, model: "sonnet" });
    expect(none.sessionModel("claude-whatever-9")).toMatchObject({ ok: true, model: "claude-whatever-9" });
    expect(none.sessionModel("bad name!")).toMatchObject({ ok: false });

    const { s } = setup([reg("H1", "high"), reg("H2", "high"), reg("M1", "mid")]);
    expect(s.sessionModel("high")).toMatchObject({ ok: true, model: "H1", note: "routed" });
    s.onLimit("H1", { kind: "rate_limit", resetsAt: null, message: "x" }, { task: null, accountLevel: false });
    expect(s.sessionModel("high")).toMatchObject({ model: "H2", note: "next_healthy" });
    expect(s.sessionModel("H1")).toMatchObject({ model: "H2", note: "next_healthy" });
    expect(s.sessionModel("opus")).toMatchObject({ ok: true, model: "opus", note: "legacy" });
    expect(s.sessionModel("nope-model")).toMatchObject({ ok: false });
    expect(s.nextModel("H1")).toBe("H2");
    expect(s.nextModel("M1")).toBeNull();
  });

  it("without --model support the session gets no model flag", () => {
    const db = memDb();
    migrate(db);
    const s = new RoutingService({
      repo: new RoutingRepo(db), usage: new UsageRepo(db), now: () => 0, probe: async () => ({ ok: true }),
      settings: () => ({ quotas: "", thresholds: "", periodStartDay: 1, effort: "", maxConcurrent: "", autoSwitch: false }),
      flags: () => ({ model: false, effort: false }), setTimer: () => 0, clearTimer: () => undefined,
    });
    expect(s.sessionModel("high")).toMatchObject({ ok: true, model: null, note: "no_flag" });
    expect(s.effortFor("needs_you", "low")).toBeNull();
  });

  it("validates settings-page actions", async () => {
    const { s } = setup();
    expect(await s.act({ op: "addModel", model: reg("bad name", "high") })).not.toBeNull();
    expect(await s.act({ op: "addModel", model: reg("ok-1", "high") })).toBeNull();
    expect(await s.act({ op: "addModel", model: reg("ok-1", "high") })).not.toBeNull();
    expect(s.configured()).toBe(true);
    expect(await s.act({ op: "addRule", rule: { kind: "regex", pattern: "(", category: "usage_limit", accountLevel: false, note: "" } })).not.toBeNull();
    expect(await s.act({ op: "addRule", rule: { kind: "regex", pattern: "seat cap", category: "usage_limit", accountLevel: true, note: "" } })).toBeNull();
    expect(classifyLimitDetailed({ text: "seat cap hit", apiStatus: null, now: 0 })?.accountLevel).toBe(true);
    expect(await s.act({ op: "toggleRule", id: "builtin:overloaded", enabled: false })).toBeNull();
    expect(classifyLimitDetailed({ text: "overloaded_error", apiStatus: null, now: 0 })).toBeNull();
    expect(await s.act({ op: "removeRule", id: "builtin:overloaded" })).not.toBeNull();
  });

  it("effort and concurrency settings", async () => {
    expect(parseEffort('{"needs_you":"low","high":"max","bogus":"low","mid":"ultra"}')).toEqual({ needs_you: "low", high: "max" });
    expect(parseMaxConcurrent('{"high":1,"mid":0,"low":2.5}')).toEqual({ high: 1 });
    const { s } = setup([], { effort: '{"needs_you":"low","mid":"medium"}', maxConcurrent: '{"high":1}' });
    expect(s.effortFor("needs_you", "low")).toBe("low");
    expect(s.effortFor("pr_brief", "mid")).toBe("medium");
    const r1 = await s.acquire("high");
    let second = false;
    const p = s.acquire("high").then((r) => {
      second = true;
      return r;
    });
    await Promise.resolve();
    expect(second).toBe(false);
    r1();
    (await p)();
    expect(second).toBe(true);
  });
});
