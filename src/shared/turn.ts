// 「谁该动」状态模型（UI 重做第 1 层，spec §5.1、§7）。
// 每个 PR、ticket、总控 session、要你动手的 Shipherd 提醒和「别人请你 review 的 PR」都算成一个 Turn。
// 这里只放纯函数和类型；名字和类型逐字照 docs/superpowers/plans/2026-11-19-ui-redesign-00-index.md 的「第 1 层产出」。
import type { CiUndeliveredReason, NowNotice, NowTarget } from "./types";
import { INTAKE_DECISION_STATES } from "./intake";
import type { PrStatusInput } from "./progress";
import { isWorking, type SessionActivity } from "./activity";
import type { InterruptCategory } from "./metrics";
import type { ReportKind } from "./control";

/** 谁该动。done = 合了；idle = 没开始。 */
export type TurnOwner = "you" | "agent" | "external" | "done" | "idle";

/** 「你」这一类里，没人推进的原因（spec §7：ready for review 之前都算你这边）。 */
export type UnattendedWhy =
  | "ci_failing" | "changes_requested" | "conflicts" | "behind"
  | "draft" | "no_reviewer" | "agent_stopped" | "ci_undelivered";

export type Turn =
  | { owner: "you"; kind: "answer"; question: string; options: string[]; askId: number | null; sessionId: string }
  | { owner: "you"; kind: "merge"; risk: "low" | "medium" | "high" | null }
  | { owner: "you"; kind: "review"; author: string; title: string; url: string }
  // action：卡住裁判建议你怎么做（只有 silent 有，卡片上原因下面一行）；没有为 null 或不写。
  | { owner: "you"; kind: "stuck"; source: "needs_you" | "blocked_report" | "silent" | "ticket_blocked" | "ticket_needs_decision"; detail: string | null; action?: string | null; sessionId: string | null }
  | { owner: "you"; kind: "unattended"; why: UnattendedWhy; canSend: boolean; sessionId: string | null }
  | { owner: "you"; kind: "shipherd"; notice: NowNotice }
  | { owner: "agent"; kind: "fixing_ci" | "addressing_review" | "rebasing" | "working"; sessionId: string }
  // stack_below：Shipherd 管的栈里、下面一层还没合的 draft（names 是下面那层的分支），等它合了 Shipherd 自己 rebase 并改成 ready。
  | { owner: "external"; kind: "ci_running" | "awaiting_review" | "merge_queue" | "stack_below"; names: string[] }
  // closed：ticket 关了、不做了（BTL-270），和合了一样算结束。
  | { owner: "done"; kind: "merged" | "closed" }
  | { owner: "idle"; kind: "not_started" };

/** 急的顺序：同一个 ticket 有几个 PR 时，取最急的那个（spec §5.1）。 */
export const TURN_PRIORITY: Record<TurnOwner, number> = { you: 0, agent: 1, external: 2, idle: 3, done: 4 };

export interface TurnItem {
  /** 别人请你 review 的 PR 不属于任何 ticket，这里为 null。 */
  ticketKey: string | null;
  pr: { repo: string; number: number; title: string; url: string } | null;
  featureId: number | null;
  turn: Turn;
  /** 进入这个状态的时间（epoch ms），用来显示「12 分钟前」。 */
  since: number;
  /** 这个 ticket 除了显示的这个 PR，还有几个别的 PR（owner 不是 done）；没有为 0。 */
  others: number;
  /**
   * 这一条带着这个 ticket 自己的轮次（主进程 ticketTurn 选中的那条，others 是别的 PR 个数）。
   * 不带 filter 时就是 ticket 的那一条；带 filter 时是按 PR 拆开的、session 级的几条里被选中的那条。
   * 多出来的提问（moreAsks）、请你 review 的 PR、不属于 ticket 的都不带。前端拿它当 ticket 的状态，不自己再选一遍。
   */
  ticketLevel?: true;
}

export interface ScopeTurnRow {
  /** feature，或者单独的 ticket。 */
  kind: "feature" | "ticket";
  id: number | string;
  name: string;
  total: number;
  /** 合了的（不含关掉的）。 */
  merged: number;
  /** 关掉不做的 ticket（BTL-270）；算在 bar.done 里，和 merged 一起算结束。 */
  closed: number;
  /** 进度条的四段，按 owner 计数。 */
  bar: Record<"done" | "agent" | "you" | "external" | "idle", number>;
  youCount: number;
  /** 最慢的那一组的名字；规则见 slowestOf。 */
  slowest: string | null;
}

