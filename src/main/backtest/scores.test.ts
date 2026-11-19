import { describe, expect, it } from "vitest";
import { ADMISSION_POLICY_DEFAULTS, type AdmissionPolicy } from "../../shared/admission-policy";
import type { LessonCommentTrend } from "../review-effect/stats";
import { checkScore, performanceOf, trendValue, type PerformanceInput } from "./scores";

const P = ADMISSION_POLICY_DEFAULTS as AdmissionPolicy;
const perf = (over: Partial<PerformanceInput> = {}): PerformanceInput => ({
  fails: 10, resolved: 8, falsePositives: 1, enforce: false, blocked: 0, bypasses: 0, ignored: 0, trend: null, ...over,
});
const side = (prs: number, perPr: number | null) => ({ prs, comments: perPr === null ? 0 : Math.round(prs * perPr), perPr, byWho: { human: 0, copilot: 0 } });
const trend = (before: number | null, after: number | null, afterPrs = 12, beforePrs = 10): LessonCommentTrend => ({ lessonId: 1, before: side(beforePrs, before), after: side(afterPrs, after) });
const parts = { evidence: { value: 0.8, reason: "" }, clarity: { value: 0.9, reason: "" }, consistency: { value: 1, reason: "" } };

describe("performanceOf", () => {
  it("needs shadow.minHits fails before adoption and precision count", () => {
    expect(performanceOf(perf({ fails: 2, resolved: 2 }), P)).toBeNull();
    const r = performanceOf(perf(), P)!;
    expect(r.inputs).toEqual({ adoption: 0.8, precision: 0.9 });
    expect(r.value).toBeCloseTo(0.85);
  });

  it("caps adoption at 1 and adds the bypass input only for enforce checks", () => {
    expect(performanceOf(perf({ resolved: 15 }), P)!.inputs.adoption).toBe(1);
    expect(performanceOf(perf({ blocked: 10, bypasses: 3, ignored: 1 }), P)!.inputs.bypass).toBeUndefined();
    expect(performanceOf(perf({ enforce: true, blocked: 10, bypasses: 3, ignored: 1 }), P)!.inputs.bypass).toBeCloseTo(0.6);
    expect(performanceOf(perf({ enforce: true, blocked: 0 }), P)!.inputs.bypass).toBeUndefined();
  });

  it("uses the comment trend only with enough PRs after and some before", () => {
    expect(trendValue(trend(1, 0.5), P)).toBe(1);
    expect(trendValue(trend(1, 1), P)).toBe(0.5);
    expect(trendValue(trend(1, 1.5), P)).toBe(0);
    expect(trendValue(trend(1, 0.5, 3), P)).toBeNull();
    expect(trendValue(trend(1, 0.5, 12, 0), P)).toBeNull();
    expect(trendValue(trend(null, 0.5), P)).toBeNull();
    expect(trendValue(trend(0, 0), P)).toBe(0.5);
    expect(trendValue(trend(0, 1), P)).toBe(0);
    // 只有趋势、命中不够：表现分就只看趋势。
    expect(performanceOf(perf({ fails: 0, resolved: 0, trend: trend(1, 0.5) }), P)).toEqual({ value: 1, inputs: { trend: 1 } });
  });
});

