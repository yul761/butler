import { describe, expect, it } from "vitest";
import { cumulativeWeight, runCostFromCumulative, runWeight } from "./run-cost";

// 实测的 t2：完整上下文的接着问，total_cost_usd 和 modelUsage 都是累计的，usage 是这一轮的
const T2_TOTAL = 0.00514601;
const T2_MODEL_USAGE = {
  "claude-haiku-5": { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 26881, cacheCreationInputTokens: 24369, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 24369, costUSD: 0.00514601 },
};
const T2_USAGE = { input_tokens: 2, cache_read_input_tokens: 15039, cache_creation_input_tokens: 10649, output_tokens: 3 };

describe("runWeight / cumulativeWeight", () => {
  it("weighs the live t2 numbers: modelUsage w = 51460, this run's usage with all cache writes at 1h", () => {
    expect(cumulativeWeight(T2_MODEL_USAGE)).toBeCloseTo(51460.1, 6);
    expect(runWeight(T2_USAGE)).toBeCloseTo(2 + 1503.9 + 2 * 10649 + 15, 6);
  });
  it("uses the 5m/1h split of this run's cache writes when the CLI gives one", () => {
    const u = { ...T2_USAGE, cache_creation: { ephemeral_5m_input_tokens: 649, ephemeral_1h_input_tokens: 10000 } };
    expect(runWeight(u)).toBeCloseTo(2 + 1503.9 + 1.25 * 649 + 2 * 10000 + 15, 6);
  });
  it("sums every model; a model without the split counts all its cache writes at 1h", () => {
    const mu = {
      a: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 100, cacheCreationEphemeral5mInputTokens: 4, cacheCreationEphemeral1hInputTokens: 8 },
      b: { inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 3 },
    };
    expect(cumulativeWeight(mu)).toBeCloseTo(10 + 5 + 10 + 1.25 * 4 + 2 * 8 + 1 + 2 * 3, 6);
  });
  it("not an object → null", () => {
    expect(runWeight(null)).toBeNull();
    expect(cumulativeWeight(undefined)).toBeNull();
    expect(cumulativeWeight([1])).toBeNull();
  });
});

describe("runCostFromCumulative", () => {
  it("splits the cumulative total by this run's share of the weighted tokens (live t2)", () => {
    const usd = runCostFromCumulative(T2_TOTAL, T2_USAGE, T2_MODEL_USAGE);
    expect(usd).toBeCloseTo((T2_TOTAL * 22818.9) / 51460.1, 12);
    expect(usd).toBeCloseTo(0.0022819, 6);
  });
  it("never exceeds the total when this run is the whole session", () => {
    const mu = { m: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 15039, cacheCreationInputTokens: 10649 } };
    expect(runCostFromCumulative(0.01, T2_USAGE, mu)).toBeCloseTo(0.01, 12);
  });
  it("can't tell → null: no total, no usage, no modelUsage, or a zero weight", () => {
    expect(runCostFromCumulative(null, T2_USAGE, T2_MODEL_USAGE)).toBeNull();
    expect(runCostFromCumulative(T2_TOTAL, null, T2_MODEL_USAGE)).toBeNull();
    expect(runCostFromCumulative(T2_TOTAL, T2_USAGE, undefined)).toBeNull();
    expect(runCostFromCumulative(T2_TOTAL, T2_USAGE, {})).toBeNull();
    expect(runCostFromCumulative(T2_TOTAL, T2_USAGE, { m: { inputTokens: 0 } })).toBeNull();
  });
});
