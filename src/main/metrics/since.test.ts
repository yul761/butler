import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import { baselineCutoffOf, ensureMetricsSince, metricsSince } from "./since";

describe("metricsSince", () => {
  it("is stored once and kept across restarts", () => {
    const s = new SettingsRepo(memDb());
    expect(metricsSince(s)).toBeNull();
    expect(ensureMetricsSince(s, 100)).toBe(100);
    expect(ensureMetricsSince(s, 200)).toBe(100);
    s.set("metricsSince", "junk");
    expect(metricsSince(s)).toBeNull();
  });
});

describe("baselineCutoffOf (ws-h)", () => {
  it("uses the metrics start until there is a Butler session, then stores the first one and keeps it", () => {
    const s = new SettingsRepo(memDb());
    let first: number | null = null;
    expect(baselineCutoffOf(s, () => first, 9)).toBe(9);
    expect(s.get("metricsBaselineCutoff")).toBe("");
    first = 5;
    expect(baselineCutoffOf(s, () => first, 9)).toBe(5);
    // 最早的 session 删了、或者更早的改成了 Butler 的：截止点不动。
    first = 50;
    expect(baselineCutoffOf(s, () => first, 9)).toBe(5);
    first = 1;
    expect(baselineCutoffOf(s, () => first, 9)).toBe(5);
  });
});
