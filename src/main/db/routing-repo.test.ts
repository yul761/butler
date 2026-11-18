import { describe, expect, it } from "vitest";
import type { RegistryModel } from "../../shared/model-routing";
import { memDb } from "../test-utils";
import { migrate } from "./database";
import { EVENTS_KEEP_MS, RoutingRepo, type StoredHealth } from "./routing-repo";

const repo = () => {
  const db = memDb();
  migrate(db);
  return new RoutingRepo(db);
};
const model = (name: string, over: Partial<RegistryModel> = {}): RegistryModel => ({
  name, tier: "high", enabled: true, account: "default", priceIn: null, priceOut: null, note: "", ...over,
});

describe("RoutingRepo", () => {
  it("registry keeps insertion order, updates in place and moves", () => {
    const r = repo();
    r.upsertModel(model("a"));
    r.upsertModel(model("b", { tier: "mid", priceIn: 3, priceOut: 15 }));
    r.upsertModel(model("a", { enabled: false, account: "gw" }));
    expect(r.registry().map((m) => [m.name, m.enabled, m.account])).toEqual([["a", false, "gw"], ["b", true, "default"]]);
    expect(r.registry()[1]).toMatchObject({ priceIn: 3, priceOut: 15 });
    r.moveModel("b", -1);
    expect(r.registry().map((m) => m.name)).toEqual(["b", "a"]);
    r.moveModel("b", -1);
    expect(r.registry().map((m) => m.name)).toEqual(["b", "a"]);
    r.removeModel("b");
    expect(r.registry().map((m) => m.name)).toEqual(["a"]);
  });

  it("chains per tier, de-duplicated", () => {
    const r = repo();
    r.setChain("high", ["x", "y", "x"]);
    r.setChain("low", ["z"]);
    expect(r.chains()).toEqual({ high: ["x", "y"], mid: [], low: ["z"] });
    r.setChain("high", []);
    expect(r.chains().high).toEqual([]);
  });

  it("task routes", () => {
    const r = repo();
    r.setTaskRoute({ task: "lesson_analyze", tier: "high", policy: "wait", critical: true });
    r.setTaskRoute({ task: "needs_you", minTier: "low" });
    expect(r.taskRoutes()).toEqual([
      { task: "lesson_analyze", tier: "high", minTier: null, policy: "wait", critical: true },
      { task: "needs_you", tier: null, minTier: "low", policy: null, critical: null },
    ]);
    r.clearTaskRoute("needs_you");
    expect(r.taskRoutes()).toHaveLength(1);
  });

  it("rules", () => {
    const r = repo();
    r.addRule({ id: "user:1", kind: "regex", pattern: "x", category: "usage_limit", accountLevel: true, source: "user", enabled: true, note: "n" }, 1);
    r.addRule({ id: "builtin:overloaded", kind: "regex", pattern: "", category: null, accountLevel: false, source: "builtin", enabled: false, note: "" }, 2);
    expect(r.rules().map((x) => [x.id, x.enabled, x.accountLevel])).toEqual([["user:1", true, true], ["builtin:overloaded", false, false]]);
    expect(r.setRuleEnabled("user:1", false)).toBe(true);
    expect(r.setRuleEnabled("nope", false)).toBe(false);
    r.removeRule("user:1");
    expect(r.rules()).toHaveLength(1);
  });

  it("health round-trips", () => {
    const r = repo();
    const h: StoredHealth = {
      model: "m", state: "limited", kind: "usage_limit", until: 5, resetKnown: true, backoffStep: 2, hitAt: 3, suspected: true,
      consecutiveFailures: 4, failureStreakSince: 1, lastSuccessAt: null, lastFailureAt: 3, lastFailureText: "boom",
    };
    r.saveHealth(h, 10);
    expect(r.health()).toEqual([h]);
    r.saveHealth({ ...h, state: "ok", until: null }, 11);
    expect(r.health()[0]).toMatchObject({ state: "ok", until: null });
    r.deleteHealth("m");
    expect(r.health()).toEqual([]);
  });

  it("unrecognised errors are counted per fingerprint and keep the strongest signal", () => {
    const r = repo();
    const a = r.noteUnrecognized({ fingerprint: "fp", sample: "boom", model: "m1", signal: "observed", now: 1 });
    expect(a).toMatchObject({ count: 1, models: ["m1"], status: "open", signal: "observed" });
    r.noteUnrecognized({ fingerprint: "fp", sample: "boom", model: "m2", signal: "correlated", now: 2 });
    const b = r.noteUnrecognized({ fingerprint: "fp", sample: "boom", model: "m1", signal: "generic", now: 3 });
    expect(b).toMatchObject({ count: 3, models: ["m1", "m2"], lastSeen: 3, signal: "correlated" });
    r.setUnrecognizedStatus(b.id, "confirmed", "usage_limit", "learned:1");
    expect(r.unrecognizedById(b.id)).toMatchObject({ status: "confirmed", category: "usage_limit", ruleId: "learned:1" });
    expect(r.unrecognized()[0]).not.toHaveProperty("ruleId");
  });

  it("events: newest first, counted, pruned after 30 days", () => {
    const r = repo();
    r.addEvent({ at: 1, kind: "fallback", task: "needs_you", model: "a", toModel: "b" });
    r.addEvent({ at: EVENTS_KEEP_MS + 10, kind: "wait", task: "pre_review", model: "a" });
    expect(r.events().map((e) => e.kind)).toEqual(["wait", "fallback"]);
    expect(r.countEvents(["fallback"], 0)).toBe(1);
    r.pruneEvents(EVENTS_KEEP_MS + 5);
    expect(r.events().map((e) => e.kind)).toEqual(["wait"]);
  });
});
