import { describe, expect, it } from "vitest";
import { F1, F2, T1, T2, T3 } from "./__fixtures__/cli-cost";
import { cumulativeIsThisRun, cumulativeWeight, runCostFromCumulative, runModel, runWeight } from "./run-cost";

// 实测的 t2 的 usage 去掉 cache_creation 分档（CLI 不知道这些写入活多久的那种回复）
const T2_USAGE = { input_tokens: 2, cache_read_input_tokens: 15039, cache_creation_input_tokens: 10649, output_tokens: 3 };

describe("runWeight / cumulativeWeight", () => {
  it("weighs the live t2 numbers: modelUsage w = 51460.1, this run's usage (all its cache writes reported as 1h) w = 22818.9", () => {
    expect(cumulativeWeight(T2.modelUsage)).toBeCloseTo(51460.1, 6);
    expect(runWeight(T2.usage)).toBeCloseTo(2 + 1503.9 + 2 * 10649 + 15, 6);
  });
  // CLI 的计价：明确记成 1h 的按 1h 价，其余（5m、没分档的余量、完全没有分档）按 5m 价。分子分母同一条规则。
  it("a run with no cache_creation split prices all its cache writes at 5m, as the CLI does", () => {
    expect(runWeight(T2_USAGE)).toBeCloseTo(2 + 1503.9 + 1.25 * 10649 + 15, 6);
  });
  it("a split that adds up to less than the total write: the rest counts at 5m", () => {
    const u = { ...T2_USAGE, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 649 } };
    expect(runWeight(u)).toBeCloseTo(2 + 1503.9 + 2 * 649 + 1.25 * 10000 + 15, 6);
    const mu = { m: { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 26881, cacheCreationInputTokens: 2_024_369, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 24369 } };
    expect(cumulativeWeight(mu)).toBeCloseTo(4 + 2688.1 + 2 * 24369 + 1.25 * 2_000_000 + 30, 6);
  });
  it("split fields present but 0 while the total is not: all of it counts at 5m, not nothing", () => {
    const mu = { m: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 1000, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0 } };
    expect(cumulativeWeight(mu)).toBeCloseTo(1250, 6);
    expect(runWeight({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } })).toBeCloseTo(1250, 6);
  });
  it("uses the 5m/1h split of this run's cache writes when the CLI gives one", () => {
    const u = { ...T2_USAGE, cache_creation: { ephemeral_5m_input_tokens: 649, ephemeral_1h_input_tokens: 10000 } };
    expect(runWeight(u)).toBeCloseTo(2 + 1503.9 + 1.25 * 649 + 2 * 10000 + 15, 6);
  });
  it("cumulativeWeight adds up every model (only the fallback uses it); a model without the split counts all its cache writes at 5m", () => {
    const mu = {
      a: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 100, cacheCreationEphemeral5mInputTokens: 4, cacheCreationEphemeral1hInputTokens: 8 },
      b: { inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 3 },
    };
    expect(cumulativeWeight(mu)).toBeCloseTo(10 + 5 + 10 + 1.25 * 4 + 2 * 8 + 1 + 1.25 * 3, 6);
  });
  it("not an object → null", () => {
    expect(runWeight(null)).toBeNull();
    expect(cumulativeWeight(undefined)).toBeNull();
    expect(cumulativeWeight([1])).toBeNull();
  });
});

