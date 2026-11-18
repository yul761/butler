import { describe, expect, it } from "vitest";
import { BgSettingError, inHours, nextHoursStart, normalizeBgSetting, parseHours, parseKinds, readBgSettings } from "./bg-settings";

const at = (h: number, m = 0) => new Date(2026, 10, 18, h, m).getTime();

describe("background hours", () => {
  it("parses single, overnight and multiple ranges", () => {
    expect(parseHours("22:00-07:00")).toEqual([{ from: 1320, to: 420 }]);
    expect(parseHours("9:30-12:00, 13:00-18:00")).toEqual([{ from: 570, to: 720 }, { from: 780, to: 1080 }]);
    expect(parseHours("")).toEqual([]);
    expect(parseHours("25:00-01:00")).toBeNull();
    expect(parseHours("10:00-10:00")).toBeNull();
    expect(parseHours("bad")).toBeNull();
  });

  it("knows when now is inside, including across midnight", () => {
    const r = parseHours("22:00-07:00")!;
    expect(inHours(r, at(23))).toBe(true);
    expect(inHours(r, at(3))).toBe(true);
    expect(inHours(r, at(7))).toBe(false);
    expect(inHours(r, at(12))).toBe(false);
    expect(inHours(r, at(22))).toBe(true);
    expect(inHours([], at(12))).toBe(false);
  });

  it("finds the next start", () => {
    const r = parseHours("22:00-07:00, 12:00-13:00")!;
    expect(nextHoursStart(r, at(8))).toBe(at(12));
    expect(nextHoursStart(r, at(14))).toBe(at(22));
    expect(nextHoursStart(parseHours("06:00-07:00")!, at(8))).toBe(at(6) + 86_400_000);
    expect(nextHoursStart([], at(8))).toBeNull();
  });
});

describe("background settings", () => {
  const get = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? "" });

  it("defaults to running any time, like 2.1.0", () => {
    const s = readBgSettings(get({}));
    expect(s).toMatchObject({ window: "anytime", idleMinutes: 10, yieldMode: "finish", quotaOrder: "pause_first", plentifulPercent: null, kinds: {} });
    expect(s.hours).toEqual([{ from: 1320, to: 420 }]);
  });

  it("falls back to defaults on broken stored values", () => {
    const s = readBgSettings(get({ bgWindow: "never", bgIdleMinutes: "x", bgHours: "nope", bgKinds: "{", bgPlentifulPercent: "500" }));
    expect(s.window).toBe("anytime");
    expect(s.idleMinutes).toBe(10);
    expect(s.hours).toEqual([{ from: 1320, to: 420 }]);
    expect(s.kinds).toEqual({});
    expect(s.plentifulPercent).toBeNull();
  });

  it("normalizes and rejects", () => {
    expect(normalizeBgSetting("bgWindow", " idle ")).toBe("idle");
    expect(() => normalizeBgSetting("bgWindow", "sometimes")).toThrow(BgSettingError);
    expect(normalizeBgSetting("bgHours", "9:00-17:30")).toBe("09:00-17:30");
    expect(() => normalizeBgSetting("bgHours", "9-17")).toThrow(BgSettingError);
    expect(normalizeBgSetting("bgIdleMinutes", "05")).toBe("5");
    expect(() => normalizeBgSetting("bgIdleMinutes", "0")).toThrow(BgSettingError);
    expect(normalizeBgSetting("bgPlentifulPercent", "")).toBe("");
    expect(normalizeBgSetting("bgPlentifulPercent", "30")).toBe("30");
    expect(() => normalizeBgSetting("bgPlentifulPercent", "0")).toThrow(BgSettingError);
    expect(normalizeBgSetting("bgYield", "interrupt")).toBe("interrupt");
    expect(normalizeBgSetting("bgQuotaOrder", "downgrade_first")).toBe("downgrade_first");
    expect(normalizeBgSetting("bgKinds", "")).toBe("");
    expect(normalizeBgSetting("bgKinds", `{"backtest":{"priority":"high","window":"idle"},"lesson_backfill":{"paused":true}}`)).toBe(
      `{"backtest":{"priority":"high","window":"idle"},"lesson_backfill":{"paused":true}}`,
    );
    expect(() => normalizeBgSetting("bgKinds", `{"nope":{}}`)).toThrow(BgSettingError);
    expect(() => normalizeBgSetting("bgKinds", `{"backtest":{"priority":"urgent"}}`)).toThrow(BgSettingError);
    expect(normalizeBgSetting("bgKinds", `{"backtest":{}}`)).toBe("");
  });

  it("drops unknown kinds and fields when reading", () => {
    expect(parseKinds(`{"backtest":{"priority":"high","x":1},"nope":{"paused":true}}`)).toEqual({ backtest: { priority: "high" } });
  });
});
