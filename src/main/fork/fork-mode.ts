import type { RegistryModel } from "../../shared/model-routing";
import type { ForkMode } from "../../shared/fork";
import { runCostFromCumulative } from "../../shared/run-cost";
import { usdOf } from "../metrics/rollup";
import type { UsageCounts } from "../usage/usage-parse";

/** 开发 session 的缓存是 1h；留 5 分钟余量，最后一轮离现在超过这么久就当缓存已经过期。 */
export const FULL_FRESH_MS = 55 * 60_000;
/** 精简分叉带的记忆和问答历史的字数上限；加上问题，精简版约 30k token 以内。 */
export const LIGHT_RECALL_CHARS = 8_000;
export const LIGHT_QA_CHARS = 24_000;

export interface ModeInput {
  cacheOk: boolean;
  launchKnown: boolean;
  transcriptExists: boolean;
  devIdle: boolean;
  lastTurnAt: number | null;
  now: number;
}

/** 自动选档：条件全部满足才用完整上下文（读得到开发 session 的缓存，便宜），否则精简。刚好 FULL_FRESH_MS 还算新，多一毫秒就过期。 */
export function chooseMode(i: ModeInput): ForkMode {
  if (!i.cacheOk || !i.launchKnown || !i.transcriptExists || !i.devIdle) return "light";
  if (i.lastTurnAt === null || i.now - i.lastTurnAt > FULL_FRESH_MS) return "light";
  return "full";
}

/** 用完整上下文重问能不能跑：开发 session 在跑 → dev_busy；没有 transcript → no_transcript；否则 null。 */
export function fullBlock(i: { transcriptExists: boolean; devIdle: boolean }): "dev_busy" | "no_transcript" | null {
  if (!i.devIdle) return "dev_busy";
  if (!i.transcriptExists) return "no_transcript";
  return null;
}

/** 按 CLI 给的金额，否则按价格表估；都没有 → { usd: null, partial: true }。金额是不是这一轮的由 turnCost 判断。 */
export function costOf(
  r: { costUsd: number | null; usage: UsageCounts | null; model: string | null },
  registry: readonly RegistryModel[],
): { usd: number | null; partial: boolean } {
  if (r.costUsd !== null) return { usd: r.costUsd, partial: false };
  if (!r.usage) return { usd: null, partial: true };
  const est = usdOf({ ...r.usage, sessionId: null, at: 0, model: r.model, task: null, source: "headless", costUsd: null }, registry);
  return est.partial ? { usd: null, partial: true } : { usd: est.usd, partial: false };
}

/** 一轮怎么起的：fresh 没带 --resume（全新 session）；forked 带 --fork-session（从别的 session 分出来）；resumed 续分叉自己的 session。 */
export type RunStart = "fresh" | "forked" | "resumed";

export function runStart(args: readonly string[]): RunStart {
  if (!args.includes("--resume")) return "fresh";
  return args.includes("--fork-session") ? "forked" : "resumed";
}

/**
 * 一轮的花费。CLI 的 total_cost_usd 和 modelUsage 是被续的那个 session 的累计（--fork-session 时还带着被分叉 session 以前的全部花费），usage 才是这一轮的：
 * fresh 的 total 就是这一轮；resumed 知道上次见到的累计就取差（不小于 0）；
 * 其余（forked，或 resumed 但不知道上次的累计）有 modelUsage 就按份额拆（runCostFromCumulative：只看这一轮的模型 r.model 那一项；
 * 定不下模型而且累计里有好几个模型时按全部模型的权重拆，标 partial），没有再按价格表估。
 * cli：从 CLI 金额算出的这一轮（精确、差值或份额；估出来的为 null）；seenTotal：这一轮之后该记下的累计，CLI 没给金额就不变。
 */
export function turnCost(
  r: { costUsd: number | null; usage: UsageCounts | null; model: string | null; usageRaw?: unknown; modelUsage?: unknown },
  start: RunStart,
  seenTotal: number | null,
  registry: readonly RegistryModel[],
): { usd: number | null; partial: boolean; cli: number | null; seenTotal: number | null } {
  const total = r.costUsd;
  const direct = total === null ? null : start === "fresh" ? total : start === "resumed" && seenTotal !== null ? Math.max(0, total - seenTotal) : null;
  if (direct !== null) return { usd: direct, partial: false, cli: direct, seenTotal: total };
  const share = total === null ? null : runCostFromCumulative(total, r.usageRaw, r.modelUsage, r.model);
  if (share !== null) return { usd: share.usd, partial: share.partial, cli: share.usd, seenTotal: total };
  return { ...costOf({ ...r, costUsd: null }, registry), cli: null, seenTotal: total ?? seenTotal };
}
