// 对话 tab 的纯函数：把主流消息、黄框、汇报、换新分隔线排成一条时间线，以及各种状态的文案。
import { TASK_LIMIT } from "../../shared/control";
import type { ConvMessage, ConvPage } from "../../shared/conversation";
import { FORK_QUESTION_MAX, type DevSendBlock, type ForkMode, type ForkView, type RememberResult } from "../../shared/fork";
import type { InboxItemView, InboxScope } from "../../shared/types";
import { resetClock } from "./availability-view";
import type { UiStrings } from "./strings";

export type ConvFilter = "all" | "forks" | "search";
export type TimelineItem =
  | { kind: "msg"; key: string; msg: ConvMessage }
  | { kind: "sep"; key: string; at: number; sessionId: string }
  | { kind: "fork"; key: string; fork: ForkView }
  | { kind: "report"; key: string; report: InboxItemView };
export interface TimelineInput {
  messages: ConvMessage[]; refreshMarks: ConvPage["refreshMarks"]; convHasMore: boolean;
  forks: ForkView[]; reports: InboxItemView[]; reportsHasMore: boolean; filter: "all" | "forks";
}

/** 同一时间的排法：消息，再黄框，再汇报，最后分隔线。 */
const RANK: Record<TimelineItem["kind"], number> = { msg: 0, fork: 1, report: 2, sep: 3 };

function timeOf(i: TimelineItem): number {
  switch (i.kind) {
    case "msg": return i.msg.at;
    case "sep": return i.at;
    case "fork": return i.fork.startedAt;
    case "report": return i.report.createdAt;
  }
}

const byTime = (a: TimelineItem, b: TimelineItem) => timeOf(a) - timeOf(b) || RANK[a.kind] - RANK[b.kind];

/**
 * 从旧到新。forkId 不为 null 的消息不进主流，它们在各自的黄框里（ForkView.messages）；黄框按 startedAt 排。
 * 分页的截断线：两边（消息和汇报）都还有更早的时，取两者最早时间里较晚的那个为界，比它早的消息、汇报、黄框、分隔线先不显示。
 * "forks"：只出黄框（全部，不受截断线限制）。
 * 同一轮的几条 assistant 消息这里不合并（msg 项只带一条消息），由渲染的组件按 turnId 合；
 * 分叉的消息不在主流里，而且它们的 turnId 全是 0，绝不能按 turnId 合。
 */
export function buildTimeline(i: TimelineInput): TimelineItem[] {
  const forks: TimelineItem[] = i.forks.map((fork) => ({ kind: "fork", key: `f${fork.id}`, fork }));
  if (i.filter === "forks") return forks.sort(byTime);

  const main = i.messages.filter((m) => m.forkId === null);
  // 没有更早页的一边是完整的，不拦；还有更早页的一边，以它已载入的最早一条为界。
  const bounds: number[] = [];
  if (i.convHasMore && main.length) bounds.push(Math.min(...main.map((m) => m.at)));
  if (i.reportsHasMore && i.reports.length) bounds.push(Math.min(...i.reports.map((r) => r.createdAt)));
  const cut = bounds.length ? Math.max(...bounds) : null;

  const items: TimelineItem[] = [
    ...main.map((msg): TimelineItem => ({ kind: "msg", key: `m${msg.id}`, msg })),
    ...forks,
    ...i.reports.map((report): TimelineItem => ({ kind: "report", key: `r${report.id}`, report })),
    ...i.refreshMarks.map((m): TimelineItem => ({ kind: "sep", key: `s${m.at}-${m.sessionId}`, at: m.at, sessionId: m.sessionId })),
  ];
  return items.filter((x) => cut === null || timeOf(x) >= cut).sort(byTime);
}

export type TurnBlock =
  | { kind: "turn"; key: string; msgs: ConvMessage[] }
  | { kind: "item"; item: TimelineItem };