describe("checkScore", () => {
  it("caps a check without a backtest and leaves the cap off once tested", () => {
    const untested = checkScore({ lessonParts: parts, verifiability: null, performance: null }, P);
    expect(untested.parts.cap).toBe(P["score.untestedCap"]);
    expect(untested.score).toBe(Math.min(untested.parts.composite!, P["score.untestedCap"] as number));
    const tested = checkScore({ lessonParts: parts, verifiability: 1, performance: null }, P);
    expect(tested.parts.cap).toBeUndefined();
    expect(tested.score).toBeGreaterThan(untested.score!);
  });

  it("falls back to the lesson's verifiability and scores checks without a lesson", () => {
    const fromLesson = checkScore({ lessonParts: { ...parts, verifiability: { value: 0.7, reason: "" } }, verifiability: null, performance: null }, P);
    expect(fromLesson.parts.verifiability).toBe(0.7);
    expect(fromLesson.parts.cap).toBeUndefined();
    expect(checkScore({ lessonParts: null, verifiability: null, performance: null }, P).score).toBeNull();
    expect(checkScore({ lessonParts: null, verifiability: 0.8, performance: performanceOf(perf(), P) }, P).score).toBeGreaterThan(0);
  });

  it("is monotone in every input", () => {
    const base = { lessonParts: parts, verifiability: 0.6 };
    const at = (p: Partial<PerformanceInput>, v = 0.6) => checkScore({ ...base, verifiability: v, performance: performanceOf(perf({ enforce: true, blocked: 10, ...p }), P) }, P).score!;
    for (let r = 3; r < 10; r++) expect(at({ resolved: r + 1 })).toBeGreaterThanOrEqual(at({ resolved: r }));
    for (let f = 0; f < 9; f++) expect(at({ falsePositives: f + 1 })).toBeLessThanOrEqual(at({ falsePositives: f }));
    for (let b = 0; b < 9; b++) expect(at({ bypasses: b + 1 })).toBeLessThanOrEqual(at({ bypasses: b }));
    for (let v = 0; v < 1; v += 0.1) expect(at({}, v + 0.1)).toBeGreaterThanOrEqual(at({}, v));
    expect(at({ trend: trend(1, 0.4) })).toBeGreaterThan(at({ trend: trend(1, 1.4) }));
  });
});

describe("score direction (acceptance)", () => {
  // 一组接近真实的命中数据：高分的检查应该更常被采纳、误报更少。
  const checks = [
    { fails: 24, resolved: 22, falsePositives: 0, blocked: 24, bypasses: 0, ignored: 1, recall: 0.6, fpRate: 0.02 },
    { fails: 18, resolved: 14, falsePositives: 1, blocked: 18, bypasses: 1, ignored: 1, recall: 0.45, fpRate: 0.08 },
    { fails: 30, resolved: 15, falsePositives: 6, blocked: 30, bypasses: 4, ignored: 3, recall: 0.3, fpRate: 0.15 },
    { fails: 12, resolved: 3, falsePositives: 5, blocked: 12, bypasses: 3, ignored: 2, recall: 0.1, fpRate: 0.3 },
    { fails: 40, resolved: 6, falsePositives: 20, blocked: 40, bypasses: 12, ignored: 9, recall: 0.05, fpRate: 0.45 },
  ];
  const v = (recall: number, fpRate: number) => 0.5 * Math.min(1, recall / 0.5) + 0.5 * Math.max(0, 1 - (0.5 * fpRate) / 0.2);
  const scored = checks.map((c) => ({
    ...c,
    adoption: c.resolved / c.fails,
    fp: c.falsePositives / c.fails,
    score: checkScore({ lessonParts: parts, verifiability: v(c.recall, c.fpRate), performance: performanceOf(perf({ ...c, enforce: true })!, P) }, P).score!,
  }));

  it("higher-scoring checks are adopted more and have fewer false positives", () => {
    const byScore = [...scored].sort((a, b) => b.score - a.score);
    for (let i = 1; i < byScore.length; i++) {
      expect(byScore[i - 1].adoption).toBeGreaterThan(byScore[i].adoption);
      expect(byScore[i - 1].fp).toBeLessThan(byScore[i].fp);
    }
    // 上下半区的平均也一样（不只是排序碰巧）。
    const top = byScore.slice(0, 2);
    const bottom = byScore.slice(-2);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(top.map((c) => c.adoption))).toBeGreaterThan(mean(bottom.map((c) => c.adoption)));
    expect(mean(top.map((c) => c.fp))).toBeLessThan(mean(bottom.map((c) => c.fp)));
  });
});
