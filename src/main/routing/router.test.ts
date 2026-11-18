import { describe, expect, it } from "vitest";
import type { RegistryModel, RoutingConfig, SpendLevel, Tier } from "../../shared/model-routing";
import { candidatesFor, planTask, tierChain, type PlanInput } from "./router";

const m = (name: string, tier: Tier, over: Partial<RegistryModel> = {}): RegistryModel => ({
  name, tier, enabled: true, account: "default", priceIn: null, priceOut: null, note: "", ...over,
});
const cfg = (registry: RegistryModel[], chains: Partial<Record<Tier, string[]>> = {}, overrides: RoutingConfig["overrides"] = []): RoutingConfig => ({
  registry, chains: { high: [], mid: [], low: [], ...chains }, overrides,
});
const STD = cfg([m("H1", "high"), m("H2", "high"), m("M1", "mid"), m("L1", "low")]);
const input = (p: Partial<PlanInput> & Pick<PlanInput, "task">): PlanInput => ({
  config: STD, now: 1000, usable: () => true, recoversAt: () => null, spendLevel: () => "ok", periodEnd: 99_000, ...p,
});
const models = (p: ReturnType<typeof planTask>) => (p.mode === "routed" ? p.candidates.map((c) => c.model) : p.mode);

describe("chains", () => {
  it("explicit chains win, registry order otherwise; disabled models are left out", () => {
    const c = cfg([m("A", "high"), m("B", "high", { enabled: false }), m("C", "mid")], { mid: ["gw/other", "C", "B"] });
    expect(tierChain(c, "high")).toEqual(["A"]);
    expect(tierChain(c, "mid")).toEqual(["gw/other", "C"]);
  });
  it("walks down to the minimum, then up when empty", () => {
    expect(candidatesFor(STD, "mid", "low").map((c) => c.model)).toEqual(["M1", "L1"]);
    const onlyHigh = cfg([m("H", "high")]);
    expect(candidatesFor(onlyHigh, "low", "low")).toEqual([{ model: "H", tier: "high" }]);
  });
});

describe("planTask", () => {
  it("unconfigured: today's model per call site", () => {
    const none = cfg([]);
    expect(planTask(input({ task: "needs_you", config: none }))).toMatchObject({ mode: "legacy", model: "haiku" });
    expect(planTask(input({ task: "handoff_refresh", config: none }))).toMatchObject({ mode: "legacy", model: "sonnet" });
    expect(planTask(input({ task: "lesson_analyze", config: none }))).toMatchObject({ mode: "legacy", model: null });
    expect(planTask(input({ task: "handoff", config: none, sessionModel: "opus" }))).toMatchObject({ mode: "legacy", model: "opus" });
    // Nothing is skipped when unconfigured, even if a model is marked.
    expect(planTask(input({ task: "needs_you", config: none, usable: () => false }))).toMatchObject({ mode: "legacy" });
  });

  it("a disabled-only registry counts as unconfigured", () => {
    expect(planTask(input({ task: "needs_you", config: cfg([m("X", "low", { enabled: false })]) }))).toMatchObject({ mode: "legacy", model: "haiku" });
  });

  it("fallback tasks list their tier then lower tiers", () => {
    expect(models(planTask(input({ task: "lesson_analyze" })))).toEqual(["M1", "L1"]);
    expect(models(planTask(input({ task: "needs_you" })))).toEqual(["L1"]);
  });

  it("a limited model is skipped (acceptance 1)", () => {
    const p = planTask(input({ task: "lesson_analyze", usable: (x) => x !== "M1", recoversAt: () => 5000 }));
    expect(models(p)).toEqual(["L1"]);
    expect(p.mode === "routed" && p.skipped).toEqual([{ model: "M1", tier: "mid", reason: "limited", until: 5000 }]);
  });

  it("wait tasks stay on their tier and wait when it is out", () => {
    expect(models(planTask(input({ task: "pre_review" })))).toEqual(["H1", "H2"]);
    const p = planTask(input({ task: "pre_review", usable: (x) => !x.startsWith("H"), recoversAt: (x) => (x === "H1" ? 7000 : 4000) }));
    expect(p).toMatchObject({ mode: "wait", until: 4000, requestedTier: "high" });
  });

  it("overrides change tier and policy", () => {
    const c = { ...STD, overrides: [{ task: "needs_you" as const, tier: "high" as const, minTier: "mid" as const }] };
    expect(models(planTask(input({ task: "needs_you", config: c })))).toEqual(["H1", "H2", "M1"]);
  });

  it("an empty tier range falls back to the legacy model", () => {
    // pre_review needs the high tier; only a low model is registered: use the default model as 2.1.0 would.
    expect(planTask(input({ task: "pre_review", config: cfg([m("L", "low")]) }))).toMatchObject({ mode: "legacy", model: null, why: "no_models" });
    expect(planTask(input({ task: "needs_you", config: cfg([m("H", "high")]) }))).toMatchObject({ mode: "routed", candidates: [{ model: "H" }] });
  });

  it("session tasks keep the session model and wait when it is limited", () => {
    expect(planTask(input({ task: "handoff", sessionModel: "H2" }))).toMatchObject({ mode: "routed", candidates: [{ model: "H2", tier: "high" }] });
    expect(planTask(input({ task: "handoff", sessionModel: "H2", usable: () => false, recoversAt: () => 3000 }))).toMatchObject({ mode: "wait", until: 3000 });
    expect(planTask(input({ task: "handoff", sessionModel: null }))).toMatchObject({ mode: "legacy", model: null, why: "session_unknown" });
  });

  it("spend: soft drops non-critical fallback tasks a tier; hard makes wait tasks wait; critical ignores both (acceptance 4)", () => {
    const level = (lv: SpendLevel) => (x: string) => (x.startsWith("H") ? lv : "ok");
    const highFallback = { ...STD, overrides: [{ task: "pr_brief" as const, tier: "high" as const }] };
    expect(models(planTask(input({ task: "pr_brief", config: highFallback, spendLevel: level("soft") })))).toEqual(["M1", "L1"]);
    // A wait task at the soft level still uses the high tier.
    expect(models(planTask(input({ task: "pre_review", spendLevel: level("soft") })))).toEqual(["H1", "H2"]);
    // At the hard level it waits until the period ends instead of degrading.
    expect(planTask(input({ task: "pre_review", spendLevel: level("hard") }))).toMatchObject({ mode: "wait", until: 99_000 });
    const critical = { ...STD, overrides: [{ task: "pre_review" as const, critical: true }] };
    expect(models(planTask(input({ task: "pre_review", config: critical, spendLevel: level("hard") })))).toEqual(["H1", "H2"]);
  });

  it("reviewers avoid the producer's model and start at its tier", () => {
    const p = planTask(input({ task: "lesson_sample_review", producer: { model: "H1", tier: "high" } }));
    expect(models(p)).toEqual(["H2"]);
    const solo = cfg([m("H1", "high")]);
    expect(planTask(input({ task: "lesson_sample_review", config: solo, producer: { model: "H1", tier: "high" } }))).toMatchObject({
      mode: "routed", sameModelReview: true, candidates: [{ model: "H1" }],
    });
  });
});
