import { describe, expect, it } from "vitest";
import { F1, F2, T1, T2, T3 } from "./__fixtures__/cli-cost";
import { cumulativeWeight, runCostFromCumulative, runWeight } from "./run-cost";

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
  it("sums every model; a model without the split counts all its cache writes at 5m", () => {
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
  it("splits the cumulative total by this run's share of the weighted tokens (live t2)", () => {
    const usd = runCostFromCumulative(T2.total_cost_usd, T2.usage, T2.modelUsage);
    expect(usd).toBeCloseTo((T2.total_cost_usd * 22818.9) / 51460.1, 12);
    expect(usd).toBeCloseTo(0.0022819, 6);
  });
  it("matches each live run's real cost (the difference of the totals): t2, t3, the fork f1 and its follow-up f2", () => {
    for (const [run, before] of [[T2, T1], [T3, T2], [F1, T3], [F2, F1]] as const) {
      expect(runCostFromCumulative(run.total_cost_usd, run.usage, run.modelUsage)).toBeCloseTo(run.total_cost_usd - before.total_cost_usd, 9);
    }
  });
  it("is the whole total when this run is the whole session", () => {
    const mu = { m: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 15039, cacheCreationInputTokens: 10649 } };
    expect(runCostFromCumulative(0.01, T2_USAGE, mu)).toBeCloseTo(0.01, 12);
  });
  // 这一轮比累计还大说明数对不上（比如累计没算全）：夹到 total 等于把以前的花费全算到这一轮头上，所以算不出来。
  it("this run weighing more than the cumulative → null, not clamped to the total", () => {
    const mu = { m: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 15039, cacheCreationInputTokens: 0 } };
    expect(runCostFromCumulative(5.02, T2_USAGE, mu)).toBeNull();
  });
  it("can't tell → null: no total, no usage, no modelUsage, or a zero weight", () => {
    expect(runCostFromCumulative(null, T2.usage, T2.modelUsage)).toBeNull();
    expect(runCostFromCumulative(T2.total_cost_usd, null, T2.modelUsage)).toBeNull();
    expect(runCostFromCumulative(T2.total_cost_usd, T2.usage, undefined)).toBeNull();
    expect(runCostFromCumulative(T2.total_cost_usd, T2.usage, {})).toBeNull();
    expect(runCostFromCumulative(T2.total_cost_usd, T2.usage, { m: { inputTokens: 0 } })).toBeNull();
  });
});