/** 把紧挨着、turnId 相同的主流 assistant 消息并成一块；黄框、汇报、分隔线、用户消息都会打断。黄框里的消息不在这里。 */
export function turnBlocks(items: TimelineItem[]): TurnBlock[] {
  const out: TurnBlock[] = [];
  for (const it of items) {
    if (it.kind === "msg" && it.msg.role === "assistant" && it.msg.forkId === null) {
      const last = out[out.length - 1];
      if (last && last.kind === "turn" && last.msgs[0].turnId === it.msg.turnId) { last.msgs.push(it.msg); continue; }
      out.push({ kind: "turn", key: it.key, msgs: [it.msg] });
    } else out.push({ kind: "item", item: it });
  }
  return out;
}

const usd = (v: number) => `$${v.toFixed(2)}`;

/** 约数（approx）可能偏高也可能偏低，所以不说「至少」；约数又不全时两样都标上。 */
export function costText(f: Pick<ForkView, "costUsd" | "costPartial" | "costApprox" | "status">, t: UiStrings): string {
  const v = f.costUsd;
  if (v === null || !Number.isFinite(v) || v < 0) return f.status === "running" ? t.conv.costPending : t.conv.costUnknown;
  if (f.costApprox) return t.conv.costApprox(v < 0.01 ? t.conv.costUnder : usd(v), f.costPartial);
  if (f.costPartial) return t.conv.costAtLeast(usd(v));
  return v < 0.01 ? t.conv.costUnder : usd(v);
}

export function modeText(mode: ForkMode, t: UiStrings): string {
  return mode === "full" ? t.conv.modeFull : t.conv.modeLight;
}

export function errorText(e: NonNullable<ForkView["error"]>, t: UiStrings, now: number): string {
  const m = t.conv.error;
  switch (e.code) {
    case "rate_limited": return m.rate_limited(e.resetAt !== null && e.resetAt > now ? resetClock(e.resetAt, now) : null);
    case "interrupted": return m.interrupted;
    case "no_answer": return m.no_answer;
    case "timeout": return m.timeout;
    case "model_unavailable": return m.model_unavailable;
    case "not_forked": return m.not_forked;
    case "spawn_failed": case "exit_nonzero": case "bad_output": case "claude_error": case "aborted": return m.other;
  }
}

export function sendBlockText(r: DevSendBlock, t: UiStrings): string {
  return t.conv.block[r];
}

/** 排进信箱以后给用户的一句话（BTL-248）：停着的马上送进去，不用提示；在忙、关着的说一下什么时候送到。 */
export function queuedText(state: "busy" | "idle" | "closed", t: UiStrings): string | null {
  return state === "idle" ? null : t.conv.queued[state];
}

export function rememberText(r: RememberResult, t: UiStrings): string {
  switch (r) {
    case "written": return t.conv.remembered;
    case "full": return t.conv.memoryFull;
    case "disabled": return t.conv.memoryOff;
    case "failed": return t.conv.memoryFailed;
    case "busy": return t.conv.memoryBusy;
    case "no_conclusion": return t.conv.block.no_conclusion;
    case "no_scope": return t.conv.memoryNoScope;
  }
}

/** 总控页上分叉的结论有没有地方记：只有 feature 总控页有 feature；Butler 页没有 ticket 也没有 feature，不出「记进记忆」。 */
export function canRememberIn(scope: InboxScope): boolean {
  return "featureId" in scope;
}

/** 记进记忆回了这个就关掉按钮：只有记忆整体关着（disabled）；没有 ticket / feature 可记（no_scope）不是记忆没开。 */
export function refusesMemory(r: RememberResult): boolean {
  return r === "disabled";
}

/** ButlerError.code → 句子；不认识的给通用的。 */
export function refusalText(code: string, t: UiStrings): string {
  const m = t.conv.refusal as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(m, code) ? m[code] : t.conv.refusal.other;
}

export interface ConvLoaded { messages: ConvMessage[]; refreshMarks: ConvPage["refreshMarks"]; hasMore: boolean }

const byAtId = <T extends { id: number }>(at: (x: T) => number) => (a: T, b: T) => at(a) - at(b) || a.id - b.id;

