import type { LlmStatus, PrivacyLevel, SensitiveTerm, TermCategory } from "../../shared/llm";
import { S } from "./strings";

/** 敏感词表 → 文本框内容（一行一个）。 */
export function termsText(terms: readonly SensitiveTerm[], category: TermCategory): string {
  return terms.filter((t) => t.category === category).map((t) => t.term).join("\n");
}

/** 两个文本框 → 敏感词表（去空行；其余规范化在主进程 normalizeTerms 里做）。 */
export function parseTermsText(people: string, others: string): SensitiveTerm[] {
  const lines = (v: string) => v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return [
    ...lines(people).map((term) => ({ term, category: "person" as const })),
    ...lines(others).map((term) => ({ term, category: "term" as const })),
  ];
}

/** 美元金额：不到 1 美分时多显示两位，免得“$0.00”看起来像没花钱。 */
export function formatUsd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** 设置页顶部的提示：哪些原因会让“今日重点”出不来、人名表为空时 redacted 档位的漏网风险，以及完整档位的风险。peopleCount 是敏感词表里人名的数量。 */
export function llmWarnings(s: LlmStatus, level: PrivacyLevel, peopleCount: number): string[] {
  if (level === "off") return [S.llmOff];
  const out: string[] = [];
  if (!s.encryptionAvailable) out.push(S.llmNoEncryption);
  if (s.keyUnreadable) out.push(S.llmKeyUnreadable);
  if (!s.configured) out.push(S.llmNotConfigured);
  else if (!s.priceKnown) out.push(S.llmNoPrice);
  if (s.configured && s.budgetUsd > 0 && s.monthCostUsd >= s.budgetUsd) out.push(S.llmOverBudget(formatUsd(s.monthCostUsd), formatUsd(s.budgetUsd)));
  if (level === "redacted" && peopleCount === 0) out.push(S.privacyPeopleWarning);
  if (level === "full") out.push(S.llmFullWarning);
  return out;
}
