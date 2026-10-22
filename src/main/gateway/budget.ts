import { priceFor, type PriceRule } from "../settings/settings-values";
import { NARRATIVE_MAX_TOKENS } from "./narrative";

/** 本地时间当月 1 日 0 点：月度预算从这里开始算。 */
export function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

const DAY_MS = 86_400_000;

/**
 * 审计清理的截止时间：保留期之前的记录删掉，但不早于本月 1 日以后的记录——
 * 本月的花费要留给预算检查（保留期再短也一样）。gateway 每次调用前和启动时都用它。
 */
export function auditCutoff(now: number, retentionDays: number): number {
  return Math.min(now - retentionDays * DAY_MS, monthStart(now));
}

const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** 保守估算：CJK 每字 1 个 token，其余每 3 个字符 1 个。只用于发送前的预算检查和响应缺 usage 时的记账。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3);
}

export function costUsd(price: PriceRule, tokensIn: number, tokensOut: number): number {
  return (tokensIn * price.inputPerMTok + tokensOut * price.outputPerMTok) / 1_000_000;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/**
 * 请求发出去了、但没有可用的 usage（服务商 2xx 收下了但响应用不了；上次退出时还停在 pending）：
 * 可能已经计费，按发出的请求体和输出上限保守记账。
 */
export function sentWithoutUsage(price: PriceRule, sentBody: string, maxOutputTokens = NARRATIVE_MAX_TOKENS): Usage {
  const tokensIn = estimateTokens(sentBody);
  return { tokensIn, tokensOut: maxOutputTokens, costUsd: costUsd(price, tokensIn, maxOutputTokens) };
}

/** 启动时给上次停在 pending 的记录估花费（AuditRepo.failStalePending）。模型在价格表里没有价格时不估，记 0。 */
export function stalePendingCost(prices: readonly PriceRule[]): (row: { model: string; payloadSent: string }) => Usage | null {
  return (row) => {
    const price = priceFor(prices, row.model);
    return price ? sentWithoutUsage(price, row.payloadSent) : null;
  };
}

export type BudgetDecision =
  | { ok: true; price: PriceRule; estimateUsd: number }
  | { ok: false; reason: "no_price" | "over_budget"; message: string };

/** 发送前检查：模型必须有价格；本月已花 + 这次的估算（输入估算 + 输出上限）不能超过预算。 */
export function checkBudget(o: {
  prices: readonly PriceRule[];
  model: string;
  budgetUsd: number;
  spentUsd: number;
  inputText: string;
  maxOutputTokens: number;
}): BudgetDecision {
  const price = priceFor(o.prices, o.model);
  if (!price) return { ok: false, reason: "no_price", message: `价格表里没有模型 ${o.model} 的价格，不会调用` };
  const estimateUsd = costUsd(price, estimateTokens(o.inputText), o.maxOutputTokens);
  // 写成 !(a <= b)：任何 NaN 都按超预算处理（失败即拒绝）。
  if (![o.spentUsd, o.budgetUsd, estimateUsd].every(Number.isFinite) || !(o.spentUsd + estimateUsd <= o.budgetUsd)) {
    return {
      ok: false,
      reason: "over_budget",
      message: `本月已花 $${o.spentUsd.toFixed(4)}，这次预计 $${estimateUsd.toFixed(4)}，会超过预算 $${o.budgetUsd}`,
    };
  }
  return { ok: true, price, estimateUsd };
}
