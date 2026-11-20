import type { RegistryModel } from "../../shared/model-routing";
import type { ForkMode } from "../../shared/fork";
import { cumulativeIsThisRun, runCostFromCumulative, type RunStart } from "../../shared/run-cost";
import { costSinceBase, type CostBase } from "./cost-base";
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

/** 按 CLI 给的金额，否则按价格表估（approx）；都没有 → { usd: null, partial: true }。金额是不是这一轮的由 turnCost 判断。 */
export function costOf(
  r: { costUsd: number | null; usage: UsageCounts | null; model: string | null },
  registry: readonly RegistryModel[],
): { usd: number | null; partial: boolean; approx: boolean } {
  if (r.costUsd !== null) return { usd: r.costUsd, partial: false, approx: false };
  if (!r.usage) return { usd: null, partial: true, approx: false };
  const est = usdOf({ ...r.usage, sessionId: null, at: 0, model: r.model, task: null, source: "headless", costUsd: null }, registry);
  return est.partial ? { usd: null, partial: true, approx: false } : { usd: est.usd, partial: false, approx: true };
}

export { runStart, type RunStart } from "../../shared/run-cost";

/** turnCost 要的那部分结果。 */
type TurnRun = { costUsd: number | null; usage: UsageCounts | null; model: string | null; usageRaw?: unknown; modelUsage?: unknown };
/**
 * 一轮的花费（见 turnCost）。partial：有一部分没算进去（只会偏低）；approx：是约数，可能偏高也可能偏低——
 * 按份额从累计里拆的（run-cost 的权重不是真实的价格比）和按价格表估的都是。准数只有：fresh 的 total、续 session 的差值、
 * 读得到开发 session 存的累计时分叉第一轮的 T1 − base。
 */
export type TurnCost = { usd: number | null; partial: boolean; approx: boolean; cli: number | null; seenTotal: number | null };

/** total 比上次见到的小多少算浮点误差。 */
const TOTAL_EPS = 1e-9;

export interface TurnCostOpts {
  /** 这一轮的结果是出错的。出错的结果不把见过的累计往回拉（启动就出错时 CLI 可能报 0，记下来下一轮的差值就成了整个累计）；往上走的照记。 */
  failed?: boolean;
  /**
   * forked 的那一轮：被分叉的 session 存下的累计（它 transcript 里最后一条 cost-state，见 cost-base），起跑前读、跑完核对过没变。
   * CLI 分叉时从它接着记，所以这一轮 = T1 − base。null / 不传是读不到或者变了。
   */
  base?: CostBase | null;
}

/**
 * 一轮的花费。CLI 的 total_cost_usd 和 modelUsage 是被续的那个 session 的累计（--fork-session 时还带着被分叉 session 以前的全部花费），usage 才是这一轮的：
 * fresh 的 total 就是这一轮；forked 有 base 就取 T1 − base；resumed 知道上次见到的累计就取差；
 * 其余（forked 没有 base，或 resumed 但不知道上次的累计）有 modelUsage 就按份额拆（runCostFromCumulative：只看这一轮的模型 r.model 那一项；
 * 定不下模型而且累计里有好几个模型时按全部模型的权重拆，标 partial），没有再按价格表估。
 * forked 的 base 用不上、退回份额的情形见 costSinceBase：base 比 T1 还大、核对不上 CLI 真的从 base 接着记、或者减出来比份额少得离谱。
 * resumed 取差之前先看 CLI 有没有读回费用状态：total 比上次见到的小，或者累计里只有这一轮（cumulativeIsThisRun），说明它从 0 记起了，
 * 差值是错的（会悄悄记成 0 或少算），改按份额拆（拆不出再估），标 partial。
 * cli：从 CLI 金额算出的这一轮（精确、差值或份额；估出来的为 null）；seenTotal：这一轮之后该记下的累计，null 是不知道（下一轮按份额拆）。
 * CLI 没给金额时：续的这一轮什么都没记就不变，估了价、或者是新 session，就是 null。
 */
export function turnCost(
  r: TurnRun,
  start: RunStart,
  seenTotal: number | null,
  registry: readonly RegistryModel[],
  o: TurnCostOpts = {},
): TurnCost {
  const c = turnCostOf(r, start, seenTotal, registry, o.base ?? null);
  return o.failed && seenTotal !== null && c.seenTotal !== null && c.seenTotal < seenTotal ? { ...c, seenTotal } : c;
}

function turnCostOf(
  r: TurnRun,
  start: RunStart,
  seenTotal: number | null,
  registry: readonly RegistryModel[],
  base: CostBase | null,
): TurnCost {
  const total = r.costUsd;
  const estimate = () => costOf({ ...r, costUsd: null }, registry);
  if (total === null) {
    // 没有累计可记。估了价的话，这一轮仍在 CLI 的累计里：留着上次的，下一轮的差值会把它再算一遍，所以忘掉（下一轮按份额拆）；
    // 什么都没记就留着，下一轮的差值正好补上这一轮。fresh、forked 是新 session，之前见过的是别的 session 的（比如第一轮失败后丢掉的那个），也忘掉。
    const est = estimate();
    return { ...est, cli: null, seenTotal: start === "resumed" && est.usd === null ? seenTotal : null };
  }
  if (start === "fresh") return { usd: total, partial: false, approx: false, cli: total, seenTotal: total };
  const exact = start === "forked" ? costSinceBase(r, base) : null;
  if (exact !== null) return { usd: exact, partial: false, approx: false, cli: exact, seenTotal: total };
  const share = runCostFromCumulative(total, r.usageRaw, r.modelUsage, r.model);
  if (start === "resumed" && seenTotal !== null) {
    const lost = total < seenTotal - TOTAL_EPS || cumulativeIsThisRun(r.usageRaw, r.modelUsage);
    if (!lost) {
      const diff = Math.max(0, total - seenTotal);
      return { usd: diff, partial: false, approx: false, cli: diff, seenTotal: total };
    }
    if (share !== null) return { usd: share.usd, partial: true, approx: true, cli: share.usd, seenTotal: total };
    return { ...estimate(), partial: true, cli: null, seenTotal: total };
  }
  if (share !== null) return { usd: share.usd, partial: share.partial, approx: true, cli: share.usd, seenTotal: total };
  return { ...estimate(), cli: null, seenTotal: total };
}
