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

/** 一行最后有动静的时间：时间线和格子上最晚的时间；什么都没有为 -Infinity。 */
const lastAt = (r: PrStagesView): number =>
  Math.max(-Infinity, ...r.timeline.map((e) => e.at), ...r.stages.flatMap((c) => (c.at === null ? [] : [c.at])));

/** r 比 best 新：动静更晚；一样晚时 PR 行胜过没有 PR 的行，其余照主进程的顺序（新的 PR 在前）。 */
const newer = (r: PrStagesView, best: PrStagesView): boolean =>
  lastAt(r) > lastAt(best) || (lastAt(r) === lastAt(best) && best.noPr && !r.noPr);

/** ticket 最新的一行：没关闭的行里最新的（关掉旧 PR 不会盖住还开着的新 PR）；全都关了才取关闭的里最新的。没有行为 null。 */
export function newestRow(t: PrStagesTicket): PrStagesView | null {
  const live = t.rows.filter((r) => !r.closed);
  return (live.length > 0 ? live : t.rows).reduce<PrStagesView | null>((best, r) => (best === null || newer(r, best) ? r : best), null);
}
