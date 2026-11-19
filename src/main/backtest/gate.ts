// 准入第 5 关（工作流 F 第 4 节）：回测的数字变成可验证性分项，召回太低、误报太多、没回测（策略不许）的搁置。纯函数。
import type { AdmissionPolicy } from "../../shared/admission-policy";
import type { LessonScorePart } from "../../shared/lessons";
import { scoreLesson, type ScoreInput, type ScoreResult } from "../lessons/admission/score";
import { M, type MainStrings } from "../strings";
import type { GateAnswer } from "./service";

type T = MainStrings["admission"];
const num = (p: AdmissionPolicy, k: keyof AdmissionPolicy): number => Number(p[k]);
const round = (v: number): number => Math.round(v * 1000) / 1000;
export const pct = (v: number): string => `${Math.round(v * 100)}%`;

export type Tested = Extract<GateAnswer, { kind: "tested" }>;

/** v = 0.5·R + 0.5·N；R = min(1, 召回 / 0.5)（不详取 0.5）；N = max(0, 1 − 0.5·误报率 / 上限)（没命中取 1）。 */
export function verifiabilityValue(a: Pick<Tested, "recall" | "fpRate">, p: AdmissionPolicy): number {
  const r = a.recall === null ? 0.5 : Math.min(1, a.recall / 0.5);
  const n = a.fpRate === null ? 1 : Math.max(0, 1 - (0.5 * a.fpRate) / Math.max(num(p, "backtest.maxFalsePositiveRate"), 0.01));
  return round(0.5 * r + 0.5 * n);
}

export function verifiabilityPart(a: Tested, p: AdmissionPolicy, t: T = M().admission): LessonScorePart {
  return {
    value: verifiabilityValue(a, p),
    reason: t.verifiability(a.recall === null ? null : pct(a.recall), a.comments, a.fpRate === null ? null : pct(a.fpRate), a.hits, a.prs),
  };
}

export type Gate5Result =
  | { kind: "score"; s: ScoreResult }
  | { kind: "shelve"; reason: "backtest_recall" | "backtest_fp" | "untested"; note: string };

export function gate5(a: Exclude<GateAnswer, { kind: "pending" }>, parts: ScoreInput, p: AdmissionPolicy, t: T = M().admission): Gate5Result {
  const untested = (why: keyof T["skip"]): Gate5Result =>
    p["backtest.allowUntestedShadow"] === true
      ? { kind: "score", s: scoreLesson({ ...parts, verifiability: undefined }, true, p, t) }
      : { kind: "shelve", reason: "untested", note: t.note.untested(t.skip[why]) };
  if (a.kind === "untested") return untested(a.reason);
  if (a.recall === null && a.hits === 0) return untested("no_material");
  const minRecall = num(p, "backtest.minRecall");
  if (a.recall !== null && a.recall < minRecall) return { kind: "shelve", reason: "backtest_recall", note: t.note.backtestRecall(pct(a.recall), a.comments, pct(minRecall)) };
  const maxFp = num(p, "backtest.maxFalsePositiveRate");
  if (a.fpRate !== null && a.fpRate > maxFp) return { kind: "shelve", reason: "backtest_fp", note: t.note.backtestFp(pct(a.fpRate), pct(maxFp)) };
  return { kind: "score", s: scoreLesson({ ...parts, verifiability: verifiabilityPart(a, p, t) }, true, p, t) };
}
