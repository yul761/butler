import type { RegistryModel } from "../../shared/model-routing";
import type { ForkMode } from "../../shared/fork";
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

/** 一轮的花费：CLI 给了 total_cost_usd 用它；否则按价格表估；都没有 → { usd: null, partial: true }。 */
export function costOf(
  r: { costUsd: number | null; usage: UsageCounts | null; model: string | null },
  registry: readonly RegistryModel[],
): { usd: number | null; partial: boolean } {
  if (r.costUsd !== null) return { usd: r.costUsd, partial: false };
  if (!r.usage) return { usd: null, partial: true };
  const est = usdOf({ ...r.usage, sessionId: null, at: 0, model: r.model, task: null, source: "headless", costUsd: null }, registry);
  return est.partial ? { usd: null, partial: true } : { usd: est.usd, partial: false };
}
