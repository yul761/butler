import { describe, expect, it } from "vitest";
import type { BacktestSummary, CheckLifecycleView, PromotionProgress } from "../../shared/backtest";
import type { NowNotice } from "../../shared/types";
import { STRINGS } from "./strings";
import { backtestLines, btError, btNoticeText, canClearReview, lifecycleLine, pct, progressLines } from "./backtest-view";

const S = STRINGS.en;

const summary = (o: Partial<BacktestSummary> = {}): BacktestSummary => ({
  tested: true, skipped: [], prs: 30, hits: 4, falsePositives: 1, fpRate: 0.25, comments: 2, commentsMatched: 1, recall: 0.5, legacy: null, samples: [], at: 1, ...o,
});

const progress = (o: Partial<PromotionProgress> = {}): PromotionProgress => ({
  eligible: false, blockers: ["time", "hits"], since: 0, prs: 3, minPrs: 10, days: 2, minDays: 14, fails: 1, minHits: 3,
  adoption: 0.5, minAdoption: 0.6, fpRate: null, maxFpRate: 0.2, score: 0.8, admitLine: 0.7, ...o,
});

describe("backtest view text", () => {
  it("formats rates as whole percents and a dash for missing ones", () => {
    expect(pct(0.256)).toBe("26%");
    expect(pct(null)).toBe("—");
  });

  it("describes a backtest, its skipped repos and the legacy count", () => {
    expect(backtestLines(null, false, S)).toEqual([S.bt.backtestNone]);
    expect(backtestLines(summary(), true, S)).toEqual([S.bt.backtestRunning, S.bt.backtestLine(30, "50%", "25%", 4)]);
    const lines = backtestLines(summary({ legacy: 7, skipped: [{ slug: "o/r", reason: "not_cloned" }] }), false, S);
    expect(lines[0]).toBe(`${S.bt.backtestLine(30, "50%", "25%", 4)} · ${S.bt.legacy(7)}`);
    expect(lines[1]).toBe(S.bt.skippedLine(`o/r (${S.bt.skipped.not_cloned})`));
    // 一个仓库都没回测：只写原因。
    expect(backtestLines(summary({ tested: false, skipped: [{ slug: "o/r", reason: "no_gh" }] }), false, S)).toEqual([S.bt.skippedLine(`o/r (${S.bt.skipped.no_gh})`)]);
  });

  it("shows shadow progress with what is still missing, or that it is ready", () => {
    const lines = progressLines(progress(), S);
    expect(lines[0]).toBe(S.bt.progressLine(3, 10, 2, 14, 1, 3));
    expect(lines[1]).toBe(S.bt.progressRates("50%", "60%", "—", "20%"));
    expect(lines[2]).toBe(S.bt.blockersLine(`${S.bt.blocker.time}, ${S.bt.blocker.hits}`));
    expect(progressLines(progress({ eligible: true, blockers: [] }), S)).toContain(S.bt.progressReady);
    // 不在影子模式、自动升级关着：不显示进度。
    expect(progressLines(progress({ blockers: ["not_shadow"] }), S)).toEqual([]);
    expect(progressLines(progress({ blockers: ["auto_off", "time"] }), S)).toEqual([]);
  });

  it("explains why a check was demoted or flagged", () => {
    const l: CheckLifecycleView = {
      needsReview: true, reason: "bypassed", lastAction: "flag", lastBatchId: null, at: 1,
      data: { kind: "bypassed", bypasses: 4, ignored: 1, blocked: 10, rate: 0.5, max: 0.3, how: {} },
    };
    expect(lifecycleLine(l, S)).toBe(`${S.bt.lifecycleAction.flag}: ${S.bt.lifecycleBypassed(4, 1, 10, "50%", "30%")}`);
    expect(lifecycleLine({ ...l, reason: "no_reduction", lastAction: "demote", data: { kind: "no_reduction", beforePerPr: 1.5, afterPerPr: 1.25, afterPrs: 8 } }, S))
      .toBe(`${S.bt.lifecycleAction.demote}: ${S.bt.lifecycleNoReduction("1.5", "1.25", 8)}`);
    expect(lifecycleLine({ ...l, lastAction: "promote", reason: null, data: { kind: "none" } }, S)).toBe(S.bt.lifecycleAction.promote);
    expect(lifecycleLine(null, S)).toBeNull();
  });

  it("words action errors and says when a review flag can be cleared", () => {
    expect(btError("conflict", S)).toBe(S.bt.actError.conflict);
    expect(btError("weird", S)).toBe(S.bt.actFailed("weird"));
    expect(STRINGS.zh.bt.actError.conflict).toBeTruthy();
    expect(canClearReview({ lifecycle: null, progress: progress({ blockers: ["needs_review"] }) })).toBe(true);
    expect(canClearReview({ lifecycle: null, progress: progress() })).toBe(false);
    expect(lifecycleLine({ needsReview: false, reason: null, lastAction: "cleared", lastBatchId: null, at: 1, data: { kind: "none" } }, S)).toBe(S.bt.lifecycleAction.cleared);
  });

  it("words the promotion and demotion notices with undo only when there is a batch", () => {
    const p: NowNotice = { kind: "check_promoted", eventId: 1, batchId: 5, names: ["a", "b"], at: 1 };
    expect(btNoticeText(p, S)).toEqual({ text: S.bt.noticePromoted("a, b"), actions: ["undo", "checks", "dismiss"] });
    const d: NowNotice = { kind: "check_demoted", eventId: 2, batchId: 6, names: ["a"], reason: "bypassed", flagged: false, at: 1 };
    expect(btNoticeText(d, S)).toEqual({ text: S.bt.noticeDemoted("a", S.bt.reason.bypassed), actions: ["undo", "checks", "dismiss"] });
    const f: NowNotice = { kind: "check_demoted", eventId: 3, batchId: null, names: ["a"], reason: null, flagged: true, at: 1 };
    expect(btNoticeText(f, S)).toEqual({ text: S.bt.noticeFlagged("a", S.bt.reasonUnknown), actions: ["checks", "dismiss"] });
  });
});
