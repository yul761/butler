// 预审结果送进开发 session 的正文（设计 §4.5）：只有违规清单和证据缺口，不附规矩全文。
import type { EvidenceGap, Violation } from "../../shared/prereview";
import { CAT } from "../assess/readiness";
import type { Lang } from "./model";

/** 一次最多列这么多条违规（多的写一句「还有 N 条」，session 用 pre_review_result 取全部）。 */
export const DELIVERY_MAX_VIOLATIONS = 20;
const WHAT_CHARS = 300;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const where = (v: Violation): string => `${v.file}${v.line !== null ? `:${v.line}` : ""}`;


export function gapLine(g: EvidenceGap, lang: Lang): string {
  const c = CAT[lang][g.category];
  if (lang === "en") return g.state === "missing" ? `missing ${c}${g.detail ? ` (${g.detail})` : ""}` : g.state === "explained" ? `${c} not run: ${g.detail}` : `${c} does not match: ${g.detail}`;
  return g.state === "missing" ? `缺${c}${g.detail ? `（${g.detail}）` : ""}` : g.state === "explained" ? `${c}没跑：${g.detail}` : `${c}对不上：${g.detail}`;
}

export interface DeliveryInput {
  shortSha: string;
  verdict: "clean" | "violations" | "error";
  violations: Violation[];
  /** 要的证据的缺口（已说明的不列）。 */
  gaps: EvidenceGap[];
  /** 预审出错时的原因。 */
  error: string | null;
  lang: Lang;
}

/** 递送正文；clean 而且证据没缺口时只有一行。 */
export function deliveryText(i: DeliveryInput): string {
  const en = i.lang === "en";
  const gaps = i.gaps.filter((g) => g.state !== "explained");
  if (i.verdict === "error") {
    return en
      ? `Butler pre-review of ${i.shortSha} could not finish (${i.error ?? "unknown error"}). Nothing to fix from it; you can carry on.`
      : `Butler 对 ${i.shortSha} 的预审没做完（${i.error ?? "原因不明"}）。没有要你改的，可以继续。`;
  }
  if (i.verdict === "clean" && gaps.length === 0 && i.violations.length === 0) {
    return en ? `Butler pre-review of ${i.shortSha} passed.` : `Butler 预审通过（${i.shortSha}）。`;
  }
  const lines: string[] = [];
  lines.push(
    en
      ? `Butler pre-review of ${i.shortSha}: ${i.verdict === "clean" ? "no blocking violations" : "found violations"}.`
      : `Butler 预审（${i.shortSha}）：${i.verdict === "clean" ? "没有必须改的违规" : "有违规"}。`,
  );
  if (i.violations.length) {
    lines.push("", en ? "Violations (file:line, what is wrong, how to fix):" : "违规（文件:行、哪里不对、怎么改）：");
    for (const v of i.violations.slice(0, DELIVERY_MAX_VIOLATIONS)) {
      const tag = v.severity === "must" ? (en ? "must" : "必须") : en ? "should" : "建议";
      lines.push(`- [${tag}] ${where(v)}: ${cut(v.what, WHAT_CHARS)}${v.fix ? ` → ${cut(v.fix, WHAT_CHARS)}` : ""}`);
    }
    const more = i.violations.length - DELIVERY_MAX_VIOLATIONS;
    if (more > 0) lines.push(en ? `- …and ${more} more (call pre_review_result for all of them).` : `- …还有 ${more} 条（调 pre_review_result 看全部）。`);
  }
  if (gaps.length) {
    lines.push("", en ? "Evidence:" : "证据：");
    for (const g of gaps) lines.push(`- ${gapLine(g, i.lang)}`);
  }
  lines.push("", en ? "Fix these, commit, then call submit_evidence again." : "改完、提交以后再调一次 submit_evidence。");
  return lines.join("\n");
}
