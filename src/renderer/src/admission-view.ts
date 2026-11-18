import type { LessonScorePart, LessonScoreParts } from "../../shared/lessons";
import type {
  AdmissionScope, BatchReviewView, CalibrationBandStats, WizardNote, WizardRunView, WizardState, WizardVerdict,
} from "../../shared/lesson-admission";
import { WIZARD_LIVE_STATES } from "../../shared/lesson-admission";
import type { UiStrings } from "./strings";

/** 评分分项按固定顺序展示；cap、composite 放在最后。 */
export const SCORE_PART_ORDER = ["evidence", "clarity", "consistency", "verifiability", "performance", "cap", "composite"] as const satisfies readonly (keyof LessonScoreParts)[];
export type ScorePartKey = (typeof SCORE_PART_ORDER)[number];

export const scorePartRows = (parts: LessonScoreParts | null): { key: ScorePartKey; part: LessonScorePart }[] =>
  parts === null ? [] : SCORE_PART_ORDER.flatMap((key) => (parts[key] ? [{ key, part: parts[key]! }] : []));

export const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

/** 下拉框的值和范围互转：all / repo:<slug> / product:<id>。 */
export const admissionScopeKey = (s: AdmissionScope): string => (s.kind === "all" ? "all" : s.kind === "repo" ? `repo:${s.slug}` : `product:${s.productId}`);
export function admissionScopeFromKey(k: string): AdmissionScope {
  if (k.startsWith("repo:")) return { kind: "repo", slug: k.slice(5) };
  if (k.startsWith("product:")) return { kind: "product", productId: Number(k.slice(8)) };
  return { kind: "all" };
}

export const wizardLive = (state: WizardState): boolean => WIZARD_LIVE_STATES.includes(state);

/** 这个范围最近的一次向导（runs 按 id 从新到旧）。 */
export const latestRunFor = (runs: readonly WizardRunView[], scope: AdmissionScope): WizardRunView | null =>
  runs.filter((r) => admissionScopeKey(r.scope) === admissionScopeKey(scope)).sort((a, b) => b.id - a.id)[0] ?? null;

/** 搁置的按原因分组；每组可以整组拉回或整组拒绝。 */
export function shelvedGroups(verdicts: readonly WizardVerdict[]): { reason: string; lessonIds: number[] }[] {
  const by = new Map<string, number[]>();
  for (const v of verdicts) {
    if (v.verdict !== "shelved" && v.verdict !== "covered") continue;
    const reason = v.verdict === "covered" ? "covered" : (v.reason ?? "other");
    (by.get(reason) ?? by.set(reason, []).get(reason)!).push(v.lessonId);
  }
  return [...by].map(([reason, lessonIds]) => ({ reason, lessonIds })).sort((a, b) => b.lessonIds.length - a.lessonIds.length || a.reason.localeCompare(b.reason));
}

/** 「全部接受」藏起来时的一句话：点名离线最远的那个指标。 */
export function blockedText(review: BatchReviewView, S: UiStrings): string | null {
  if (!review.blocked || review.weakest === null) return null;
  const m = review.metrics.find((x) => x.key === review.weakest)!;
  return S.wizardBlocked(S.batchMetricLabel[m.key], pct(m.value), pct(m.floor), m.bound);
}

export function noteText(n: WizardNote, S: UiStrings): string {
  switch (n.kind) {
    case "scanUnavailable":
      return S.wizardNoteScanUnavailable;
    case "notBacktested":
      return S.wizardNoteNotBacktested;
    case "noGh":
      return S.wizardNoteNoGh;
    case "uncloned":
      return S.wizardNoteUncloned(n.slug);
    case "ghFailed":
      return S.wizardNoteGhFailed(n.slug);
    case "legacyViolations":
      return S.wizardNoteLegacy(n.slug, n.count);
    case "noLint":
      return S.wizardNoteNoLint(n.slug);
  }
}

/** 预计时间：分钟取整，不到一分钟写「不到 1 分钟」。 */
export const durationText = (ms: number | null, S: UiStrings): string => (ms === null ? S.wizardUnknownTime : ms < 60_000 ? S.wizardUnderMinute : S.wizardMinutes(Math.round(ms / 60_000)));

/** 分数段的通过率：判过的里面判「好」的比例。 */
export const bandAgreement = (b: CalibrationBandStats): number | null => (b.marked === 0 ? null : b.good / b.marked);