export interface TurnBoard {
  items: TurnItem[];
  counts: { you: number; agent: number; external: number; mergedToday: number };
  scopes: ScopeTurnRow[];
  generatedAt: number;
}

/** CI 结论为什么没递出去（CiDelivery.resend 的非 "sent" 结果）。main 的 CiSkipReason 就是它。 */
export type CiSendSkip = CiUndeliveredReason | "delivered" | "not_open" | "not_settled" | "triage";

/**
 * turn:send-to-agent 失败的原因：
 * - not_found：找不到这个 ticket 或 PR；
 * - not_sendable：这个 PR 现在不是可以发给 agent 的状态（不是 unattended，或 canSend 为假），什么都没发；
 * - no_comments：要求修改，但没有可以送的评论；
 * - 其余是 CI 重发的跳过原因（busy、no_session 等）。
 */
export type TurnSendReason = "not_found" | "not_sendable" | "no_comments" | CiSendSkip;

export type TurnFilter = { featureId?: number; ticketKey?: string };

/** filter 为 null 或空对象（值都是 undefined）时不带 filter。两个字段都给了时取 ticketKey。 */
export function normTurnFilter(f: TurnFilter | null | undefined): TurnFilter | null {
  if (!f) return null;
  if (f.ticketKey !== undefined) return { ticketKey: f.ticketKey };
  if (f.featureId !== undefined) return { featureId: f.featureId };
  return null;
}

export type YouKind = Extract<Turn, { owner: "you" }>["kind"];
/** 同为 you 时的急的顺序：先回答、再卡住、再提醒…… */
export const YOU_KIND_RANK: Record<YouKind, number> = { answer: 0, stuck: 1, shipherd: 2, unattended: 3, review: 4, merge: 5 };

/** 一个 turn 和它进入这个状态的时间。 */
export interface TimedTurn { turn: Turn; since: number }

/** 越小越急：[TURN_PRIORITY, you 内部的顺序]。 */
export function turnRank(t: Turn): [number, number] {
  return [TURN_PRIORITY[t.owner], t.owner === "you" ? YOU_KIND_RANK[t.kind] : 0];
}

function urgentBefore(a: Turn, b: Turn): boolean {
  const [a0, a1] = turnRank(a), [b0, b1] = turnRank(b);
  return a0 < b0 || (a0 === b0 && a1 < b1);
}

/** 最急的一条（R4 的顺序）；并列取先出现的；空数组为 null。 */
export function mostUrgent<T extends { turn: Turn }>(xs: readonly T[]): T | null {
  let best: T | null = null;
  for (const x of xs) if (best === null || urgentBefore(x.turn, best.turn)) best = x;
  return best;
}

/** 有 PR 时 session 给出的这几种不参与：等 review 时 session 停着是正常的。 */
function ignoredWithPrs(t: Turn): boolean {
  return t.owner === "idle" || t.owner === "done" || (t.owner === "you" && t.kind === "unattended" && t.why === "agent_stopped");
}

/** ticket 显示的那一句：按 TURN_PRIORITY 取最急的 PR，再说明还有几个别的 PR。 */
export function ticketTurn(prTurns: Turn[], sessionTurn: Turn | null): { turn: Turn; others: number } {
  const cands: { turn: Turn; pr: boolean }[] = prTurns.map((turn) => ({ turn, pr: true }));
  if (sessionTurn !== null && (prTurns.length === 0 || !ignoredWithPrs(sessionTurn))) cands.push({ turn: sessionTurn, pr: false });
  const best = mostUrgent(cands);
  if (best === null) return { turn: { owner: "idle", kind: "not_started" }, others: 0 };
  // others：除了选中的那个以外、没合的 PR 个数
  let others = 0;
  for (const c of cands) if (c.pr && c !== best && c.turn.owner !== "done") others++;
  return { turn: best.turn, others };
}

/** R5：哪些 Shipherd 提醒算「要你动手」。其余只是提示，不进首页。 */
export function noticeNeedsYou(n: NowNotice): boolean {
  switch (n.kind) {
    case "claude_limited":
    case "model_unavailable":
    case "session_limited":
    case "approval":
    case "ci_undelivered":
    case "comments_waiting":
      return true;
    case "cost": return n.breaker.state === "paused";
    case "stack": return n.stack.reason === "conflict" || n.stack.reason === "stuck";
    case "intake": return INTAKE_DECISION_STATES.includes(n.item.state);
    case "flow_proposal":
    case "flow_partial":
      return true;
    case "lessons_paused":
    case "lessons_failing":
    case "shared_mcp_failed":
    case "routing":
    case "check_promoted":
    case "check_demoted":
    case "behalf_answered": // 总控已经替你答了（BTL-269 A2）：给你看一眼、可以改，不是非你不可。
    case "flow_synced":
    case "flow_capped":
      return false;
  }
}

