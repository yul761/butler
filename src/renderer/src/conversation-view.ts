// 对话 tab 的纯函数：把主流消息、黄框、汇报、换新分隔线排成一条时间线，以及各种状态的文案。
import type { ConvMessage, ConvPage } from "../../shared/conversation";
import type { DevSendBlock, ForkMode, ForkView, RememberResult } from "../../shared/fork";
import type { InboxItemView } from "../../shared/types";
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
  let cut: number | null = null;
  if (i.convHasMore && i.reportsHasMore) {
    const earliest = [main.map((m) => m.at), i.reports.map((r) => r.createdAt)]
      .filter((a) => a.length > 0).map((a) => Math.min(...a));
    if (earliest.length > 0) cut = Math.max(...earliest);
  }

  const items: TimelineItem[] = [
    ...main.map((msg): TimelineItem => ({ kind: "msg", key: `m${msg.id}`, msg })),
    ...forks,
    ...i.reports.map((report): TimelineItem => ({ kind: "report", key: `r${report.id}`, report })),
    ...i.refreshMarks.map((m): TimelineItem => ({ kind: "sep", key: `s${m.at}-${m.sessionId}`, at: m.at, sessionId: m.sessionId })),
  ];
  return items.filter((x) => cut === null || timeOf(x) >= cut).sort(byTime);
}

const usd = (v: number) => `$${v.toFixed(2)}`;

export function costText(f: Pick<ForkView, "costUsd" | "costPartial" | "status">, t: UiStrings): string {
  const v = f.costUsd;
  if (v === null || !Number.isFinite(v) || v < 0) return f.status === "running" ? t.conv.costPending : t.conv.costUnknown;
  if (v < 0.01) return t.conv.costUnder;
  return f.costPartial ? t.conv.costAtLeast(usd(v)) : usd(v);
}

export function modeText(mode: ForkMode, t: UiStrings): string {
  return mode === "full" ? t.conv.modeFull : t.conv.modeLight;
}

/** 恢复的时间：同一天只写时分，不同天带上月日。 */
function resetText(at: number, now: number): string {
  const d = new Date(at);
  const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? clock : `${d.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${clock}`;
}

export function errorText(e: NonNullable<ForkView["error"]>, t: UiStrings, now: number): string {
  const m = t.conv.error;
  switch (e.code) {
    case "rate_limited": return m.rate_limited(e.resetAt !== null && e.resetAt > now ? resetText(e.resetAt, now) : null);
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

export function rememberText(r: RememberResult, t: UiStrings): string {
  switch (r) {
    case "written": return t.conv.remembered;
    case "full": return t.conv.memoryFull;
    case "disabled": return t.conv.memoryOff;
    case "failed": return t.conv.memoryFailed;
    case "busy": return t.conv.memoryBusy;
    case "no_conclusion": return t.conv.block.no_conclusion;
  }
}

/** ButlerError.code → 句子；不认识的给通用的。 */
export function refusalText(code: string, t: UiStrings): string {
  const m = t.conv.refusal as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(m, code) ? m[code] : t.conv.refusal.other;
}
