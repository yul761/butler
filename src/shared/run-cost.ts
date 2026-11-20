/**
 * 从 CLI 的累计金额拆出这一轮的花费。
 * claude -p 续一个 session（--resume，带不带 --fork-session）时，total_cost_usd 和 modelUsage 都是整个 session 的累计，usage 才是这一轮的。
 * 按价格权重折算 token：这一轮占累计的比例 × 累计金额 = 这一轮的金额。各档价格之比在各模型间一样，所以不用知道单价。
 * 纯函数，不依赖分叉或 main 的任何东西（handoff 的用量行以后也用它）。
 */

/** 和用量页同一套权重（input 为 1）；写缓存哪部分算 5m、哪部分算 1h 见 writes。 */
const W = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * 缓存写入，照 CLI 自己给 costUSD 计价的规则：明确记成 1h 的按 1h 价，其余一律按 5m 价——包括分档加起来不到总写入的余量
 * （CLI 的说明：不报写入活多久的回复两档都不进；旧版 CLI 跑的那段没记分档），以及完全没有分档时的全部写入（usage-parse 也是这样）。
 * 分子（这一轮的 usage 没有 cache_creation 对象）和分母（modelUsage 没有分档字段）用的是同一条规则：份额要跟 costUSD 实际怎么累加起来的一致，
 * 而 CLI 对不知道 TTL 的写入记的就是 5m 价，所以两边都按 5m，比按开发 session 常用的 1h 去猜更准。总写入取 total 和分档之和里大的那个（字段缺了也不丢）。
 */
const writes = (total: unknown, split1h: unknown, split5m: unknown): number => {
  const h = num(split1h);
  const all = Math.max(num(total), h + num(split5m));
  return W.cacheWrite1h * h + W.cacheWrite5m * (all - h);
};

/** 这一轮 usage（API 的 snake_case 形状）的加权 token；不是对象为 null。 */
export function runWeight(usage: unknown): number | null {
  if (!isObj(usage)) return null;
  const cc = isObj(usage.cache_creation) ? usage.cache_creation : {};
  return (
    W.input * num(usage.input_tokens) +
    W.cacheRead * num(usage.cache_read_input_tokens) +
    writes(usage.cache_creation_input_tokens, cc.ephemeral_1h_input_tokens, cc.ephemeral_5m_input_tokens) +
    W.output * num(usage.output_tokens)
  );
}

/** modelUsage（各模型的累计，camelCase）加权 token 的总和；不是对象为 null。 */
export function cumulativeWeight(modelUsage: unknown): number | null {
  if (!isObj(modelUsage)) return null;
  let sum = 0;
  for (const m of Object.values(modelUsage)) {
    if (!isObj(m)) continue;
    sum +=
      W.input * num(m.inputTokens) +
      W.cacheRead * num(m.cacheReadInputTokens) +
      writes(m.cacheCreationInputTokens, m.cacheCreationEphemeral1hInputTokens, m.cacheCreationEphemeral5mInputTokens) +
      W.output * num(m.outputTokens);
  }
  return sum;
}

/** modelUsage 某个模型的写缓存总数：cacheCreationInputTokens 和分档之和里大的那个。 */
const writeTotal = (m: Record<string, unknown>): number =>
  Math.max(num(m.cacheCreationInputTokens), num(m.cacheCreationEphemeral1hInputTokens) + num(m.cacheCreationEphemeral5mInputTokens));

/** 这个模型的累计装得下这一轮的 usage（每一类 token 都不比这一轮少）。这一轮的主模型一定装得下：累计里有这一轮。 */
const holds = (m: Record<string, unknown>, u: Record<string, unknown>): boolean =>
  num(m.inputTokens) >= num(u.input_tokens) && num(m.outputTokens) >= num(u.output_tokens) &&
  num(m.cacheReadInputTokens) >= num(u.cache_read_input_tokens) && writeTotal(m) >= num(u.cache_creation_input_tokens);

const bare = (s: string): string => s.toLowerCase().replace(/\[[^\]]*\]$/, "");

/** 启动参数里的模型名（全名、带 [1m] 的、或 opus 这样的别名）是不是 modelUsage 的这个键。 */
function sameModel(hint: string, key: string): boolean {
  const h = bare(hint);
  const k = bare(key);
  if (h === k || k.startsWith(`${h}-`)) return true;
  return /^[a-z]+$/.test(h) && (k.startsWith(`${h}-`) || k.includes(`-${h}-`) || k.endsWith(`-${h}`));
}

/**
 * 这一轮的主模型在 modelUsage 里的键。结果里没有直接写这一轮用的是哪个模型，只能推：
 * 累计装得下这一轮 usage 的模型只有一个，就是它（主模型一定装得下）；有好几个时用 hint（这一轮的 --model）在它们里面挑，正好对上一个才算。
 * usage 不是对象时所有模型都算装得下。定不下来 → null，不猜（续 session 时第一个键是那个 session 最早用的模型）。
 */
export function runModel(modelUsage: unknown, runUsage: unknown, hint: string | null): string | null {
  if (!isObj(modelUsage)) return null;
  const keys = Object.keys(modelUsage).filter((k) => isObj(modelUsage[k]));
  const fits = isObj(runUsage) ? keys.filter((k) => holds(modelUsage[k] as Record<string, unknown>, runUsage)) : keys;
  if (fits.length === 1) return fits[0];
  const named = hint ? fits.filter((k) => sameModel(hint, k)) : [];
  return named.length === 1 ? named[0] : null;
}

/** 这一轮的权重比累计还大多少算浮点误差。 */
const OVER = 1e-9;

/**
 * 这一轮的美元 = 累计金额 × w(这一轮 usage) / Σ w(modelUsage)。
 * 缺累计金额、usage 或 modelUsage，或累计权重为 0 → null（算不出来）。
 * 这一轮比累计还重（超过浮点误差）说明数对不上，也是 null：夹到累计金额等于把以前的花费全算到这一轮头上。
 */
export function runCostFromCumulative(totalUsd: number | null, runUsage: unknown, modelUsage: unknown): number | null {
  if (totalUsd === null || !Number.isFinite(totalUsd)) return null;
  const run = runWeight(runUsage);
  const all = cumulativeWeight(modelUsage);
  if (run === null || all === null || all <= 0 || run > all * (1 + OVER)) return null;
  return Math.max(0, totalUsd * Math.min(1, run / all));
}
