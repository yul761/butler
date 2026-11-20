import { describe, expect, it } from "vitest";
import type { RegistryModel } from "../../shared/model-routing";
import { chooseMode, costOf, FULL_FRESH_MS, fullBlock, type ModeInput } from "./fork-mode";

const NOW = 10_000_000_000;
const ok: ModeInput = { cacheOk: true, launchKnown: true, transcriptExists: true, devIdle: true, lastTurnAt: NOW - 54 * 60_000, now: NOW };

describe("chooseMode", () => {
  it("is full when every condition holds (54 minutes since the last turn)", () => {
    expect(chooseMode(ok)).toBe("full");
  });
  it("is light when the cache cannot be read", () => {
    expect(chooseMode({ ...ok, cacheOk: false })).toBe("light");
  });
  it("is light when the dev session's launch is unknown", () => {
    expect(chooseMode({ ...ok, launchKnown: false })).toBe("light");
  });
  it("is light when there is no transcript", () => {
    expect(chooseMode({ ...ok, transcriptExists: false })).toBe("light");
  });
  it("is light when the dev session is busy", () => {
    expect(chooseMode({ ...ok, devIdle: false })).toBe("light");
  });
  it("is light when there is no last turn", () => {
    expect(chooseMode({ ...ok, lastTurnAt: null })).toBe("light");
  });
  it("treats exactly FULL_FRESH_MS as still fresh and one ms more as stale", () => {
    expect(chooseMode({ ...ok, lastTurnAt: NOW - FULL_FRESH_MS })).toBe("full");
    expect(chooseMode({ ...ok, lastTurnAt: NOW - FULL_FRESH_MS - 1 })).toBe("light");
  });
});

describe("fullBlock", () => {
  it("reports dev_busy, no_transcript, or null", () => {
    expect(fullBlock({ transcriptExists: true, devIdle: false })).toBe("dev_busy");
    expect(fullBlock({ transcriptExists: false, devIdle: true })).toBe("no_transcript");
    expect(fullBlock({ transcriptExists: true, devIdle: true })).toBeNull();
  });
  it("reports dev_busy first when both apply", () => {
    expect(fullBlock({ transcriptExists: false, devIdle: false })).toBe("dev_busy");
  });
});

describe("costOf", () => {
  const registry: RegistryModel[] = [{ name: "opus", tier: "high", enabled: true, account: "a", priceIn: 15, priceOut: 75, note: "" }];
  const usage = { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 100_000 };

  it("uses the CLI's total_cost_usd when present", () => {
    expect(costOf({ costUsd: 0.03, usage: null, model: null }, registry)).toEqual({ usd: 0.03, partial: false });
  });
  it("estimates from the price table without costUsd", () => {
    // 1M 输入 × 15 + 0.1M 输出 × 75，每百万
    expect(costOf({ costUsd: null, usage, model: "claude-opus-5" }, registry)).toEqual({ usd: 22.5, partial: false });
  });
  it("is unknown when the model is not in the price table", () => {
    expect(costOf({ costUsd: null, usage, model: "mystery" }, registry)).toEqual({ usd: null, partial: true });
  });
  it("is unknown when there is no usage", () => {
    expect(costOf({ costUsd: null, usage: null, model: "opus" }, registry)).toEqual({ usd: null, partial: true });
  });
});
