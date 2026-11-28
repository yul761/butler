import type { AvailabilityView, LimitHit } from "../../shared/availability";
import type { NowNotice, NowTarget } from "../../shared/types";
import type { FlowLeftovers } from "../../shared/infoflow";
import { costBreakerText } from "./cost-view";
import { retryRequest } from "./close-ticket-outcome";
import { stackNoticeText } from "./stack-view";
import { btNoticeText } from "./backtest-view";
import { intakeNoticeActions, intakeNoticeText } from "./intake-view";
import type { UiStrings } from "./strings";
import type { TicketTab } from "./ticket-tabs";

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

export type NoticeAction = "correct" | "resume" | "health" | "lessons" | "open" | "retry" | "routing" | "resend" | "raise" | "comments" | "stacks" | "undo" | "checks" | "dismiss" | "intake" | "intakeStart" | "intakeSkip" | "intakeParallel" | "flowApply" | "flowReject" | "flowRetry" | "flowAccept";

/** CI 结论为什么没递出去，一句人话（工作流 W）。认不得的原样带上。 */
export function ciReasonText(reason: string, S: UiStrings): string {
  const known: Record<string, string> = S.ciReason;
  return Object.prototype.hasOwnProperty.call(known, reason) ? known[reason] : S.ciReasonOther(reason);
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
    case "approval": return { text: S.noticeApproval(n.title, n.startup === true), actions: ["open"] };
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
    case "comments_waiting": {
      const w = n.waiting;
      const pr = S.lp.noticePr(w.ticketKey, w.number);
      const text = w.reason === "review" ? S.lp.noticeReview(pr, w.count) : S.lp.noticeUndelivered(pr, w.count, Math.max(1, Math.floor((now - w.since) / 60_000)));
      return { text, actions: ["comments"] };
    }
    case "stack": return { text: stackNoticeText(n.stack, S), actions: n.target ? ["stacks", "open"] : ["stacks"] };
    // 检查自动升降级（工作流 F）：撤销、看检查、知道了。
    case "check_promoted":
    case "check_demoted":
      return btNoticeText(n, S);
    // 自动接活（工作流 N）：拿不准、缺信息的可以直接开工或不做；同路径排着的可以照样并行。
    case "intake": return { text: intakeNoticeText(n.item, S), actions: intakeNoticeActions(n.item) };
    // 总控替你答了（BTL-269 A2）：显示答案；可以改、打开那个 session、知道了。
    case "behalf_answered": return { text: S.noticeBehalf(n.by, n.question, n.answer, n.title), actions: ["correct", "open", "dismiss"] };
    // 信息流转（BTL-272）：等确认的照做 / 不用；替你同步了的撤销 / 知道了。
    case "flow_proposal": return { text: S.infoflow.proposal(n.source, n.label), actions: ["flowApply", "flowReject"] };
    case "flow_synced": return { text: S.infoflow.synced(n.label), actions: ["undo", "dismiss"] };
    // 今天问模型的次数到上限了：先停着，到点自己接着。
    case "flow_capped": return { text: S.infoflow.capped(n.used, n.cap, n.resumesAt === null ? null : resetClock(n.resumesAt, now), n.dropped), actions: [] };
    // 关了、还有 PR 没关上：不算同步完，逐条写原因；重试剩下的、就这样、撤销（重新打开）。
    // 关的时候别人先关了 ticket（closedMeanwhile）：写明是别人关的，不给撤销（ticket 不是这里关的）。
    case "flow_partial": {
      const left = flowLeftoversText(n.leftovers, S);
      const text = n.leftovers.closedMeanwhile ? S.infoflow.partialClosedMeanwhile(n.label, left) : S.infoflow.partial(n.label, left);
      const undo: NoticeAction[] = n.leftovers.closedMeanwhile ? [] : ["undo"];
      return { text, actions: retryRequest(n.leftovers) ? ["flowRetry", "flowAccept", ...undo] : ["flowAccept", ...undo] };
    }
  }
}

/** 没处理完的逐条：「https://…/pull/41（gh 出错：…）」「session 1a2b3c4d（…）」。 */
export function flowLeftoversText(l: FlowLeftovers, S: UiStrings): string {
  return [
    ...l.prErrors.map((p) => S.infoflow.leftPr(p.url, S.tc.prKind[p.kind], p.error)),
    ...l.sessionErrors.map((e) => S.infoflow.leftSession(e.id.slice(0, 8), e.error)),
  ].join(S.infoflow.listSep);
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

/**
 * 「去处理评论」：评论在 ticket 页的「PR 详情」页签里。先把这个 ticket 页记着的页签设成它，再打开 ticket 页；
 * 不带 session 打开：带着 session 进 ticket 页是打开请求，会被拉到「终端」。
 */
export function openCommentsNotice(n: Extract<NowNotice, { kind: "comments_waiting" }>, d: { saveTab: (page: string, tab: TicketTab) => void; onOpen: (t: NowTarget) => void }): void {
  d.saveTab(`ticket:${n.waiting.ticketKey}`, "pr");
  d.onOpen({ page: "ticket", key: n.waiting.ticketKey, sessionId: null });
}
