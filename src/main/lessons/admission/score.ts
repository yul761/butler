import type { AdmissionPolicy, AdmissionPolicyKey } from "../../../shared/admission-policy";
import type { LessonScorePart, LessonScoreParts } from "../../../shared/lessons";
import { M, type MainStrings } from "../../strings";

/**
 * 单条规矩的评分（addendum 5.1）：证据、清晰度、一致性，以后还有可验证性和实测表现（F 填）。
 * 纯函数：输入是数字和模型的回答，输出是分项（每项一个 0..1 的值和一句理由）、综合分和该落在哪条线。
 */

type T = MainStrings["admission"];
export const DAY_MS = 86_400_000;
export type WeightedPart = "evidence" | "clarity" | "consistency" | "verifiability" | "performance";
export const WEIGHTED_PARTS: readonly WeightedPart[] = ["evidence", "clarity", "consistency", "verifiability", "performance"];
export type ClarityAnswer = "yes" | "partly" | "no";

const num = (p: AdmissionPolicy, k: AdmissionPolicyKey): number => Number(p[k]);
const clamp = (v: number): number => Math.min(1, Math.max(0, v));
const round = (v: number): number => Math.round(v * 1000) / 1000;
export const fmtScore = (v: number): string => v.toFixed(2);

export interface EvidenceInput {
  hits: number;
  prs: number;
  /** 已知的不同评审人；不知道评审人的来源不算。 */
  reviewers: number;
  lastSeenAt: number;
  degraded: boolean;
}

export function evidencePart(e: EvidenceInput, p: AdmissionPolicy, now: number, t: T = M().admission): LessonScorePart {
  const days = Math.max(0, Math.floor((now - e.lastSeenAt) / DAY_MS));
  const spread = 0.6 * Math.min(1, e.hits / num(p, "score.evidenceFullHits")) + 0.4 * Math.min(1, e.prs / num(p, "score.evidenceFullPrs"));
  const decay = 0.5 ** (Math.max(0, now - e.lastSeenAt) / DAY_MS / num(p, "score.recencyHalfLifeDays"));
  const bonus = num(p, "score.reviewerBonus");
  const reviewerBonus = e.reviewers > 1 ? Math.min(bonus * (e.reviewers - 1), 2 * bonus) : 0;
  const penalty = e.degraded ? num(p, "score.degradedPenalty") : 0;
  const reason = t.evidence(e.hits, e.prs, e.reviewers, days) + (e.degraded ? t.degraded(fmtScore(penalty)) : "");
  return { value: round(clamp(spread * decay + reviewerBonus - penalty)), reason };
}

const CLARITY: Record<ClarityAnswer, number> = { yes: 1, partly: 0.5, no: 0.1 };

/** 清晰度：模型说能 / 部分能 / 不能判断代码对不对；范围不清楚扣 0.2；降级模型产出的再扣一次降级分（更严）。 */
export function clarityPart(answer: ClarityAnswer, scopeClear: boolean, why: string, degraded: boolean, p: AdmissionPolicy, t: T = M().admission): LessonScorePart {
  const penalty = degraded ? num(p, "score.degradedPenalty") : 0;
  const value = CLARITY[answer] - (scopeClear ? 0 : 0.2) - penalty;
  const reason = t.clarity[answer] + (scopeClear ? "" : t.clarityScope) + (degraded ? t.degraded(fmtScore(penalty)) : "") + (why ? `${t.sep}${why}` : "");
  return { value: round(clamp(value)), reason };
}

/** 一致性：没冲突 1，部分情况下冲突 0.5（真冲突在闸门 2 就搁置了，不会到这里）。 */
export function consistencyPart(conditional: { ref: number; reason: string } | null, t: T = M().admission): LessonScorePart {
  return conditional ? { value: 0.5, reason: t.consistencyConditional(conditional.ref, conditional.reason) } : { value: 1, reason: t.consistencyNone };
}

export type ScoreOutcome = "admit" | "clarity" | "low_score" | "below_drop";

export interface ScoreResult {
  /** 规矩自己的综合分（不封顶）。 */
  score: number;
  parts: LessonScoreParts;
  outcome: ScoreOutcome;
  /** 权重大于 0 的分项里最低的那个。 */
  weakest: WeightedPart;
  /** 搁置时的一句话。 */
  note: string | null;
}

export interface ScoreInput {
  evidence: LessonScorePart;
  clarity: LessonScorePart;
  consistency: LessonScorePart;
  verifiability?: LessonScorePart;
  performance?: LessonScorePart;
}

/** 综合分：有值的分项按权重加权平均（权重在有值的分项上重新归一）；权重全是 0 时取平均。 */
export function compositeOf(parts: ScoreInput, p: AdmissionPolicy): number {
  const present = WEIGHTED_PARTS.filter((k) => parts[k] !== undefined);
  const weights = present.map((k) => num(p, `score.weight.${k}` as AdmissionPolicyKey));
  const total = weights.reduce((s, w) => s + w, 0);
  const sum = present.reduce((s, k, i) => s + parts[k]!.value * (total > 0 ? weights[i] : 1), 0);
  return round(sum / (total > 0 ? total : present.length));
}

export function scoreLesson(input: ScoreInput, checkable: boolean, p: AdmissionPolicy, t: T = M().admission): ScoreResult {
  const score = compositeOf(input, p);
  const present = WEIGHTED_PARTS.filter((k) => input[k] !== undefined);
  const weighted = present.filter((k) => num(p, `score.weight.${k}` as AdmissionPolicyKey) > 0);
  const weakest = (weighted.length ? weighted : present).reduce((a, b) => (input[b]!.value < input[a]!.value ? b : a));
  const line = num(p, checkable ? "score.admitLine" : "score.proseAdmitLine");
  const drop = num(p, "score.dropLine");
  const parts: LessonScoreParts = { evidence: input.evidence, clarity: input.clarity, consistency: input.consistency };
  if (input.verifiability) parts.verifiability = input.verifiability;
  if (input.performance) parts.performance = input.performance;
  const used = present.map((k) => `${t.part[k]} ${fmtScore(input[k]!.value)}`).join(", ");
  parts.composite = { value: score, reason: t.composite(fmtScore(score), used, fmtScore(line), !checkable) };
  if (checkable && !input.verifiability) {
    const cap = num(p, "score.untestedCap");
    parts.cap = { value: round(Math.min(score, cap)), reason: `${t.untested}; ${t.cap(fmtScore(cap))}` };
  }
  const minClarity = num(p, "score.minClarity");
  let outcome: ScoreOutcome;
  let note: string | null = null;
  if (input.clarity.value < minClarity) {
    outcome = "clarity";
    note = t.note.clarity(fmtScore(input.clarity.value), fmtScore(minClarity), input.clarity.reason);
  } else if (score >= line) outcome = "admit";
  else if (score < drop) {
    outcome = "below_drop";
    note = t.note.belowDrop(fmtScore(score), fmtScore(drop));
  } else {
    outcome = "low_score";
    note = t.note.lowScore(fmtScore(score), fmtScore(line), t.part[weakest]);
  }
  return { score, parts, outcome, weakest, note };
}
