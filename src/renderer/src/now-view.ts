import type { ActivityEvent, SessionActivity } from "../../shared/activity";
import type { InboxItemView, NowCounts, NowRow, NowView, UsageKind, UsageSummary, WatchedPr } from "../../shared/types";
import { activityText } from "./components/TicketActivity";
import type { UiStrings } from "./strings";

/** 「现在」页一行的文字和颜色（设计文档 2026-11-06）。tone 对应样式里的 --ok、--pill-pending、--danger、--muted。 */
export type RowTone = "ok" | "warn" | "danger" | "muted";

/** 停着的活动：回合结束在等下一条指令，或者没在干活。 */
const stoppedKind = (a: SessionActivity): boolean => a.kind === "waiting" || a.kind === "idle";

/** 卡住：停在确认上的不算（那是在等你确认）。 */
const isStuck = (r: NowRow): boolean => r.activity?.stuck === true && r.activity.kind !== "approval";

/** 行的 key：有 session 用 session id，只有 PR 的行用 ticket 号。 */
export const rowKey = (r: NowRow): string => r.sessionId ?? `pr:${r.ticketKey ?? ""}`;

/** 需要你的理由：卡住的写“卡住：理由”（没有理由就是“卡住了”），其余直接是理由。 */
export function needsYouText(r: NowRow, S: UiStrings): string {
  const reason = r.needsYou ?? "";
  if (isStuck(r) || reason === "") return reason ? S.nowStuckWith(reason) : S.nowStuckNoReason;
  return reason;
}

/** 没有在干活的行看 PR：CI 失败、CI 在跑、review 的结论。没有开着的 PR 时为 null。 */
function prText(prs: WatchedPr[], S: UiStrings): { main: string; tone: RowTone } | null {
  const open = prs.filter((p) => p.state === "open");
  if (open.some((p) => p.ci === "failing")) return { main: S.nowCiFailed, tone: "danger" };
  if (prs.some((p) => p.ci === "pending")) return { main: S.nowWaitCi, tone: "warn" };
  if (open.length === 0) return null;
  if (open.some((p) => p.review === "changes_requested")) return { main: S.nowChangesRequested, tone: "muted" };
  if (open.every((p) => p.review === "approved")) return { main: S.nowApproved, tone: "muted" };
  return { main: S.nowWaitReview, tone: "muted" };
}

/**
 * 一行的文字：需要你 → 等你决定 → 换新中 → 卡住 → 合并排队 → 正在做的事 → PR 和 CI → 已停下。
 * sub 是活动的细节（文件、命令、多久没有输出）；停着的不写（时长在最右边一列）。
 * 换新中的 session 在跑的是 Butler 输入的 /handoff、/clear，活动和卡住都不看；只有停在确认上（needsYou 不为 null）的照样显示出来。
 */
export function rowText(r: NowRow, S: UiStrings, now: number): { main: string; sub: string | null; tone: RowTone } {
  const a = r.activity;
  const live = a && !stoppedKind(a) ? activityText(a, S, now) : null;
  const sub = live?.sub ?? null;
  if (r.needsYou !== null) return { main: isStuck(r) || r.needsYou === "" ? needsYouText(r, S) : S.nowWaitingFor(r.needsYou), sub, tone: "danger" };
  // 用 ask_user 提了问题（BTL-190 第 2+3 点）：问题本身在「需要你」的卡片上，这里只说在等你决定。
  if (r.decisions > 0) return { main: S.nowWaitingDecision, sub, tone: "danger" };
  if (r.refreshing !== null) return { main: r.refreshing === "close" ? S.nowClosing : S.nowRefreshing, sub: null, tone: "warn" };
  if (isStuck(r)) return { main: S.nowStuck, sub, tone: "danger" };
  if (r.mergeQueued) return { main: S.nowMergeQueued, sub, tone: "warn" };
  if (live) return { main: live.main, sub, tone: "ok" };
  const pr = prText(r.prs, S);
  if (pr) return { ...pr, sub: null };
  return { main: S.nowStopped, sub: null, tone: "muted" };
}

