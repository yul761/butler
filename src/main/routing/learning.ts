import type { LimitKind } from "../../shared/availability";
import type { LimitRule } from "../../shared/model-routing";
import { escapeRe } from "./rules";

/** 「同一个模型连续失败、而别的模型成功」要几次才算疑似限额。 */
export const CORRELATED_FAILURES = 3;
const LINE_MAX = 200;

/** 每行去掉会变的部分：数字、request id、十六进制串、时间戳。 */
function normalizeLine(l: string): string {
  return l
    .replace(/\breq_[A-Za-z0-9]+/g, "req_*")
    .replace(/\b[0-9a-f]{8,}\b/gi, "*")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const KEYWORD = /limit|quota|billing|credit|exceed|exhaust|denied|insufficient|429|402|529|error/i;

/** 报错里最像「原因」的一行：带关键词的第一行，否则第一行非空的。 */
export function distinctiveLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return (lines.find((l) => KEYWORD.test(l)) ?? lines[0] ?? "").slice(0, LINE_MAX);
}

/** 同一种报错的指纹：最像原因的那一行，去掉会变的部分。 */
export function fingerprint(text: string): string {
  return normalizeLine(distinctiveLine(text)).slice(0, LINE_MAX);
}

/**
 * 把一条报错变成识别规则：最像原因的那一行，转义成正则，数字串换成 \d+、request id 和十六进制串换成通配。
 * 生成的规则一定能认出原来那段文字（有测试）。
 */
export function ruleFromSample(sample: string, category: LimitKind, accountLevel: boolean, id: string): LimitRule {
  const line = distinctiveLine(sample);
  const tokens = line.split(/(\breq_[A-Za-z0-9]+|\b[0-9a-f]{8,}\b|\d+)/i);
  const pattern = tokens
    .map((tok, i) => {
      if (i % 2 === 0) return escapeRe(tok).replace(/\s+/g, "\\s+");
      if (/^req_/i.test(tok)) return "req_[A-Za-z0-9]+";
      if (/^\d+$/.test(tok)) return "\\d+";
      return "[0-9a-f]+";
    })
    .join("");
  return { id, kind: "regex", pattern, category, accountLevel, source: "learned", enabled: true, note: line.slice(0, 120) };
}

/** 这个模型的连续失败和别的模型的最近成功：够不够判成「这个模型被限额了」。 */
export function correlatedLimit(
  failing: { consecutiveFailures: number; failureStreakSince: number | null },
  othersLastSuccess: readonly (number | null)[],
): boolean {
  if (failing.consecutiveFailures < CORRELATED_FAILURES || failing.failureStreakSince === null) return false;
  const since = failing.failureStreakSince;
  return othersLastSuccess.some((t) => t !== null && t >= since);
}