// ---------- 一个 PR 的 turn（R1、R2） ----------

export interface Pusher { sessionId: string; working: boolean; stoppedAt: number | null }

export interface PrTurnInput extends Omit<PrStatusInput, "author"> {
  mergeQueued: boolean;
  risk: "low" | "medium" | "high" | null;
  /** 结论该递给的 session（ciRecipient 为 ok）；没有为 null。 */
  pusher: Pusher | null;
  /** 当前 head 的 CI 结论递给 pusher 的时间（R2）。 */
  ciDeliveredAt: number | null;
  /** 这一轮 review 评论递给 pusher 的最近时间（R2）。 */
  commentsDeliveredAt: number | null;
  /** CiDelivery.undelivered() 里有这个 PR（超过 30 分钟没递出去）。 */
  ciUndelivered: boolean;
  canResendCi: boolean;
  canSendComments: boolean;
  /** 这个 PR 是 Shipherd 管的栈里的一层、下面还有没合的层时，最近的那层的分支；不在栈里或是栈底为 null。 */
  stackBelow: string | null;
}

/** 有人要求修改：人的 reviewer 里有 changes_requested；或者 review 是 changes_requested、又没有人 approve。bot 不算人。 */
export function prChangesRequested(i: Pick<PrTurnInput, "reviewers" | "review">): boolean {
  const humans = i.reviewers.filter((r) => !r.bot);
  return humans.some((r) => r.state === "changes_requested") || (i.review === "changes_requested" && humans.every((r) => r.state !== "approved"));
}

/** R2：有人在推进 = pusher 在干活，或当前结论递进去以后它还没停。 */
function pushing(p: Pusher | null, deliveredAt: number | null): boolean {
  if (p === null) return false;
  if (p.working) return true;
  return deliveredAt !== null && (p.stoppedAt === null || p.stoppedAt < deliveredAt);
}

/** 找到「你这边」的原因后：有人在推进就是 agent，否则是 you/unattended。 */
function yourSide(i: PrTurnInput, why: UnattendedWhy): Turn {
  const ci = why === "ci_failing" || why === "ci_undelivered";
  const deliveredAt = ci ? i.ciDeliveredAt : why === "changes_requested" ? i.commentsDeliveredAt : null;
  // 半小时没递进去：结论根本没到 agent 手里，它在忙的是别的事，不能说成「在修 CI」。
  if (why !== "ci_undelivered" && i.pusher !== null && pushing(i.pusher, deliveredAt)) {
    const kind = ci ? "fixing_ci" : why === "changes_requested" ? "addressing_review" : why === "conflicts" || why === "behind" ? "rebasing" : "working";
    return { owner: "agent", kind, sessionId: i.pusher.sessionId };
  }
  const canSend = ci ? i.canResendCi : why === "changes_requested" ? i.canSendComments : false;
  return { owner: "you", kind: "unattended", why, canSend, sessionId: i.pusher?.sessionId ?? null };
}

/** R1。已关闭（或状态不明）为 null。 */
export function prTurn(i: PrTurnInput): Turn | null {
  if (i.state === "merged") return { owner: "done", kind: "merged" };
  if (i.state !== "open") return null;
  // 你这边：ready for review 之前。CI 挂了先于 draft：栈的上层都是 draft，挂了的 CI 不能被盖住。
  if (i.ci === "failing") return yourSide(i, i.ciUndelivered ? "ci_undelivered" : "ci_failing");
  if (i.isDraft && i.stackBelow !== null) return { owner: "external", kind: "stack_below", names: [i.stackBelow] };
  if (i.isDraft) return yourSide(i, "draft");
  if (prChangesRequested(i)) return yourSide(i, "changes_requested");
  if (i.mergeable === "conflicting" || i.mergeState === "dirty") return yourSide(i, "conflicts");
  if (i.mergeState === "behind") return yourSide(i, "behind");
  // ready for review 之后
  if (i.ci === "pending") return { owner: "external", kind: "ci_running", names: [] };
  if (i.mergeQueued) return { owner: "external", kind: "merge_queue", names: [] };
  const approved = i.reviewers.some((r) => !r.bot && r.state === "approved") || i.review === "approved";
  if (approved && i.review !== "pending" && i.mergeState !== "blocked") return { owner: "you", kind: "merge", risk: i.risk };
  if (i.reviewRequests.length > 0) return { owner: "external", kind: "awaiting_review", names: i.reviewRequests.map((r) => r.name) };
  // 不要求 review、可以直接合
  if (i.review === null && i.mergeState === "clean") return { owner: "you", kind: "merge", risk: i.risk };
  return yourSide(i, "no_reviewer");
}

