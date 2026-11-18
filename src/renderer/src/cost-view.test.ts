import { describe, expect, it } from "vitest";
import type { CostBreakerView, CostPolicyView } from "../../shared/cost";
import { breakerFor, costAmount, costBreakerText, costOverridesFromDraft, parseCostInput, withKindOverride } from "./cost-view";
import { STRINGS } from "./strings";

const ZH = STRINGS.zh;
const EN = STRINGS.en;

const breaker = (o: Partial<CostBreakerView> = {}): CostBreakerView => ({
  subjectKind: "session", subjectId: "root-1", sessionId: "head-1", ticketKey: "T-1", title: "fix login",
  state: "paused", spent: 12.5, cap: 10, unit: "usd", partial: false, pauseScope: "session",
  fromModel: null, toModel: null, trippedAt: 1, pausedAt: 2, stoppedAt: null, takenOver: false, ...o,
});

describe("costAmount", () => {
  it("writes dollars with sensible precision and tokens in k / M", () => {
    expect(costAmount(0.4321, "usd", ZH)).toBe("$0.43");
    expect(costAmount(12.345, "usd", ZH)).toBe("$12.3");
    expect(costAmount(250, "usd", ZH)).toBe("$250");
    expect(costAmount(950, "tokens", EN)).toBe("950 tokens");
    expect(costAmount(12_300, "tokens", EN)).toBe("12.3k tokens");
    expect(costAmount(2_500_000, "tokens", ZH)).toBe("2.5M token");
  });
});

describe("costBreakerText", () => {
  it("says what happened in each state, with stop / takeover / partial details", () => {
    expect(costBreakerText(breaker({ state: "warned", spent: 8 }), ZH)).toBe("session「fix login」 已花 $8.00，快到上限 $10.0 了");
    expect(costBreakerText(breaker({ state: "downgraded", fromModel: "big", toModel: "small" }), EN)).toBe("Session “fix login” reached its cap ($12.5 / $10.0) and switched from big to small");
    expect(costBreakerText(breaker({ state: "downgraded", subjectKind: "ticket", title: "T-1 fix login" }), EN)).toBe("Ticket T-1 fix login reached its cap ($12.5 / $10.0); its background calls now use a lower model");
    expect(costBreakerText(breaker({ pauseScope: "background" }), EN)).toContain("its background work is paused");
    expect(costBreakerText(breaker({ stoppedAt: 3, partial: true }), EN)).toBe("Session “fix login” reached its cap ($12.5 / $10.0) and is paused · It kept spending after the pause, so Butler ended its terminal · Some usage has no known price, so the real spend is higher");
    expect(costBreakerText(breaker({ takenOver: true }), ZH)).toContain("你接手了终端");
  });
});

const view: CostPolicyView = {
  scope: { kind: "global" },
  keys: [
    { key: "sessionCap", effective: 10, origin: { kind: "global" }, set: true, override: 10 },
    { key: "ticketCap", effective: null, origin: { kind: "default" }, set: false, override: null },
    { key: "unit", effective: "usd", origin: { kind: "default" }, set: false, override: null },
    { key: "raisePercent", effective: 50, origin: { kind: "default" }, set: false, override: null },
  ],
};

describe("parseCostInput / costOverridesFromDraft", () => {
  it("treats empty as inherit and none as an explicit no-cap", () => {
    expect(parseCostInput("sessionCap", "")).toEqual({ inherit: true });
    expect(parseCostInput("sessionCap", " none ")).toEqual({ value: null });
    expect(parseCostInput("sessionCap", "不限")).toEqual({ value: null });
    expect(parseCostInput("sessionCap", "2.5")).toEqual({ value: 2.5 });
    expect(parseCostInput("sessionCap", "-1")).toBeUndefined();
    expect(parseCostInput("unit", "none")).toBeUndefined();
    expect(parseCostInput("raisePercent", "1.5")).toBeUndefined();
    expect(parseCostInput("unit", "tokens")).toEqual({ value: "tokens" });
  });

  it("keeps untouched keys, applies edits, and reports the first bad key", () => {
    expect(costOverridesFromDraft(view, {})).toEqual({ ok: true, overrides: { sessionCap: 10 }, changed: false });
    expect(costOverridesFromDraft(view, { sessionCap: "", ticketCap: "none", unit: "tokens" })).toEqual({ ok: true, overrides: { ticketCap: null, unit: "tokens" }, changed: true });
    expect(costOverridesFromDraft(view, { sessionCap: "10" })).toEqual({ ok: true, overrides: { sessionCap: 10 }, changed: false });
    expect(costOverridesFromDraft(view, { raisePercent: "0" })).toEqual({ ok: false, badKey: "raisePercent" });
  });

  it("an explicit no-cap that is already set stays set when untouched", () => {
    const v: CostPolicyView = { scope: { kind: "global" }, keys: [{ key: "ticketCap", effective: null, origin: { kind: "global" }, set: true, override: null }] };
    expect(costOverridesFromDraft(v, {})).toEqual({ ok: true, overrides: { ticketCap: null }, changed: false });
  });
});

describe("withKindOverride", () => {
  it("merges a per-kind change into the bgKinds JSON and drops empty entries", () => {
    expect(withKindOverride("", "backtest", { priority: "high" })).toBe('{"backtest":{"priority":"high"}}');
    expect(withKindOverride('{"backtest":{"priority":"high","paused":true}}', "backtest", { priority: undefined })).toBe('{"backtest":{"paused":true}}');
    expect(withKindOverride('{"backtest":{"window":"idle"}}', "backtest", { window: undefined })).toBe("");
    expect(withKindOverride("not json", "repo_scan", { window: "hours" })).toBe('{"repo_scan":{"window":"hours"}}');
  });
});

describe("breakerFor (session row)", () => {
  it("prefers the session's own breaker, then a tripped breaker of its ticket", () => {
    const own = breaker({ state: "warned" });
    const ticket = breaker({ subjectKind: "ticket", subjectId: "T-1", sessionId: "other", state: "paused" });
    const warnedTicket = { ...ticket, state: "warned" as const };
    expect(breakerFor([ticket, own], "head-1", "T-1")).toBe(own);
    expect(breakerFor([ticket], "head-2", "T-1")).toBe(ticket);
    expect(breakerFor([warnedTicket], "head-2", "T-1")).toBeNull();
    expect(breakerFor([ticket], "head-2", null)).toBeNull();
  });
});
