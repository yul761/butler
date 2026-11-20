/**
 * 从 CLI 的累计金额拆出这一轮的花费。
 * claude -p 续一个 session（--resume，带不带 --fork-session）时，total_cost_usd 和 modelUsage 都是整个 session 的累计，usage 才是这一轮的。
 * 按价格权重折算 token：这一轮占这个模型累计权重的比例 × 这个模型的累计金额（modelUsage[m].costUSD）≈ 这一轮的金额，不用知道单价。
 * 结果只是约数，调用方要按约数显示。W 是一套固定的权重，真实的价格比却因模型、因用法而异：CLI 2.1.329 的价格表里读缓存是 input 的
 * 0.05（opus-5-5、sonnet-5-5）或 0.025（fable-5-2），haiku-5-5 过 100k token 后单价 ×5，fast 模式另有一套价格。
 * 这一轮的 token 构成跟累计的平均构成差得越多，拆出来的偏差越大：按真实历史试算，完整分叉第一轮会偏 −17% 到 +38%；只有像测试样本那样
 * 小 prompt 的 haiku 正好对得上。能取差的地方就别用它：续 session 取两次 total 的差；分叉的第一轮取 T1 − 开发 session transcript 最后一条
 * cost-state 的 totalCostUSD（fork-mode 的 turnCost，BTL-239）。
 * 跨模型更不行：opus 和 haiku 的单价差好几倍，所以只拿这一轮的主模型那一项来拆，不把各模型的权重加在一起。
 * 纯函数，不依赖分叉或 main 的任何东西（分叉讨论、handoff、feature 汇总的用量行都用它）。
 */

/** 一轮怎么起的：fresh 没带 --resume（全新 session）；forked 带 --fork-session（从别的 session 分出来）；resumed 续一个已有的 session。 */
export type RunStart = "fresh" | "forked" | "resumed";

export function runStart(args: readonly string[]): RunStart {
  if (!args.includes("--resume")) return "fresh";
  return args.includes("--fork-session") ? "forked" : "resumed";
}

/** 和用量页同一套权重（input 为 1）。只是一套固定的近似，不是哪个模型真实的价格比（见文件头）；写缓存哪部分算 5m、哪部分算 1h 见 writes。 */
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

/** 一个模型累计的加权 token。 */
const modelWeight = (m: Record<string, unknown>): number =>
  W.input * num(m.inputTokens) +
  W.cacheRead * num(m.cacheReadInputTokens) +
  writes(m.cacheCreationInputTokens, m.cacheCreationEphemeral1hInputTokens, m.cacheCreationEphemeral5mInputTokens) +
  W.output * num(m.outputTokens);

/** modelUsage（各模型的累计，camelCase）加权 token 的总和；不是对象为 null。 */
export function cumulativeWeight(modelUsage: unknown): number | null {
  if (!isObj(modelUsage)) return null;
  let sum = 0;
  for (const m of Object.values(modelUsage)) if (isObj(m)) sum += modelWeight(m);
  return sum;
}

/** 从累计拆出来的这一轮金额，总是约数（W 不是真实的价格比）。partial：拆的时候还没能只看这一轮的模型，偏差更大。 */
export interface RunCost {
  usd: number;
  partial: boolean;
}

/** part / whole 拆 amount；part 比 whole 还大（超过浮点误差）说明数对不上 → null，夹到 amount 等于把以前的花费全算到这一轮头上。 */
const shareOf = (amount: number, part: number, whole: number): number | null =>
  whole <= 0 || part > whole * (1 + OVER) ? null : Math.max(0, amount * Math.min(1, part / whole));

/**
 * 这一轮的金额，从 CLI 的累计里拆出来。
 * - 定得出这一轮的主模型 m（runModel，hint 是这一轮的 --model 或已经推出来的键）而且它有 costUSD：costUSD_m × w(usage) / w(modelUsage[m])，
 *   不标 partial，但仍是约数（W 不是这个模型真实的价格比）。
 * - 否则退回 totalUsd × w(usage) / Σ w(modelUsage)：只有一个模型有权重时一样准；有好几个时是按全 session 的平均单价定价，标 partial。
 *   不退回价格表估：那也要知道模型，而且默认价格表没有价格；这个数至少出自 CLI 自己的金额，也不会超过累计。
 * 缺 usage 或 modelUsage、权重为 0、这一轮比累计还重，或者两条路都缺金额 → null（算不出来）。
 * 已知限制：usage 只有主循环（CLI 的说明："MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls"），
 * 而 costUSD / total 含 subagent、辅助调用（compaction 等）和 web search 的费用（web search 按次计价，不在 token 权重里）。
 * 这一轮里这些花费拆不出来，份额会偏小；它们落在别的模型上时完全不算，落在同一个模型上时只会摊薄分母。
 */
export function runCostFromCumulative(totalUsd: number | null, runUsage: unknown, modelUsage: unknown, hint: string | null): RunCost | null {
  const run = runWeight(runUsage);
  if (run === null || !isObj(modelUsage)) return null;
  const m = runModel(modelUsage, runUsage, hint);
  const entry = m === null ? null : (modelUsage[m] as Record<string, unknown>);
  const cost = entry && typeof entry.costUSD === "number" && Number.isFinite(entry.costUSD) && entry.costUSD >= 0 ? entry.costUSD : null;
  if (entry && cost !== null) {
    const usd = shareOf(cost, run, modelWeight(entry));
    return usd === null ? null : { usd, partial: false };
  }
  if (totalUsd === null || !Number.isFinite(totalUsd)) return null;
  const weights = Object.values(modelUsage).filter(isObj).map(modelWeight);
  const usd = shareOf(totalUsd, run, weights.reduce((a, b) => a + b, 0));
  return usd === null ? null : { usd, partial: weights.filter((w) => w > 0).length > 1 };
}

/**
 * 累计里只有这一轮：Σ w(modelUsage) 和 w(usage) 一样（差在浮点误差以内）。续 session 时这说明 CLI 没读回那个 session 存的费用状态，
 * total 是从 0 记起的（"continues from the total its transcript saved, when it has one"）。之前的轮次总有权重，所以读回来了就一定比这一轮大。
 * 这一轮里起了 subagent 或辅助调用时累计会比 usage 大，判断不出来（返回 false）。缺 usage、modelUsage，或权重为 0 → false。
 */
export function cumulativeIsThisRun(runUsage: unknown, modelUsage: unknown): boolean {
  const run = runWeight(runUsage);
  const all = cumulativeWeight(modelUsage);
  return run !== null && all !== null && run > 0 && all <= run * (1 + OVER);
}