// ---------- 一个 session 的 turn（R3、R7），不看 PR ----------

/** 发完 blocked 汇报以后，这么久之内停下的还算「就停在那份汇报上」。 */
export const REPORT_STOP_SLACK_MS = 5 * 60_000;

export interface SessionTurnInput {
  sessionId: string;
  target: NowTarget;
  title: string | null;
  activity: (Pick<SessionActivity, "kind" | "stuck" | "reason" | "startedAt" | "lastOutputAt" | "limit"> & Partial<Pick<SessionActivity, "action" | "prompt">>) | null;
  /** 这个 session 最早一条没回答的 ask_user（inbox_items.id）。 */
  ask: { id: number; question: string; options: string[]; at: number } | null;
  needsYou: { reason: string; category: InterruptCategory } | null;
  /** 这个 ticket 最近的一条 report；总控为 null。 */
  lastReport: { kind: ReportKind; text: string; at: number } | null;
  refreshing: boolean;
  stoppedAt: number | null;
  now: number;
}

/** R3 + R7。「卡住了」只有 needs-you 的 stuck / missing_info、长时间没动静、停在 blocked 汇报上（加上 ticket 级的 ticket_blocked）。 */
export function sessionTurn(i: SessionTurnInput): TimedTurn {
  const a = i.activity;
  const sessionId = i.sessionId;
  const stopped = i.stoppedAt ?? i.now;
  const working = isWorking(a);
  if (i.ask) return { turn: { owner: "you", kind: "answer", question: i.ask.question, options: i.ask.options, askId: i.ask.id, sessionId }, since: i.ask.at };
  if (a?.kind === "approval" || i.needsYou?.category === "permission") {
    const startup = a?.kind === "approval" && a.prompt === "startup";
    return { turn: { owner: "you", kind: "shipherd", notice: { kind: "approval", target: i.target, title: i.title, ...(startup && { startup: true }) } }, since: i.now };
  }
  if (i.refreshing) return { turn: { owner: "agent", kind: "working", sessionId }, since: a?.startedAt ?? i.now };
  if (i.needsYou && (i.needsYou.category === "stuck" || i.needsYou.category === "missing_info")) {
    return { turn: { owner: "you", kind: "stuck", source: "needs_you", detail: i.needsYou.reason, sessionId }, since: stopped };
  }
  if (a?.limit) return { turn: { owner: "you", kind: "shipherd", notice: { kind: "session_limited", target: i.target, title: i.title, limit: a.limit } }, since: i.now };
  if (a?.stuck === true) {
    return { turn: { owner: "you", kind: "stuck", source: "silent", detail: a.reason, action: a.action ?? null, sessionId }, since: a.lastOutputAt ?? a.startedAt ?? i.now };
  }
  const r = i.lastReport;
  if (r && r.kind === "blocked" && !working && (i.stoppedAt === null || i.stoppedAt <= r.at + REPORT_STOP_SLACK_MS)) {
    return { turn: { owner: "you", kind: "stuck", source: "blocked_report", detail: r.text, sessionId }, since: r.at };
  }
  if (i.needsYou) return { turn: { owner: "you", kind: "answer", question: i.needsYou.reason, options: [], askId: null, sessionId }, since: stopped };
  if (working) return { turn: { owner: "agent", kind: "working", sessionId }, since: a?.startedAt ?? i.now };
  return { turn: { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId }, since: stopped };
}

// ---------- 进度行的「最慢的那一组」（R8） ----------

/**
 * 活跃成员（非 done / idle）里最久没有进展（progressAt 最早）的那个的名字；并列取先出现的。
 * 活跃成员少于 2 个为 null：只有一组时说「最慢的是它」没有信息量。
 */
export function slowestOf(members: { name: string; owner: TurnOwner; progressAt: number }[]): string | null {
  const active = members.filter((m) => m.owner !== "done" && m.owner !== "idle");
  if (active.length < 2) return null;
  let best = active[0];
  for (const m of active) if (m.progressAt < best.progressAt) best = m;
  return best.name;
}
