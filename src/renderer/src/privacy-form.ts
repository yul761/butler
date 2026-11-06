import type { LlmStatus, PrivacyLevel } from "../../shared/llm";
import { S } from "./strings";

/** 美元金额：不到 1 美分时多显示两位，免得“$0.00”看起来像没花钱。 */
export function formatUsd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/**
 * 设置页顶部的提示。个人 API 只用于完整档位下的 StateCore 记忆蒸馏：关闭和低于完整的档位各说一句就够了；
 * 完整档位下列出会让蒸馏跑不起来的原因，最后说明这一档会发什么。
 */
export function llmWarnings(s: LlmStatus, level: PrivacyLevel): string[] {
  if (level === "off") return [S.llmOff];
  if (level !== "full") return [S.llmNotFull];
  const out: string[] = [];
  if (!s.encryptionAvailable) out.push(S.llmNoEncryption);
  if (s.keyUnreadable) out.push(S.llmKeyUnreadable);
  if (!s.configured) out.push(S.llmNotConfigured);
  else if (!s.priceKnown) out.push(S.llmNoPrice);
  // 预算 0 在后端等于“一次都不调用”（budget.ts 要求 已花 + 预估 ≤ 预算），要说出来，不然界面上看不出为什么没有蒸馏。
  if (s.configured && s.budgetUsd <= 0) out.push(S.llmZeroBudget);
  else if (s.configured && s.monthCostUsd >= s.budgetUsd) out.push(S.llmOverBudget(formatUsd(s.monthCostUsd), formatUsd(s.budgetUsd)));
  out.push(S.llmFullWarning);
  return out;
}
