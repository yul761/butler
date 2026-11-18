import type { AvailabilityView, LimitHit } from "../../shared/availability";
import type { NowNotice } from "../../shared/types";
import { costBreakerText } from "./cost-view";
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

export type NoticeAction = "resume" | "health" | "lessons" | "open" | "retry" | "routing" | "resend" | "raise";

/** CI 结论为什么没递出去，一句人话（工作流 W）。认不得的原样带上。 */
export function ciReasonText(reason: string, S: UiStrings): string {
  const [head, tail] = reason.split(":", 2) as [string, string | undefined];
  const pick = (m: Record<string, string>, k: string): string | undefined => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined);
  const known = tail === undefined ? pick(S.ciReason, head) : head === "guard" ? pick(S.ciGuard, tail) : head === "deliver" ? pick(S.ciDeliver, tail) : undefined;
  return known ?? S.ciReasonOther(reason);
}

/** 「现在」页一条提醒的文字和按钮。 */
export function noticeText(n: NowNotice, S: UiStrings, now: number): { text: string; actions: NoticeAction[] } {
  switch (n.kind) {
    case "claude_limited": return { text: S.noticeLimited(limitLine(n.hit, S, now), n.lessonsPaused), actions: ["resume", "health"] };
    case "model_unavailable": return { text: S.noticeModel(limitLine(n.hit, S, now)), actions: ["retry", "health"] };
    case "lessons_paused": return { text: S.noticeLessonsPaused, actions: ["resume"] };
    case "lessons_failing": return { text: S.noticeLessonsFailing(n.count), actions: ["lessons"] };
    case "routing": {
      const parts = [];
      if (n.limited.length) parts.push(S.rt.nowLimited(n.limited.join(", ")));
      if (n.fallbacks) parts.push(S.rt.nowFallbacks(n.fallbacks));
      return { text: parts.join(" · "), actions: ["routing"] };
    }
    case "shared_mcp_failed": return { text: S.noticeSharedMcpFailed(n.error), actions: [] };
    case "session_limited": {
      const line = limitLine(n.limit, S, now);
      return { text: n.title === null ? line : S.noticeSessionLimited(n.title, line), actions: ["open"] };
    }
    case "ci_undelivered": {
      const c = n.ci;
      const what = c.number === null ? S.ciWhatBranch(c.ticketKey, c.branch) : S.ciWhatPr(c.ticketKey, c.number, c.branch);
      return { text: S.noticeCiUndelivered(what, Math.max(1, Math.floor((now - c.since) / 60_000)), ciReasonText(c.reason, S)), actions: ["resend", "open"] };
    }
    // 成本熔断（工作流 L）：快到上限只提醒；降档、暂停了可以一键继续并提高上限。
    case "cost": {
      const actions: NoticeAction[] = n.breaker.state === "warned" ? [] : ["raise"];
      if (n.target) actions.push("open");
      return { text: costBreakerText(n.breaker, S), actions };
    }
  }
}

export type AvailabilityTone = "ok" | "warn" | "danger" | "muted";
/** pill=false：长文本（如报错原文），按普通文字显示并换行。 */
export type AvailabilityRow = [label: string, value: string, tone: AvailabilityTone, pill: boolean];

/** 设置 → 健康里「Claude 可用性」的行；没东西可显示的行不出，状态行总在。 */
export function availabilityRows(v: AvailabilityView, S: UiStrings, now: number): AvailabilityRow[] {
  const stateTone: AvailabilityTone = v.state === "ok" ? "ok" : v.state === "limited" ? "warn" : "danger";
  const rows: AvailabilityRow[] = [[S.availabilityStateLabel, S.availabilityState[v.state], stateTone, true]];
  if (v.current) {
    const c = v.current;
    const parts = [`${S.limitKind[c.kind]} · ${resetClock(c.at, now)}`, S.availabilitySource(c.source, c.job)];
    if (c.message.trim()) parts.push(c.message);
    rows.push([S.availabilityCurrent, parts.join(" · "), stateTone, false]);
  }
  if (v.retryAt !== null) rows.push([S.availabilityRetryAt, resetClock(v.retryAt, now), "muted", true]);
  if (v.lastHit) rows.push([S.availabilityLastHit, `${S.limitKind[v.lastHit.kind]} · ${resetClock(v.lastHit.at, now)}`, "muted", true]);
  const p = v.lessonsPause;
  if (p) {
    rows.push([S.availabilityLessons, p.reason === "manual" ? S.availabilityLessonsPausedManual : p.until === null ? S.availabilityLessonsPaused : S.availabilityLessonsPausedUntil(resetClock(p.until, now)), p.reason === "manual" ? "muted" : "warn", true]);
  } else if (v.current) {
    rows.push([S.availabilityLessons, S.availabilityLessonsRunning, "ok", true]);
  }
  return rows;
}

/** 按钮：有暂停或当前受限时能恢复；没手动暂停时能暂停。 */
export function availabilityButtons(v: AvailabilityView): { resume: boolean; pause: boolean } {
  return { resume: v.lessonsPause !== null || v.current !== null, pause: v.lessonsPause?.reason !== "manual" };
}
