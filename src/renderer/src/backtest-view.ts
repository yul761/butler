// 检查页和「现在」页上回测、影子进度、自动升降级的文字（工作流 F）。纯函数，好测。
import type { BacktestSummary, CheckLifecycleView, PromotionProgress } from "../../shared/backtest";
import type { NowNotice } from "../../shared/types";
import type { UiStrings } from "./strings";
import { pct } from "./admission-view";

export { pct };

const num = (x: number): string => String(Math.round(x * 100) / 100);

/** 回测一两行：结果（带存量违规）、哪些仓库没回测；正在回测写在最前。 */
export function backtestLines(b: BacktestSummary | null, running: boolean, S: UiStrings): string[] {
  const out: string[] = [];
  if (running) out.push(S.bt.backtestRunning);
  if (!b) {
    if (!running) out.push(S.bt.backtestNone);
    return out;
  }
  if (b.tested) {
    const line = S.bt.backtestLine(b.prs, pct(b.recall), pct(b.fpRate), b.hits);
    out.push(b.legacy !== null ? `${line} · ${S.bt.legacy(b.legacy)}` : line);
  }
  if (b.skipped.length) out.push(S.bt.skippedLine(b.skipped.map((s) => `${s.slug} (${S.bt.skipped[s.reason]})`).join(", ")));
  return out;
}

/** 影子进度：不在影子模式或自动升级关着时不显示。 */
export function progressLines(p: PromotionProgress | null, S: UiStrings): string[] {
  if (!p || p.blockers.includes("not_shadow") || p.blockers.includes("auto_off")) return [];
  const out = [S.bt.progressLine(p.prs, p.minPrs, p.days, p.minDays, p.fails, p.minHits), S.bt.progressRates(pct(p.adoption), pct(p.minAdoption), pct(p.fpRate), pct(p.maxFpRate))];
  out.push(p.eligible ? S.bt.progressReady : S.bt.blockersLine(p.blockers.map((b) => S.bt.blocker[b]).join(", ")));
  return out;
}

/** 上一次自动升降级 / 标复查，带原因的数字。 */
export function lifecycleLine(l: CheckLifecycleView | null, S: UiStrings): string | null {
  if (!l || !l.lastAction) return null;
  const head = S.bt.lifecycleAction[l.lastAction];
  const d = l.data;
  if (d.kind === "bypassed") return `${head}: ${S.bt.lifecycleBypassed(d.bypasses, d.ignored, d.blocked, pct(d.rate), pct(d.max))}`;
  if (d.kind === "no_reduction") return `${head}: ${S.bt.lifecycleNoReduction(num(d.beforePerPr), num(d.afterPerPr), d.afterPrs)}`;
  return head;
}

/** 动作失败的错误码 → 一句话。 */
export function btError(code: string, S: UiStrings): string {
  return S.bt.actError[code] ?? S.bt.actFailed(code);
}

/** 复查标记能不能清：标着待复查，或者影子进度被「撤销过 / 自动降级过」挡着。 */
export function canClearReview(f: { lifecycle: CheckLifecycleView | null; progress: PromotionProgress | null }): boolean {
  return f.lifecycle?.needsReview === true || (f.progress?.blockers.includes("needs_review") ?? false);
}

export type BtNoticeAction = "undo" | "checks" | "dismiss";

/** 「现在」页的升降级提醒：有批次才能撤销。 */
export function btNoticeText(n: Extract<NowNotice, { kind: "check_promoted" | "check_demoted" }>, S: UiStrings): { text: string; actions: BtNoticeAction[] } {
  const names = n.names.join(", ");
  const actions: BtNoticeAction[] = n.batchId !== null ? ["undo", "checks", "dismiss"] : ["checks", "dismiss"];
  if (n.kind === "check_promoted") return { text: S.bt.noticePromoted(names), actions };
  const reason = n.reason ? S.bt.reason[n.reason] : S.bt.reasonUnknown;
  return { text: n.flagged ? S.bt.noticeFlagged(names, reason) : S.bt.noticeDemoted(names, reason), actions };
}
