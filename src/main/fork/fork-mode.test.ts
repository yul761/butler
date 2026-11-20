import { describe, expect, it } from "vitest";
import type { RegistryModel } from "../../shared/model-routing";
import { chooseMode, costOf, FULL_FRESH_MS, fullBlock, runStart, turnCost, type ModeInput } from "./fork-mode";

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

describe("runStart", () => {
  it("tells a fresh session, a fork of another session and a resumed fork apart", () => {
    expect(runStart(["-p", "--model", "opus"])).toBe("fresh");
    expect(runStart(["-p", "--resume", "dev-1", "--fork-session"])).toBe("forked");
    expect(runStart(["-p", "--resume", "fork-1"])).toBe("resumed");
  });
});

describe("turnCost", () => {
  const registry: RegistryModel[] = [{ name: "opus", tier: "high", enabled: true, account: "a", priceIn: 15, priceOut: 75, note: "" }];
  const usage = { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 100_000 };
  const run = (costUsd: number | null) => ({ costUsd, usage, model: "claude-opus-5" });

  it("a fresh session's total is this run's cost", () => {
    expect(turnCost(run(0.01), "fresh", null, registry)).toEqual({ usd: 0.01, partial: false, cli: 0.01, seenTotal: 0.01 });
  });
  it("a fork of another session carries that session's past spend: estimate from usage, remember the total", () => {
    expect(turnCost(run(5), "forked", null, registry)).toEqual({ usd: 22.5, partial: false, cli: null, seenTotal: 5 });
  });
  it("a resumed fork costs the difference from the last total seen, never below zero", () => {
    const r = turnCost(run(0.03), "resumed", 0.01, registry);
    expect(r.usd).toBeCloseTo(0.02, 10);
    expect(r).toMatchObject({ partial: false, seenTotal: 0.03 });
    expect(r.cli).toBe(r.usd);
  });
  // CLI 读不回分叉 session 存的费用状态时会从 0 记起（CLI 的说明："continues from the total its transcript saved, when it has one"），
  // total 就只是这一轮的，取差会悄悄记成 0 或者一个错的数。
  it("a total below the last one seen: the CLI lost its running total, so no difference; estimate, partial", () => {
    expect(turnCost(run(0.01), "resumed", 0.03, registry)).toEqual({ usd: 22.5, partial: true, cli: null, seenTotal: 0.01 });
  });
  // modelUsage 和 total 一样是累计的：这一轮的份额 = total × w(usage) / Σ w(modelUsage)
  const raw = { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 50 };
  const runW = 100 + 900 + 250;
  const cumulative = { "claude-opus-5": { inputTokens: 100 * 50, outputTokens: 50 * 50, cacheReadInputTokens: 9000 * 50, cacheCreationInputTokens: 0 } };
  const withCumulative = (costUsd: number | null) => ({ ...run(costUsd), usageRaw: raw, modelUsage: cumulative });
  it("a fork of another session with modelUsage: this run's exact share of the total, not partial", () => {
    const r = turnCost(withCumulative(1.02), "forked", null, registry);
    expect(r.usd).toBeCloseTo((1.02 * runW) / (runW * 50), 12);
    expect(r).toMatchObject({ partial: false, seenTotal: 1.02 });
    expect(r.cli).toBe(r.usd);
  });
  it("a resumed fork with no total seen yet but with modelUsage: the share too", () => {
    const r = turnCost(withCumulative(1.04), "resumed", null, registry);
    expect(r.usd).toBeCloseTo(1.04 / 50, 12);
    expect(r).toMatchObject({ partial: false, cli: r.usd, seenTotal: 1.04 });
  });
  it("a resumed fork with a total seen still takes the difference, not the share", () => {
    const r = turnCost(withCumulative(1.04), "resumed", 1.02, registry);
    expect(r.usd).toBeCloseTo(0.02, 10);
  });
  // 开发 session 常有好几个模型（subagent 走 sonnet/haiku）：只拿这一轮的模型那一项拆，按它自己的单价。
  const opusHistory = { inputTokens: 100 * 51, outputTokens: 50 * 51, cacheReadInputTokens: 9000 * 51, cacheCreationInputTokens: 0, costUSD: 1.02 };
  const haikuHistory = { ...opusHistory, costUSD: 0.2 };
  const twoModels = { "claude-haiku-5": haikuHistory, "claude-opus-5": opusHistory };
  it("several models in the cumulative: this run's model's own cost and weight, exact", () => {
    const r = turnCost({ ...run(1.22), usageRaw: raw, modelUsage: twoModels }, "forked", null, registry);
    expect(r.usd).toBeCloseTo(1.02 / 51, 12);
    expect(r).toMatchObject({ partial: false, seenTotal: 1.22 });
  });
  it("several models and this run's model unknown: the share of every model's weight, partial", () => {
    const r = turnCost({ ...run(1.22), model: null, usageRaw: raw, modelUsage: twoModels }, "forked", null, registry);
    expect(r.usd).toBeCloseTo(1.22 / 102, 12);
    expect(r).toMatchObject({ partial: true, seenTotal: 1.22 });
    expect(r.cli).toBe(r.usd);
  });
  it("a total seen but modelUsage holding only this run: the CLI started its total over, so the share (all of it), partial", () => {
    const only = { "claude-opus-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 9000, cacheCreationInputTokens: 0, costUSD: 0.03 } };
    // 精简分叉第一轮见过 0.01；这一轮没恢复，total 0.03 全是这一轮的，取差会记成 0.02。
    const r = turnCost({ ...run(0.03), usageRaw: raw, modelUsage: only }, "resumed", 0.01, registry);
    expect(r.usd).toBeCloseTo(0.03, 12);
    expect(r).toMatchObject({ partial: true, seenTotal: 0.03 });
    expect(r.cli).toBe(r.usd);
  });
  it("a total below the one seen with modelUsage: the share, partial", () => {
    const r = turnCost(withCumulative(1.04), "resumed", 5.02, registry);
    expect(r.usd).toBeCloseTo(1.04 / 50, 12);
    expect(r).toMatchObject({ partial: true, seenTotal: 1.04 });
  });
  it("a failed run never pulls the total seen back (a start-up error may report 0); one that went up still moves it", () => {
    expect(turnCost({ costUsd: 0, usage: null, model: null }, "resumed", 5.02, registry, true)).toEqual({ usd: null, partial: true, cli: null, seenTotal: 5.02 });
    expect(turnCost(run(5.03), "resumed", 5.02, registry, true)).toMatchObject({ partial: false, seenTotal: 5.03 });
  });
  it("modelUsage with nothing in it falls back to the estimate", () => {
    expect(turnCost({ ...run(5), usageRaw: raw, modelUsage: {} }, "forked", null, registry)).toEqual({ usd: 22.5, partial: false, cli: null, seenTotal: 5 });
  });
  it("a resumed fork with no total seen yet falls back to the estimate", () => {
    expect(turnCost(run(5.02), "resumed", null, registry)).toEqual({ usd: 22.5, partial: false, cli: null, seenTotal: 5.02 });
  });
  // 估过的这一轮还在 CLI 的累计里：留着上次的累计，下一轮的差值会把它再算一遍。所以忘掉上次的累计，下一轮按份额拆。
  it("without a CLI total but estimated: forget the last total seen so the next turn doesn't count this one again", () => {
    expect(turnCost(run(null), "resumed", 0.04, registry)).toEqual({ usd: 22.5, partial: false, cli: null, seenTotal: null });
  });
  it("without a CLI total and nothing charged: keep the last total seen (the next difference covers this turn)", () => {
    expect(turnCost({ costUsd: null, usage: null, model: "opus" }, "resumed", 0.04, registry)).toEqual({ usd: null, partial: true, cli: null, seenTotal: 0.04 });
  });
  // fresh、forked 开的是新 session：之前见过的累计是别的 session 的（比如第一轮失败后丢掉的那个），不能留给下一轮去减。
  it("a new session (fresh or forked) without a CLI total: the total seen before was another session's, so forget it", () => {
    expect(turnCost({ costUsd: null, usage: null, model: "opus" }, "forked", 5.02, registry)).toMatchObject({ seenTotal: null });
    expect(turnCost(run(null), "fresh", 0.01, registry)).toMatchObject({ usd: 22.5, seenTotal: null });
  });
});
