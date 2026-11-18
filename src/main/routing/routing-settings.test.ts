import { describe, expect, it } from "vitest";
import { normalizeRoutingSetting as n, routingSettings } from "./routing-settings";

describe("routing settings", () => {
  it("quotas: all entries must be valid", () => {
    expect(n("routingQuotas", "")).toBe("");
    expect(n("routingQuotas", '[{"target":"tier:high","unit":"usd","monthly":100}]')).toBe('[{"target":"tier:high","unit":"usd","monthly":100}]');
    expect(() => n("routingQuotas", '[{"target":"tier:ultra","unit":"usd","monthly":1}]')).toThrow();
    expect(() => n("routingQuotas", "{oops")).toThrow();
    expect(() => n("routingQuotas", '{"a":1}')).toThrow();
  });
  it("thresholds", () => {
    expect(n("routingThresholds", " 60 , 85 ")).toBe("60,85");
    expect(() => n("routingThresholds", "90,70")).toThrow();
    expect(() => n("routingThresholds", "0,50")).toThrow();
    expect(() => n("routingThresholds", "70")).toThrow();
  });
  it("period day, effort, concurrency, auto switch", () => {
    expect(n("routingPeriodStartDay", "05")).toBe("5");
    expect(() => n("routingPeriodStartDay", "29")).toThrow();
    expect(n("routingEffort", '{"needs_you":"low","high":"max"}')).toBe('{"needs_you":"low","high":"max"}');
    expect(() => n("routingEffort", '{"needs_you":"ultra"}')).toThrow();
    expect(n("routingMaxConcurrent", '{"high":1}')).toBe('{"high":1}');
    expect(() => n("routingMaxConcurrent", '{"high":0}')).toThrow();
    expect(n("routingAutoSwitch", "1")).toBe("1");
    expect(() => n("routingAutoSwitch", "yes")).toThrow();
  });
  it("reads with safe fallbacks", () => {
    const vals: Record<string, string> = { routingQuotas: "", routingThresholds: "70,90", routingPeriodStartDay: "99", routingEffort: "", routingMaxConcurrent: "", routingAutoSwitch: "1" };
    expect(routingSettings({ get: (k: string) => vals[k] ?? "" } as never)).toMatchObject({ periodStartDay: 1, autoSwitch: true });
  });
});
