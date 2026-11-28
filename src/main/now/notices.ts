import type { IntakeNoticeInfo } from "../../shared/intake";
import type { AvailabilityView } from "../../shared/availability";
import type { LessonRunStatus } from "../../shared/lessons";
import type { CostBreakerView } from "../../shared/cost";
import type { CiUndelivered, NowNotice, NowTarget } from "../../shared/types";
import type { CommentsWaiting } from "../../shared/loop";
import type { StackNoticeInfo } from "../../shared/stacks";

/** 连续这么多次分析失败才提醒。 */
export const LESSONS_FAILING_MIN = 3;

/** 不算分析本身成败的运行：被限额打断、用户取消、退出时中断。 */
const NEUTRAL: ReadonlySet<LessonRunStatus> = new Set(["limited", "cancelled", "aborted"]);

/** 「现在」页顶上的提醒：Claude 限额或模型不可用、模型路由的撞限和降级、共享 MCP 起不来、复盘手动暂停、复盘连续失败。最近的运行从新到旧。 */
export function buildNotices(i: {
  availability: AvailabilityView;
  recentRuns: { status: LessonRunStatus }[];
  routing?: { limited: string[]; fallbacks: number } | null;
  sharedMcpError?: string | null;
}): NowNotice[] {
  const { current, retryAt, lessonsPause } = i.availability;
  const out: NowNotice[] = [];
  if (current !== null) {
    if (i.availability.state === "model_unavailable") out.push({ kind: "model_unavailable", hit: current, retryAt });
    else if (i.availability.state === "limited") out.push({ kind: "claude_limited", hit: current, retryAt, lessonsPaused: lessonsPause?.reason === "limit" });
  }
  if (i.routing) out.push({ kind: "routing", limited: i.routing.limited, fallbacks: i.routing.fallbacks });
  if (lessonsPause?.reason === "manual") out.push({ kind: "lessons_paused" });
  let failed = 0;
  for (const r of i.recentRuns) {
    if (NEUTRAL.has(r.status)) continue;
    if (r.status !== "failed") break;
    failed++;
  }
  if (failed >= LESSONS_FAILING_MIN) out.push({ kind: "lessons_failing", count: failed });
  if (i.sharedMcpError) out.push({ kind: "shared_mcp_failed", error: i.sharedMcpError });
  return out;
}

/** 递不出去的 CI 结论（工作流 W）：每条一个提醒，点开去 ticket（有要递给的 session 就打开它）。 */
export function ciNotices(list: CiUndelivered[], title: (ticketKey: string) => string | null): NowNotice[] {
  return list.map((ci) => ({ kind: "ci_undelivered" as const, ci, title: title(ci.ticketKey), target: { page: "ticket" as const, key: ci.ticketKey, sessionId: ci.sessionId } }));
}

/** 成本熔断（工作流 L）：暂停的排在前面，其次降档、提醒。target：「打开」去哪儿（找不到为 null）。 */
export function costNotices(views: readonly CostBreakerView[], targetOf: (v: CostBreakerView) => NowTarget | null): NowNotice[] {
  const order = { paused: 0, downgraded: 1, warned: 2 } as const;
  return [...views]
    .sort((a, b) => order[a.state] - order[b.state] || (a.trippedAt ?? 0) - (b.trippedAt ?? 0))
    .map((breaker) => ({ kind: "cost" as const, breaker, target: targetOf(breaker) }));
}

/** 评论闭环（工作流 I）：等你看的、该送没送出去的评论，每个 PR 一条，点开去 ticket。 */
export function commentNotices(list: CommentsWaiting[], title: (ticketKey: string) => string | null): NowNotice[] {
  return list.map((w) => ({ kind: "comments_waiting" as const, waiting: w, title: title(w.ticketKey), target: { page: "ticket" as const, key: w.ticketKey, sessionId: null } }));
}

/** 栈的提醒（工作流 K）：有 ticket 的层带上「打开 ticket」。 */
export function stackNotices(list: StackNoticeInfo[]): NowNotice[] {
  return list.map((n) => ({ kind: "stack" as const, stack: n, target: n.ticketKey ? { page: "ticket" as const, key: n.ticketKey, sessionId: null } : null }));
}

/** 自动接活（工作流 N）：要你决定的 ticket，每个一条。 */
export function intakeNotices(list: IntakeNoticeInfo[]): NowNotice[] {
  return list.map((item) => ({ kind: "intake" as const, item }));
}

/**
 * 「现在」页和「谁该动」看板共用的那一份 Shipherd 提醒：每个来源一项、都是必填的（index.ts 里漏接一个来源是类型错误），
 * 按这个顺序排。
 */
export interface NoticeSources {
  built: NowNotice[];
  ci: NowNotice[];
  cost: NowNotice[];
  comments: NowNotice[];
  stack: NowNotice[];
  backtest: NowNotice[];
  intake: NowNotice[];
  /** 总控替你答了的（BTL-269 A2）。 */
  behalf: NowNotice[];
  /** 信息流转（BTL-272）：要你点头的、已同步的、没处理完的、到了每天上限的。 */
  infoflow: NowNotice[];
}
const NOTICE_ORDER: readonly (keyof NoticeSources)[] = ["built", "ci", "cost", "comments", "stack", "backtest", "intake", "behalf", "infoflow"];
export function collectNotices(s: NoticeSources): NowNotice[] {
  return NOTICE_ORDER.flatMap((k) => s[k]);
}
