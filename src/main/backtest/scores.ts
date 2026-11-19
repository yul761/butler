// 检查的分数（工作流 F 第 5 节）：上线后的表现分（采纳、准确、没被绕过、同类评论减少）和检查的综合分（没回测的封顶）。
// 每次复查（review tick）重算写 check_scores，不写进 lessons（变得勤，写进去会让接受那一批没法撤销）。纯函数。
import type { AdmissionPolicy, AdmissionPolicyKey } from "../../shared/admission-policy";
import type { CheckScoreView } from "../../shared/backtest";
import type { LessonScoreParts } from "../../shared/lessons";
import { compositeOf, type ScoreInput } from "../lessons/admission/score";
import type { LessonCommentTrend } from "../review-effect/stats";

const num = (p: AdmissionPolicy, k: AdmissionPolicyKey) => Number(p[k]);
const round = (v: number) => Math.round(v * 1000) / 1000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 一条检查从 modeSince 起的数据。 */
export interface PerformanceInput {
  fails: number;
  /** 编辑时的失败（采纳率的分母；push 检查没有「改好了」的记录）。没给就用 fails。 */
  editFails?: number;
  resolved: number;
  /** 人标的误报。 */
  falsePositives: number;
  /** 正在强制（绕过率只对它有意义）。 */
  enforce: boolean;
  /** 拦下的失败。 */
  blocked: number;
  bypasses: number;
  /** 拦下以后没理会的。 */
  ignored: number;
  trend: LessonCommentTrend | null;
}

export interface PerformanceResult {
  value: number;
  inputs: { adoption?: number; precision?: number; bypass?: number; trend?: number };
}

/**
 * 同类评论的趋势：每个 PR 的评论少了一半及以上 → 1，没变 → 0.5，多了一半及以上 → 0。
 * 只有之后的 PR 够 demote.noReductionPrs、之前有 PR 时才算。之前是 0：之后也是 0 算没变，之后有算变多。
 */
export function trendValue(t: LessonCommentTrend | null, p: AdmissionPolicy): number | null {
  if (!t || t.before.prs <= 0 || t.after.prs < num(p, "demote.noReductionPrs")) return null;
  const b = t.before.perPr;
  const a = t.after.perPr;
  if (b === null || a === null) return null;
  if (b === 0) return a === 0 ? 0.5 : 0;
  return round(clamp01(0.5 + (b - a) / b));
}

/** 表现分：有足够数据的几项（shadow.minHits 条失败）取平均；一项都没有返回 null。 */
export function performanceOf(i: PerformanceInput, p: AdmissionPolicy): PerformanceResult | null {
  const inputs: PerformanceResult["inputs"] = {};
  if (i.fails >= Math.max(1, num(p, "shadow.minHits"))) {
    const adoptable = i.editFails ?? i.fails;
    if (adoptable > 0) inputs.adoption = round(Math.min(1, i.resolved / adoptable));
    inputs.precision = round(clamp01(1 - i.falsePositives / i.fails));
    if (i.enforce && i.blocked > 0) inputs.bypass = round(clamp01(1 - (i.bypasses + i.ignored) / i.blocked));
  }
  const tv = trendValue(i.trend, p);
  if (tv !== null) inputs.trend = tv;
  const vs = Object.values(inputs);
  if (!vs.length) return null;
  return { value: round(vs.reduce((s, v) => s + v, 0) / vs.length), inputs };
}

export interface CheckScoreInput {
  /** 来源规矩的分项（手写的检查没有）。 */
  lessonParts: LessonScoreParts | null;
  /** 当前回测算出的可验证性；没有回测结果为 null（再看规矩上记的）。 */
  verifiability: number | null;
  performance: PerformanceResult | null;
}

/** 检查的综合分：规矩的分项 + 可验证性 + 表现分按策略权重合成；没有可验证性的封顶 score.untestedCap。 */
export function checkScore(i: CheckScoreInput, p: AdmissionPolicy): { score: number | null; parts: CheckScoreView["parts"] } {
  const lp = i.lessonParts ?? {};
  const input: Partial<ScoreInput> = {};
  if (lp.evidence) input.evidence = lp.evidence;
  if (lp.clarity) input.clarity = lp.clarity;
  if (lp.consistency) input.consistency = lp.consistency;
  const v = i.verifiability ?? lp.verifiability?.value ?? null;
  if (v !== null) input.verifiability = { value: v, reason: "" };
  if (i.performance) input.performance = { value: i.performance.value, reason: "" };
  const parts: CheckScoreView["parts"] = { ...i.performance?.inputs };
  if (v !== null) parts.verifiability = round(v);
  if (i.performance) parts.performance = i.performance.value;
  if (!Object.keys(input).length) return { score: null, parts };
  const composite = compositeOf(input as ScoreInput, p);
  parts.composite = composite;
  if (v === null) {
    parts.cap = num(p, "score.untestedCap");
    return { score: round(Math.min(composite, parts.cap)), parts };
  }
  return { score: composite, parts };
}