describe("runCostFromCumulative", () => {
  it("splits this run's model's cumulative cost by its share of that model's weighted tokens (live t2): exact", () => {
    const r = runCostFromCumulative(T2.total_cost_usd, T2.usage, T2.modelUsage, null);
    expect(r?.usd).toBeCloseTo((0.00514601 * 22818.9) / 51460.1, 12);
    expect(r?.usd).toBeCloseTo(0.0022819, 6);
    expect(r?.partial).toBe(false);
  });
  it("matches each live run's real cost (the difference of the totals): t2, t3, the fork f1 and its follow-up f2", () => {
    for (const [run, before] of [[T2, T1], [T3, T2], [F1, T3], [F2, F1]] as const) {
      expect(runCostFromCumulative(run.total_cost_usd, run.usage, run.modelUsage, null)?.usd).toBeCloseTo(run.total_cost_usd - before.total_cost_usd, 9);
    }
  });
  // 单价跨模型不一样：opus 每单位权重 5 倍于 haiku。历史里两个模型权重一样多，这一轮是 opus，真实 0.02。
  // 把所有模型的权重加起来按 total 拆会得到 1.22 × 4000 / 404000 ≈ 0.0121，少四成。
  const run = { input_tokens: 4000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  const opus = { inputTokens: 204_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1.02 };
  const haiku = { inputTokens: 200_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.2 };
  it("several models: only this run's model counts, priced at its own rate, not summed across models", () => {
    const r = runCostFromCumulative(1.22, run, { "claude-haiku-5-5": haiku, "claude-opus-5-5": opus }, "opus");
    expect(r?.usd).toBeCloseTo(0.02, 12);
    expect(r?.partial).toBe(false);
  });
  it("several models and only one can hold this run's usage: that one, with no hint", () => {
    const small = { ...haiku, inputTokens: 100 };
    expect(runCostFromCumulative(1.22, run, { "claude-haiku-5-5": small, "claude-opus-5-5": opus }, null)?.usd).toBeCloseTo(0.02, 12);
  });
  it("this run's model can't be told apart: the share of every model's weight, marked partial", () => {
    const r = runCostFromCumulative(1.22, run, { "claude-haiku-5-5": haiku, "claude-opus-5-5": opus }, null);
    expect(r?.usd).toBeCloseTo((1.22 * 4000) / 404_000, 12);
    expect(r?.partial).toBe(true);
  });
  it("the model has no costUSD: the share of the total; exact when it is the only model", () => {
    const mu = { m: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 15039, cacheCreationInputTokens: 10649 } };
    expect(runCostFromCumulative(0.01, T2_USAGE, mu, null)).toEqual({ usd: 0.01, partial: false });
  });
  // 这一轮比累计还大说明数对不上（比如累计没算全）：夹到 total 等于把以前的花费全算到这一轮头上，所以算不出来。
  it("this run weighing more than the cumulative → null, not clamped to the total", () => {
    const mu = { m: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 15039, cacheCreationInputTokens: 0 } };
    expect(runCostFromCumulative(5.02, T2_USAGE, mu, null)).toBeNull();
    expect(runCostFromCumulative(5.02, T2_USAGE, { m: { ...mu.m, costUSD: 5.02 } }, "m")).toBeNull();
  });
  it("can't tell → null: no usage, no modelUsage, a zero weight, or neither a costUSD nor a total", () => {
    expect(runCostFromCumulative(T2.total_cost_usd, null, T2.modelUsage, null)).toBeNull();
    expect(runCostFromCumulative(T2.total_cost_usd, T2.usage, undefined, null)).toBeNull();
    expect(runCostFromCumulative(T2.total_cost_usd, T2.usage, {}, null)).toBeNull();
    expect(runCostFromCumulative(T2.total_cost_usd, T2.usage, { m: { inputTokens: 0 } }, null)).toBeNull();
    expect(runCostFromCumulative(null, T2_USAGE, { m: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 15039, cacheCreationInputTokens: 10649 } }, null)).toBeNull();
  });
});

describe("runModel", () => {
  const u = { input_tokens: 2, cache_creation_input_tokens: 63, cache_read_input_tokens: 25701, output_tokens: 3 };
  const big = { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 100_000, cacheCreationInputTokens: 100 };
  it("the only model is this run's (live f1)", () => {
    expect(runModel(F1.modelUsage, F1.usage, null)).toBe("claude-haiku-5-5");
  });
  it("only one model's running totals can hold this run's usage → that one, whatever the hint says", () => {
    expect(runModel({ small: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 25700, cacheCreationInputTokens: 63 }, "claude-opus-5-5": big }, u, "haiku")).toBe("claude-opus-5-5");
  });
  it("several can: the hint picks one by full id, by alias or with a [1m] suffix; none or two match → null", () => {
    const mu = { "claude-haiku-5-5": big, "claude-opus-5-5": big };
    expect(runModel(mu, u, "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(runModel(mu, u, "opus")).toBe("claude-opus-5-5");
    expect(runModel(mu, u, "OPUS[1m]")).toBe("claude-opus-5-5");
    expect(runModel(mu, u, "sonnet")).toBeNull();
    expect(runModel(mu, u, null)).toBeNull();
    expect(runModel({ "claude-opus-5": big, "claude-opus-5-5": big }, u, "opus")).toBeNull();
  });
  it("no usage to compare: one model or the hint; nothing → null", () => {
    expect(runModel({ "claude-opus-5-5": {} }, null, null)).toBe("claude-opus-5-5");
    expect(runModel({ "claude-haiku-5-5": {}, "claude-opus-5-5": {} }, null, "opus")).toBe("claude-opus-5-5");
    expect(runModel({}, u, "opus")).toBeNull();
    expect(runModel(null, u, "opus")).toBeNull();
  });
});

describe("cumulativeIsThisRun", () => {
  it("a new session's first run: the cumulative is just this run (live t1)", () => {
    expect(cumulativeIsThisRun(T1.usage, T1.modelUsage)).toBe(true);
  });
  it("a resumed one with its earlier turns restored: not (live t2, f1)", () => {
    expect(cumulativeIsThisRun(T2.usage, T2.modelUsage)).toBe(false);
    expect(cumulativeIsThisRun(F1.usage, F1.modelUsage)).toBe(false);
  });
  it("can't tell → false: no usage, no modelUsage, or a zero weight", () => {
    expect(cumulativeIsThisRun(null, T1.modelUsage)).toBe(false);
    expect(cumulativeIsThisRun(T1.usage, null)).toBe(false);
    expect(cumulativeIsThisRun({ input_tokens: 0 }, { m: { inputTokens: 0 } })).toBe(false);
  });
});
