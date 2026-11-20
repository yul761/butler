/**
 * 从 CLI 的累计金额拆出这一轮的花费。
 * claude -p 续一个 session（--resume，带不带 --fork-session）时，total_cost_usd 和 modelUsage 都是整个 session 的累计，usage 才是这一轮的。
 * 按价格权重折算 token：这一轮占累计的比例 × 累计金额 = 这一轮的金额。各档价格之比在各模型间一样，所以不用知道单价。
 * 纯函数，不依赖分叉或 main 的任何东西（handoff 的用量行以后也用它）。
 */

/** 和用量页同一套权重（input 为 1）。 */
const W = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** 缓存写入：有 5m/1h 分档就按分档；没有就全部按 1h 算（开发 session 用的是 1h 缓存）。 */
const writes = (split5m: unknown, split1h: unknown, total: unknown, hasSplit: boolean): number =>
  hasSplit ? W.cacheWrite5m * num(split5m) + W.cacheWrite1h * num(split1h) : W.cacheWrite1h * num(total);

/** 这一轮 usage（API 的 snake_case 形状）的加权 token；不是对象为 null。 */
export function runWeight(usage: unknown): number | null {
  if (!isObj(usage)) return null;
  const cc = usage.cache_creation;
  const split = isObj(cc);
  return (
    W.input * num(usage.input_tokens) +
    W.cacheRead * num(usage.cache_read_input_tokens) +
    writes(split ? cc.ephemeral_5m_input_tokens : 0, split ? cc.ephemeral_1h_input_tokens : 0, usage.cache_creation_input_tokens, split) +
    W.output * num(usage.output_tokens)
  );
}

/** modelUsage（各模型的累计，camelCase）加权 token 的总和；不是对象为 null。 */
export function cumulativeWeight(modelUsage: unknown): number | null {
  if (!isObj(modelUsage)) return null;
  let sum = 0;
  for (const m of Object.values(modelUsage)) {
    if (!isObj(m)) continue;
    const split = "cacheCreationEphemeral5mInputTokens" in m || "cacheCreationEphemeral1hInputTokens" in m;
    sum +=
      W.input * num(m.inputTokens) +
      W.cacheRead * num(m.cacheReadInputTokens) +
      writes(m.cacheCreationEphemeral5mInputTokens, m.cacheCreationEphemeral1hInputTokens, m.cacheCreationInputTokens, split) +
      W.output * num(m.outputTokens);
  }
  return sum;
}

/**
 * 这一轮的美元 = 累计金额 × w(这一轮 usage) / Σ w(modelUsage)。
 * 缺累计金额、usage 或 modelUsage，或累计权重为 0 → null（算不出来）。不会超过累计金额。
 */
export function runCostFromCumulative(totalUsd: number | null, runUsage: unknown, modelUsage: unknown): number | null {
  if (totalUsd === null || !Number.isFinite(totalUsd)) return null;
  const run = runWeight(runUsage);
  const all = cumulativeWeight(modelUsage);
  if (run === null || all === null || all <= 0) return null;
  return Math.max(0, totalUsd * Math.min(1, run / all));
}
