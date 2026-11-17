import type { AvailabilityView, LimitHit } from "../../shared/availability";
import type { NowNotice } from "../../shared/types";
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

export type NoticeAction = "resume" | "health" | "lessons" | "open" | "retry";

/** 「现在」页一条提醒的文字和按钮。 */
export function noticeText(n: NowNotice, S: UiStrings, now: number): { text: string; actions: NoticeAction[] } {
  switch (n.kind) {
    case "claude_limited": return { text: S.noticeLimited(limitLine(n.hit, S, now), n.lessonsPaused), actions: ["resume", "health"] };
    case "model_unavailable": return { text: S.noticeModel(limitLine(n.hit, S, now)), actions: ["retry", "health"] };
    case "lessons_paused": return { text: S.noticeLessonsPaused, actions: ["resume"] };
    case "lessons_failing": return { text: S.noticeLessonsFailing(n.count), actions: ["lessons"] };
    case "session_limited": {
      const line = limitLine(n.limit, S, now);
      return { text: n.title === null ? line : S.noticeSessionLimited(n.title, line), actions: ["open"] };
    }
  }
}

export type AvailabilityTone = "ok" | "warn" | "danger" | "muted";
export type AvailabilityRow = [label: string, value: string, tone: AvailabilityTone];

/** 一次受限：恢复时间已过就只写时钟（不再说「恢复」），否则同 limitLine。 */
function hitLine(h: LimitHit, S: UiStrings, now: number): string {
  if (h.resetsAt !== null && h.resetsAt <= now) return `${S.limitKind[h.kind]} · ${resetClock(h.resetsAt, now)}`;
  return limitLine(h, S, now);
}

/** 设置 → 健康里「Claude 可用性」的行；没东西可显示的行不出，状态行总在。 */
export function availabilityRows(v: AvailabilityView, S: UiStrings, now: number): AvailabilityRow[] {
  const rows: AvailabilityRow[] = [[S.availabilityStateLabel, S.availabilityState[v.state], v.state === "ok" ? "ok" : v.state === "limited" ? "warn" : "danger"]];
  if (v.current) {
    const c = v.current;
    rows.push([S.availabilityCurrent, `${hitLine(c, S, now)} · ${S.availabilitySource(c.source, c.job)} · ${c.message}`, "warn"]);
  }
  if (v.retryAt !== null) rows.push([S.availabilityRetryAt, resetClock(v.retryAt, now), "muted"]);
  if (v.lastHit) rows.push([S.availabilityLastHit, `${S.limitKind[v.lastHit.kind]} · ${resetClock(v.lastHit.at, now)}`, "muted"]);
  const p = v.lessonsPause;
  if (p) {
    rows.push([S.availabilityLessons, p.reason === "manual" ? S.availabilityLessonsPausedManual : S.availabilityLessonsPausedUntil(p.until === null ? "—" : resetClock(p.until, now)), p.reason === "manual" ? "muted" : "warn"]);
  } else if (v.current) {
    rows.push([S.availabilityLessons, S.availabilityLessonsRunning, "ok"]);
  }
  return rows;
}

/** 按钮：有暂停或当前受限时能恢复；没手动暂停时能暂停。 */
export function availabilityButtons(v: AvailabilityView): { resume: boolean; pause: boolean } {
  return { resume: v.lessonsPause !== null || v.current !== null, pause: v.lessonsPause?.reason !== "manual" };
}
