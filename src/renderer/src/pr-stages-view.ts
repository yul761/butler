import { useEffect, useState } from "react";
import type { PrStagesScope, PrStagesView, PrTimelineEntry } from "../../shared/pr-stages";
import { api } from "./api";
import { reportError } from "./errors";
import { S } from "./strings";

/** hook 事件一来一串：合并成一次重读（和 useInbox 一样）。 */
const STATE_DEBOUNCE_MS = 80;

/** 一块范围里每个仓库的 PR 进度：打开时取一次，之后每次 stateChanged 重取。还没取到时为 null。 */
export function usePrStages(scope: PrStagesScope): PrStagesView[] | null {
  // scope 每次渲染都是新对象：按内容决定要不要重新订阅。
  const key = JSON.stringify(scope);
  const [rows, setRows] = useState<PrStagesView[] | null>(null);
  useEffect(() => {
    let live = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      const n = ++seq;
      api.prStages(JSON.parse(key) as PrStagesScope).then((v) => live && n === seq && setRows(v), reportError);
    };
    load();
    const off = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, STATE_DEBOUNCE_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [key]);
  return rows;
}

/** 一条时间线的文字；回到开发的条目后面加一句。 */
export function timelineText(e: PrTimelineEntry): string {
  const text = S.prTimeline[e.kind](e.detail);
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