/** 按 id 合并（新取的那份盖住旧的），按时间从旧到新排。 */
function unionById<T extends { id: number }>(cur: T[], next: T[], at: (x: T) => number): T[] {
  const m = new Map(cur.map((x) => [x.id, x]));
  for (const x of next) m.set(x.id, x);
  return [...m.values()].sort(byAtId(at));
}

/** 合并后的 hasMore：第一页、往前翻的一页说了算；往前翻却一条新的都没有（游标那条没了，服务端又给了最新一页）就到头了，不然会一直重复翻同一页。 */
function nextHasMore<T extends { id: number }>(cur: { hasMore: boolean } | null, loaded: readonly T[], page: { hasMore: boolean }, pageItems: readonly T[], older: boolean): boolean {
  if (cur === null) return page.hasMore;
  if (!older) return cur.hasMore;
  const have = new Set(loaded.map((x) => x.id));
  return page.hasMore && pageItems.some((x) => !have.has(x.id));
}

/**
 * 把新取的一页对话并进已经载入的：按 id 去重。older 为 true 时这一页是往前翻的（before 是已载入最早那条的 id），
 * 还有没有更早的跟它走（一条新的都没有就算到头）；重取最新一页时已载入的更早部分不动，hasMore 不变（第一页除外）。
 */
export function mergeConvPage(cur: ConvLoaded | null, page: ConvPage, older: boolean): ConvLoaded {
  const marks = new Map([...(cur?.refreshMarks ?? []), ...page.refreshMarks].map((m) => [`${m.at}-${m.sessionId}`, m]));
  return {
    messages: unionById(cur?.messages ?? [], page.messages, (m) => m.at),
    refreshMarks: [...marks.values()].sort((a, b) => a.at - b.at),
    hasMore: nextHasMore(cur, cur?.messages ?? [], page, page.messages, older),
  };
}

export interface ReportsLoaded { reports: InboxItemView[]; hasMore: boolean }

/** 同 mergeConvPage，汇报这一路（inbox:reports 的 before 也是 id）。 */
export function mergeReportPage(cur: ReportsLoaded | null, page: ReportsLoaded, older: boolean): ReportsLoaded {
  return { reports: unionById(cur?.reports ?? [], page.reports, (r) => r.createdAt), hasMore: nextHasMore(cur, cur?.reports ?? [], page, page.reports, older) };
}

/** 这个分叉里最后一个问题（「再问一次」重发它）；一个都没有时为 null。 */
export function lastQuestion(f: Pick<ForkView, "messages">): string | null {
  for (let i = f.messages.length - 1; i >= 0; i--) if (f.messages[i].role === "user") return f.messages[i].text;
  return null;
}

/**
 * 输入框能不能发：空白不能发；太长不能发（不偷偷截断），max 是给人看的上限。
 * 跟 IPC 校验一样算：发给开发 session 按原文长度 ≤ TASK_LIMIT；问分叉 trim 后按字算 ≤ FORK_QUESTION_MAX（原文不超过它的两倍）。
 */
export function draftCheck(target: "dev" | "fork", text: string): { blank: boolean; over: boolean; max: number } {
  const blank = text.trim().length === 0;
  if (target === "dev") return { blank, over: text.length > TASK_LIMIT, max: TASK_LIMIT };
  return { blank, over: text.length > FORK_QUESTION_MAX * 2 || [...text.trim()].length > FORK_QUESTION_MAX, max: FORK_QUESTION_MAX };
}

/**
 * 对话 tab 选中哪个 session：当前选的还在列表里就不动（默认的那个变了也不跟着跳）；不在了才回到默认。
 * 列表是空的（还没取到、或者只有一个不出切换条）也不动。
 */
export function keepSelection(current: string, sessions: readonly { id: string }[], fallback: string): string {
  if (sessions.length === 0 || sessions.some((s) => s.id === current)) return current;
  return fallback;
}

/** 只认最后一次发出去的请求：每次 next() 拿一个检查函数，之后再 next() 过，之前的就过期了。 */
export function latestOnly(): () => () => boolean {
  let seq = 0;
  return () => {
    const mine = ++seq;
    return () => mine === seq;
  };
}
