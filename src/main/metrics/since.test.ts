import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import { ensureMetricsSince, metricsSince } from "./since";

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
