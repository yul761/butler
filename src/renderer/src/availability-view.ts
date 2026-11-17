import type { LimitHit } from "../../shared/availability";
import type { UiStrings } from "./strings";

const pad = (n: number): string => String(n).padStart(2, "0");

/** 恢复时间：同一天只写 HH:MM，别的日子写 M/D HH:MM（本地时间，不分语言）。 */
export function resetClock(ms: number, now: number): string {
  const d = new Date(ms);
  const t = new Date(now);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  return sameDay ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

/** 一行字：哪种限额，知道恢复时间就带上。 */
export function limitLine(l: LimitHit, S: UiStrings, now: number): string {
  const kind = S.limitKind[l.kind];
  return l.resetsAt === null ? S.limitNoReset(kind) : S.limitUntil(kind, resetClock(l.resetsAt, now));
}
