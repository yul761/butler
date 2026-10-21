import { priceFor, type PriceRule } from "../settings/settings-values";

/** 本地时间当月 1 日 0 点：月度预算从这里开始算。 */
export function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
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