/** PR 标签：CI 失败用“要改”的颜色，CI 在跑用“待 review”的颜色，其余按 PR 的状态和 review。没有 PR 或已关闭的不显示；gh 读不了、又没见过 PR 的显示灰色的“PR 状态不可用”。 */
export function prPill(p: WatchedPr, S: UiStrings): { text: string; tone: "merged" | "approved" | "changes" | "pending" | "none" } | null {
  // gh 没装、没登录、没网，又从没见过这个分支的 PR：不知道有没有 PR，说一声（设计文档：显示"PR 状态不可用"，不报错）。
  if (p.number === null && p.ci === "unknown") return { text: S.nowPrUnavailable, tone: "none" };
  if (p.state === null || p.state === "closed") return null;
  const text = (state: string) => S.nowPr(p.number, state);
  if (p.state === "merged") return { text: text(S.prPill.merged), tone: "merged" };
  if (p.ci === "failing") return { text: text(S.nowCiFailed), tone: "changes" };
  if (p.ci === "pending") return { text: text(S.nowCiRunning), tone: "pending" };
  if (p.review === "approved") return { text: text(S.prPill.approved), tone: "approved" };
  if (p.review === "changes_requested") return { text: text(S.prPill.changes), tone: "changes" };
  return { text: text(S.prPill.pending), tone: "pending" };
}

