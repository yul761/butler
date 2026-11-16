import type { PrStageCell, PrStagesScope, PrStagesView, PrTimelineEntry } from "../../shared/pr-stages";
import { api } from "./api";
import { useStateRefetch } from "./components/useStateRefetch";
import { S } from "./strings";

/** 一块范围里每个仓库的 PR 进度：打开时取一次，之后每次 stateChanged 重取。还没取到时为 null。 */
export function usePrStages(scope: PrStagesScope): PrStagesView[] | null {
  return useStateRefetch(JSON.stringify(scope), () => api.prStages(scope));
}

/** 第 N 轮只写在当前这一步（进行中或失败）上，别的格子不写。 */
const roundShown = (c: PrStageCell): boolean => c.round > 1 && (c.state === "active" || c.state === "failed");

/** 一个 cell 上写的字：完成 / 失败 / 没开始用符号（调用方把 cellLabel 放进 title 和 aria-label），其余用文字；第 N 轮跟在后面。 */
export function cellText(c: PrStageCell): string {
  const base = ((): string => {
    switch (c.state) {
      case "done": return "✓";
      case "failed": return "✗";
      case "todo": return "—";
      case "active": return S.prStageActive;
      case "skipped": return S.prStageSkipped;
      case "unknown": return S.prStageUnknown;
      case "feature_level": return S.prStageFeatureLevel;
    }
  })();
  return roundShown(c) ? `${base} ${S.prRound(c.round)}` : base;
}

/** 符号 cell 的 title / aria-label。 */
export function cellLabel(c: PrStageCell): string {
  switch (c.state) {
    case "done": return S.prStateDone;
    case "failed": return roundShown(c) ? `${S.prStateFailed} ${S.prRound(c.round)}` : S.prStateFailed;
    case "todo": return S.prStateTodo;
    default: return cellText(c);
  }
}

/** 一条时间线的文字：阶段名只在这里写一次；回到开发的条目后面加一句。 */
export function timelineText(e: PrTimelineEntry): string {
  const text = `${S.prStage[e.stage]} ${S.prTimeline[e.kind](e.detail)}`;
  return e.back ? `${text} ${S.prBackToDev}` : text;
}
export interface EpicPrRow {
  featureId: number;
  merged: number;
  active: number;
  failed: number;
  notStarted: number;
  total: number;
}

/** 按 feature 分组计数：merge=done → merged；closed 不计；有 failed 的 cell → failed；dev 还是 todo → notStarted；其余 active。 */
export function epicPrSummary(rows: PrStagesView[]): Map<number, EpicPrRow> {
  const out = new Map<number, EpicPrRow>();
  for (const r of rows) {
    if (r.featureId === null || r.closed) continue;
    const e = out.get(r.featureId) ?? { featureId: r.featureId, merged: 0, active: 0, failed: 0, notStarted: 0, total: 0 };
    const state = (id: string) => r.stages.find((c) => c.id === id)?.state;
    if (state("merge") === "done") e.merged++;
    else if (r.stages.some((c) => c.state === "failed")) e.failed++;
    else if (state("dev") === "todo") e.notStarted++;
    else e.active++;
    e.total++;
    out.set(r.featureId, e);
  }
  return out;
}
