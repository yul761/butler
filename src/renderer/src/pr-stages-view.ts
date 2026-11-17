import type { PrStageCell, PrStagesScope, PrStagesTicket, PrStagesView, PrTimelineEntry } from "../../shared/pr-stages";
import { api } from "./api";
import { useStateRefetch } from "./components/useStateRefetch";
import { S } from "./strings";

/** 一块范围里每个 ticket 的 PR 进度：打开时取一次，之后每次 stateChanged 重取。还没取到时为 null。 */
export function usePrStages(scope: PrStagesScope): PrStagesTicket[] | null {
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

/** 一条时间线的文字：阶段名只在这里写一次（汇报不写阶段名）；回到开发的条目后面加一句。 */
export function timelineText(e: PrTimelineEntry): string {
  const body = S.prTimeline[e.kind](e.detail);
  const text = e.kind === "report" ? body : `${S.prStage[e.stage]} ${body}`;
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

/** 一行最后有动静的时间：时间线和格子上最晚的时间；什么都没有为 -Infinity。 */
const lastAt = (r: PrStagesView): number =>
  Math.max(-Infinity, ...r.timeline.map((e) => e.at), ...r.stages.flatMap((c) => (c.at === null ? [] : [c.at])));

/** ticket 最新的一行：最后有动静的那行；一样晚（或都没动静）时取主进程排在前面的（没有 PR 的行，然后新的 PR）。没有行为 null。 */
export function newestRow(t: PrStagesTicket): PrStagesView | null {
  return t.rows.reduce<PrStagesView | null>((best, r) => (best === null || lastAt(r) > lastAt(best) ? r : best), null);
}

/**
 * 按 feature 数 ticket（不是行，含已归档的）：ticket.merged → merged；其余看最新的一行：
 * 没有行或 PR 已关闭 → notStarted；有 failed 的 cell → failed；dev 还是 todo → notStarted；其余 active。
 */
export function epicPrSummary(tickets: PrStagesTicket[], featureOf: (ticketKey: string) => number | null): Map<number, EpicPrRow> {
  const out = new Map<number, EpicPrRow>();
  for (const t of tickets) {
    const featureId = featureOf(t.ticketKey);
    if (featureId === null) continue;
    const e = out.get(featureId) ?? { featureId, merged: 0, active: 0, failed: 0, notStarted: 0, total: 0 };
    const r = newestRow(t);
    if (t.merged) e.merged++;
    else if (r === null || r.closed) e.notStarted++;
    else if (r.stages.some((c) => c.state === "failed")) e.failed++;
    else if (r.stages.find((c) => c.id === "dev")?.state === "todo") e.notStarted++;
    else e.active++;
    e.total++;
    out.set(featureId, e);
  }
  return out;
}
