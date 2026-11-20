import {
  checkPrValue, PR_POLICY_GROUPS, prKeyDef, type PrKeyView, type PrPolicyGroup, type PrPolicyKeyDef, type PrPolicyOverrides, type PrPolicyView, type PrValue,
} from "../../shared/pr-policy";
import type { PrAssessmentView, RiskLevel } from "../../shared/prereview";
import { REVIEW_EFFECT_MIN_SAMPLE, type ReviewGroupStats } from "../../shared/review-effect";

/** 「预审和就绪」编辑器的草稿：键 → 输入框里的字（列表一行一条）。"" = 继承。没出现的键 = 没改。 */
export type PrDraft = Record<string, string>;

export function prInputValue(v: PrValue | null): string {
  if (v === null) return "";
  return Array.isArray(v) ? v.join("\n") : String(v);
}

/** 输入框里的字 → 值；"" = 继承。不合法返回 undefined。列表里的空行丢掉，一条都没有也算继承。 */
export function parsePrInput(key: string, raw: string): PrValue | null | undefined {
  const d = prKeyDef(key);
  if (!d) return undefined;
  if (d.kind === "list") {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    try {
      return checkPrValue(key, lines);
    } catch {
      return undefined;
    }
  }
  const t = raw.trim();
  if (t === "") return null;
  const v: unknown = d.kind === "int" ? Number(t) : d.kind === "bool" ? (t === "true" ? true : t === "false" ? false : t) : t;
  try {
    return checkPrValue(key, v);
  } catch {
    return undefined;
  }
}

const same = (a: PrValue | null, b: PrValue | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 这一层的覆盖 + 草稿 → 要保存的整层；有不合法的值时给出第一个坏键。 */
export function prOverridesFromDraft(view: PrPolicyView, draft: PrDraft): { ok: true; overrides: PrPolicyOverrides; changed: boolean } | { ok: false; badKey: string } {
  const out: Record<string, PrValue> = {};
  let changed = false;
  for (const k of view.keys) {
    const raw = draft[k.key];
    if (raw === undefined) {
      if (k.override !== null) out[k.key] = k.override;
      continue;
    }
    const v = parsePrInput(k.key, raw);
    if (v === undefined) return { ok: false, badKey: k.key };
    if (!same(v, k.override)) changed = true;
    if (v !== null) out[k.key] = v;
  }
  return { ok: true, overrides: out as PrPolicyOverrides, changed };
}

/** 按分组排好的键（就绪、证据、风险）。 */
export function prGroups(view: PrPolicyView): { group: PrPolicyGroup; keys: (PrKeyView & { def: PrPolicyKeyDef })[] }[] {
  return PR_POLICY_GROUPS.map((group) => ({
    group,
    keys: view.keys.flatMap((k) => {
      const def = prKeyDef(k.key);
      return def && def.group === group ? [{ ...k, def }] : [];
    }),
  })).filter((g) => g.keys.length > 0);
}

/** 路径类别的键 risk.paths.<类> → 类名；不是路径类的为 null。 */
export function pathClassOf(key: string): string | null {
  const m = /^risk\.paths\.([A-Za-z]+)$/.exec(key);
  return m ? m[1]! : null;
}

/** 一组 PR 的统计够不够看（样本太少时页面上说明，不给数）。 */
export const enoughSample = (g: ReviewGroupStats): boolean => g.prs >= REVIEW_EFFECT_MIN_SAMPLE;

/** ticket 页 Review 标签上一个 PR 的标题：#12 标题，或者分支名。 */
export function assessmentTitle(a: Pick<PrAssessmentView, "number" | "title" | "target">): string {
  if (a.number !== null) return a.title ? `#${a.number} ${a.title}` : `#${a.number}`;
  return a.target?.branch ?? "";
}

/** UTC 毫秒 → 本地日期 YYYY-MM-DD（给效果页的周折线用）。 */
export function dayString(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 风险徽标用哪种底色（和 PR 状态的同一组，对比度测过）。 */
export const riskPill = (l: RiskLevel): string => (l === "high" ? "changes" : l === "medium" ? "pending" : "approved");