/** 一组标题后面的汇总，为 0 的项不写：“3 个进行中 · 1 需要你”；全是 0 时是“无进行中”。 */
export function groupSummary(c: NowCounts, S: UiStrings): string {
  const parts = [
    c.active > 0 ? S.nowActive(c.active) : null,
    c.needsYou > 0 ? S.nowNeedsYouCount(c.needsYou) : null,
    c.stuck > 0 ? S.nowStuckCount(c.stuck) : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : S.nowNoneActive;
}

/** token 数：12_345_678 → "12.3M"，45_600 → "45.6K"，不到 1000 原样。 */
function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** 0..1 的占比写成整数百分比：0.661 → "66%"。 */
const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** 页面底部的一行用量。 */
export function usageLine(u: UsageSummary, S: UiStrings): string {
  return S.nowUsage(formatTokens(u.totalTokens), percent(u.cacheReadShare), percent(u.over200kShare));
}

const USAGE_KINDS: UsageKind[] = ["ticket", "coordinator", "subagent", "headless"];

/** 用量点开后的两列：按类型（固定顺序）和按模型（大的在前），都是按价格折算的占比。 */
export function usageDetails(u: UsageSummary, S: UiStrings): { byKind: string[]; byModel: string[] } {
  return {
    byKind: USAGE_KINDS.map((k) => `${S.nowUsageKind[k]} ${percent(u.byKind[k])}`),
    byModel: Object.entries(u.byModel)
      .sort((a, b) => b[1] - a[1])
      .map(([m, share]) => `${m} ${percent(share)}`),
  };
}

/** 一行是谁：ticket 号，总控写“总控”，修复 session 写“修复”。 */
export const rowLabel = (r: NowRow, S: UiStrings): string => r.ticketKey ?? (r.coordinator ? S.coordinator : S.fixSessionFor(null));

/** 「需要你」里一条的前半段：ticket 号（总控、修复 session 写它是什么）和它所在的 feature 或 epic；不属于 feature 的 ticket 写它的标题。 */
export function rowPlace(view: NowView, r: NowRow, S: UiStrings): { label: string; name: string } {
  const label = rowLabel(r, S);
  const key = rowKey(r);
  for (const e of view.epics) {
    if (e.rows.some((x) => rowKey(x) === key)) return { label, name: e.name };
    for (const f of e.features) {
      if (f.rows.some((x) => rowKey(x) === key)) return { label, name: f.id === null ? (r.title ?? "") : f.name };
    }
  }
  return { label, name: r.title ?? "" };
}

/** 侧栏上「需要你」的数：需要你的行加上未决的「待你决定」（每条一件）。 */
export const needsYouTotal = (v: NowView | null): number => (v ? v.needsYou.length + v.decisions.filter((d) => d.answer === null).length : 0);

/** 「待你决定」、汇报是谁发的：ticket 号（多仓库时带仓库名）、某某总控、修复 session、epic session。 */
export const inboxWho = (i: InboxItemView, S: UiStrings): string => S.inboxWho(i.role, i.ticketKey, i.repo);

/** 全部行，按页面上的顺序：每个 epic 先是它自己的行，再是各 feature 的。 */
export const allRows = (v: NowView): NowRow[] => v.epics.flatMap((e) => [...e.rows, ...e.features.flatMap((f) => f.rows)]);

/** 实况窗口（BTL-190 第 7 点）里一张卡片要你做几件事：需要你的理由算一件，每条未决的「待你决定」算一件。 */
export const liveNeeds = (r: NowRow): number => (r.needsYou !== null ? 1 : 0) + r.decisions;

/** 实况窗口里的 session：正在干活的，和停下来在等你的（确认、待你决定、需要你）。停下的、只有 PR 的行不在里面，按页面上的顺序。 */
export const liveRows = (v: NowView): NowRow[] => allRows(v).filter((r) => r.sessionId !== null && (r.working || liveNeeds(r) > 0));

/** 卡片上的状态药丸：卡住（红）→ 等你（黄：确认、待你决定、需要你）→ 在干活（闪）。 */
export function livePill(r: NowRow, S: UiStrings): { text: string; tone: "work" | "need" | "stuck" } {
  const a = r.activity;
  if (isStuck(r)) return { text: S.nowStuck, tone: "stuck" };
  if (a?.kind === "approval") return { text: S.activity.approval, tone: "need" };
  if (r.decisions > 0) return { text: S.nowWaitingDecision, tone: "need" };
  if (r.needsYou !== null) return { text: S.liveWaiting, tone: "need" };
  const main = a ? S.activity[a.kind] : S.activity.thinking;
  return { text: a?.background ? S.activityBackground(main) : main, tone: "work" };
}

const isLine = (e: ActivityEvent): boolean => e.kind === "tool" || e.kind === "memory-write" || e.kind === "memory-read";
export const eventKey = (e: ActivityEvent): string => `${e.sessionId}|${e.at}|${e.kind}|${e.label}`;

/**
 * 上次取到的几行（NowView 里的）和之后推过来的（activity:event）合在一起：只要工具调用和记忆读写、keep 选中的，
 * 同一条只留一次，从早到晚，最后 limit 条。
 */
export function mergeEvents(fetched: ActivityEvent[], pushed: ActivityEvent[], limit: number, keep: (e: ActivityEvent) => boolean): ActivityEvent[] {
  const seen = new Map<string, ActivityEvent>();
  for (const e of [...fetched, ...pushed]) if (isLine(e) && keep(e)) seen.set(eventKey(e), e);
  return [...seen.values()].sort((a, b) => a.at - b.at).slice(-limit);
}

/** 核心卡片上的一条记忆读写：谁（不在实况里的 session 为空串）、写入还是读取、写了什么。 */
export function liveMemoryLine(e: ActivityEvent, rows: NowRow[], S: UiStrings): { who: string; verb: string; label: string } {
  const r = rows.find((x) => x.sessionId === e.sessionId);
  return { who: r ? rowLabel(r, S) : "", verb: e.kind === "memory-write" ? S.liveWrote : S.liveRead, label: e.label };
}

/** 一个框（相对实况窗口的左上角，像素）。 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number): number => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
const px = (v: number): string => String(Math.round(v * 10) / 10);

/**
 * 卡片连到核心的虚线（SVG path，从卡片到核心）：卡片在核心左边、右边时从卡片朝着核心的那条边的中间出发，
 * 落在核心的侧边上（高度贴着卡片，离核心的上下角至少 14px）；在核心上面、下面时竖着连。中间用一段三次贝塞尔弯过去。
 */
export function wirePath(card: Box, core: Box): string {
  const edge = 14;
  const cy = card.y + card.h / 2;
  const cx = card.x + card.w / 2;
  let from: [number, number];
  let to: [number, number];
  if (card.x + card.w <= core.x || card.x >= core.x + core.w) {
    const left = card.x + card.w <= core.x;
    from = [left ? card.x + card.w : card.x, cy];
    to = [left ? core.x : core.x + core.w, clamp(cy, core.y + edge, core.y + core.h - edge)];
    const mx = (from[0] + to[0]) / 2;
    return `M${px(from[0])} ${px(from[1])} C${px(mx)} ${px(from[1])} ${px(mx)} ${px(to[1])} ${px(to[0])} ${px(to[1])}`;
  }
  const above = cy < core.y + core.h / 2;
  from = [cx, above ? card.y + card.h : card.y];
  to = [clamp(cx, core.x + edge, core.x + core.w - edge), above ? core.y : core.y + core.h];
  const my = (from[1] + to[1]) / 2;
  return `M${px(from[0])} ${px(from[1])} C${px(from[0])} ${px(my)} ${px(to[0])} ${px(my)} ${px(to[0])} ${px(to[1])}`;
}

