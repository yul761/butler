// 首页（轮到你）和全部工作页的纯函数（UI 重做第 2 层，spec §5.3）。
// 状态由第 1 层的 turn:board 给出，这里只排序、截断、取位置和按钮，不自己算状态，也不拼状态文案。
import type { NowNotice, NowTarget } from "../../shared/types";
import { YOU_KIND_RANK, type ScopeTurnRow, type Turn, type TurnBoard, type TurnItem, type YouKind } from "../../shared/turn";
import type { Route } from "./App";
import type { FirstRunHomeProps } from "./components/FirstRunHome";
import { formatDuration } from "./components/TicketActivity";
import type { UiStrings } from "./strings";
import { externalWho, turnSentence } from "./turn-text";
import type { TurnTone } from "./turn-tone";

export { turnTone, type TurnTone } from "./turn-tone";

/** 「你」这一类的顺序，和第 1 层 mostUrgent 用的是同一份（YOU_KIND_RANK），不另起一套。 */
export const YOU_KIND_ORDER: readonly YouKind[] = (Object.keys(YOU_KIND_RANK) as YouKind[]).sort((a, b) => YOU_KIND_RANK[a] - YOU_KIND_RANK[b]);
export const HOME_CARD_CAP = 20;
export const HOME_SCOPE_CAP = 8;

const youRank = (t: Turn) => (t.owner === "you" ? YOU_KIND_RANK[t.kind] : 99);

/**
 * 工作区里什么都没有（ticket、feature 都是 0），轮到你的板上也空着，也没有别的 Shipherd 提醒：首页只放空状态。
 * 板上有 Shipherd 自己的提醒、或者有只是告知的提醒（noticeCount，放在「运行情况」里）时照常显示。
 */
export function isNoWork(workCount: number, items: TurnItem[] | null, noticeCount = 0): boolean {
  return workCount === 0 && (items ?? []).length === 0 && noticeCount === 0;
}

/** 一条提醒是哪一条（同一类可以有好几条：两个 intake 决定、两个 session 的权限确认）。 */
export function noticeKey(n: NowNotice): string {
  if (n.kind === "cost") return `cost:${n.breaker.subjectKind}:${n.breaker.subjectId}`;
  if (n.kind === "comments_waiting") return `comments_waiting:${n.waiting.reason}:${n.waiting.prId}`;
  if (n.kind === "stack") return `stack:${n.stack.reason}:${n.stack.stackId}:${n.stack.branch}`;
  if (n.kind === "check_promoted" || n.kind === "check_demoted") return `${n.kind}:${n.eventId}`;
  if (n.kind === "intake") return `intake:${n.item.key}`;
  if (n.kind === "behalf_answered") return `behalf_answered:${n.askId}`;
  if (n.kind === "flow_proposal" || n.kind === "flow_synced" || n.kind === "flow_partial") return `${n.kind}:${n.actionId}`;
  if (n.kind === "ci_undelivered") return `ci_undelivered:${n.ci.item.kind}:${n.ci.item.kind === "pr" ? n.ci.item.id : n.ci.item.repoId}`;
  if (n.kind !== "session_limited" && n.kind !== "approval") return n.kind;
  const t = n.target;
  return `${n.kind}:${t.page}:${"key" in t ? t.key : "id" in t ? t.id : ""}:${t.sessionId ?? ""}`;
}

/**
 * 卡片的 React key：认的是这一件事本身（哪一问、哪一条提醒、哪个 session），不只是 ticket + PR + 类别——
 * 同一个 session 接连问两句、总控的几句、同类的几条提醒都同在一个 ticket（或都不在）下，key 一样会让
 * 答完的上一张卡的「已回答」留到下一张上。
 */
export function cardKey(item: TurnItem): string {
  const t = item.turn;
  const base = `${item.ticketKey ?? ""}|${item.pr ? `${item.pr.repo}#${item.pr.number}` : ""}|${t.owner}:${t.kind}`;
  if (t.owner !== "you") return base;
  switch (t.kind) {
    case "answer": return `${base}|${t.askId ?? `s:${t.sessionId ?? ""}`}`;
    case "stuck":
    case "unattended": return `${base}|${t.sessionId ?? ""}`;
    case "shipherd": return `${base}|${noticeKey(t.notice)}`;
    case "review": return `${base}|${t.url}`;
    case "merge": return base;
  }
}

export function youCards(items: TurnItem[]): TurnItem[] {
  return items.filter((i) => i.turn.owner === "you").sort((a, b) => youRank(a.turn) - youRank(b.turn) || a.since - b.since);
}

export function capCards(cards: TurnItem[], expanded: boolean): { shown: TurnItem[]; hidden: number } {
  if (expanded || cards.length <= HOME_CARD_CAP) return { shown: cards, hidden: 0 };
  return { shown: cards.slice(0, HOME_CARD_CAP), hidden: cards.length - HOME_CARD_CAP };
}

export function homeTitle(n: number, S: UiStrings): string {
  return n === 0 ? S.hm.titleZero : S.hm.title(n);
}

export function homeLede(c: TurnBoard["counts"], S: UiStrings): string {
  return c.agent === 0 && c.external === 0 && c.mergedToday === 0 ? S.hm.ledeIdle : S.hm.lede(c.agent, c.external, c.mergedToday);
}

export type CardAction = { id: "answer"; option: string; primary: boolean } | { id: "openPr" | "look" | "fix" | "send" | "ignore"; primary: boolean };

/** 卡片上的 1–3 个按钮；shipherd 卡用 Notice 自己的按钮，这里给空。 */
export function cardActions(item: TurnItem): CardAction[] {
  const t = item.turn;
  const look = (primary: boolean): CardAction => ({ id: "look", primary });
  if (t.owner !== "you") return [];
  switch (t.kind) {
    case "answer": {
      if (t.askId === null || t.options.length === 0) return [look(true)];
      return [...t.options.slice(0, 2).map((option, i): CardAction => ({ id: "answer", option, primary: i === 0 })), look(false)];
    }
    case "merge": return item.pr?.url ? [{ id: "openPr", primary: true }, look(false)] : [look(true)];
    case "review": return [{ id: "openPr", primary: true }];
    case "stuck": {
      if (t.sessionId === null) return [look(true)];
      // 修复 session 开在卡住的 ticket 上（session-service 要它属于这个 feature）：总控卡住时 ticketKey 为 null，不给这个按钮。
      const fix: CardAction[] = item.featureId !== null && item.ticketKey !== null ? [{ id: "fix", primary: false }] : [];
      // 只有「很久没输出」判的卡住可能是误判（比如在跑很长的测试），给一个「忽略」：这一次不再提醒，直到它又动起来再卡住。
      const ignore: CardAction[] = t.source === "silent" ? [{ id: "ignore", primary: false }] : [];
      return [look(true), ...fix, ...ignore];
    }
    case "unattended": return t.canSend && item.ticketKey !== null && item.pr !== null ? [{ id: "send", primary: true }, look(false)] : [look(true)];
    case "shipherd": return [];
  }
}

export function prUrl(item: TurnItem): string | null {
  if (item.turn.owner === "you" && item.turn.kind === "review") return item.turn.url;
  return item.pr?.url || null;
}

function sessionOf(t: Turn): string | null {
  if (t.owner === "agent") return t.sessionId;
  if (t.owner === "you" && (t.kind === "answer" || t.kind === "stuck" || t.kind === "unattended")) return t.sessionId;
  return null;
}

/**
 * 「去看看」落到哪里：有 ticket 就去 ticket 页（带 session 时落在它的终端）；
 * 没有 ticket 的提问来自 feature 的总控或者全局总控，落到那一页的那个 session。
 */
export function lookTarget(item: TurnItem): NowTarget | null {
  const sessionId = sessionOf(item.turn);
  if (item.ticketKey !== null) return { page: "ticket", key: item.ticketKey, sessionId };
  if (sessionId === null) return null;
  if (item.featureId !== null) return { page: "feature", id: item.featureId, sessionId };
  return { page: "shipherd", sessionId };
}

/** 「N 分钟前」；不到一分钟就是「刚刚」，不拼成「刚刚前」/“just now ago”。 */
function agoText(ms: number, S: UiStrings, ago: (d: string) => string, now: string = S.durationNow): string {
  const d = formatDuration(ms, S);
  return d === S.durationNow ? now : ago(d);
}

export interface NameCtx { features: Map<number, string>; tickets: Map<string, string | null> }

/** path 是整行（放进 title）；显示时 scope 可以省略，key（ticket 号）单独放、不省略。 */
export function locationOf(item: TurnItem, ctx: NameCtx, now: number, S: UiStrings): { path: string; scope: string; key: string | null; age: string } {
  const since = item.since > 0 ? now - item.since : null;
  const t = item.turn;
  if (t.owner === "you" && t.kind === "review") {
    const where = item.pr ? `${item.pr.repo}#${item.pr.number}` : t.title;
    const path = `${where} · ${t.author}`;
    return { path, scope: path, key: null, age: since === null ? "" : agoText(since, S, S.hm.reviewAgo, S.hm.reviewNow) };
  }
  const parts: string[] = [];
  const feature = item.featureId === null ? undefined : ctx.features.get(item.featureId);
  if (feature) parts.push(feature);
  if (parts.length === 0 && item.ticketKey === null && item.featureId === null) parts.push(S.shipherdNav);
  const scope = parts.join(" › ");
  const key = item.ticketKey;
  const age = since === null ? "" : agoText(since, S, S.hm.ago);
  if (key === null) return { path: scope, scope, key, age };
  return { path: scope ? `${scope} › ${key}` : key, scope: scope ? `${scope} › ` : "", key, age };
}

/** 都结束了：合了的加关掉不做的（BTL-270）。 */
const allMerged = (r: ScopeTurnRow) => r.total > 0 && r.merged + r.closed === r.total;

/** 首页小表：轮到你多的在前，全合了的排最后，最多 8 行。 */
export function visibleScopes(rows: ScopeTurnRow[]): { shown: ScopeTurnRow[]; hidden: number } {
  const sorted = rows.map((r, i) => ({ r, i }))
    .sort((a, b) => Number(allMerged(a.r)) - Number(allMerged(b.r)) || b.r.youCount - a.r.youCount || a.i - b.i)
    .map((x) => x.r);
  return { shown: sorted.slice(0, HOME_SCOPE_CAP), hidden: Math.max(0, sorted.length - HOME_SCOPE_CAP) };
}

const BAR_ORDER: [keyof ScopeTurnRow["bar"], TurnTone][] = [["done", "done"], ["agent", "agent"], ["you", "ask"], ["external", "external"], ["idle", "idle"]];

export function barSegments(bar: ScopeTurnRow["bar"], total: number): { tone: TurnTone; pct: number }[] {
  if (total <= 0) return [];
  return BAR_ORDER.filter(([k]) => bar[k] > 0).map(([k, tone]) => ({ tone, pct: (bar[k] / total) * 100 }));
}

export function scopeRoute(row: ScopeTurnRow): Route {
  if (row.kind === "ticket") return { page: "ticket", key: String(row.id) };
  return { page: "feature", id: Number(row.id) };
}

export function scopeLine(row: ScopeTurnRow, S: UiStrings): string {
  return row.total === 0 ? S.hm.scopeEmpty : S.hm.scopeLine(row.total, row.merged, row.slowest, row.closed);
}

/** feature 汇总行的「谁该动」（看 scope 行的计数）。单独的 ticket 不用它：ticket 行的 bar 按 PR 计，看不出 session 在干活，用 ticketWhoTurn。 */
export function scopeWho(row: ScopeTurnRow, S: UiStrings): { tone: TurnTone | null; text: string } {
  if (row.youCount > 0) return { tone: "ask", text: S.hm.whoYou(row.youCount) };
  if (row.bar.agent > 0) return { tone: "agent", text: S.hm.whoAgent };
  if (row.bar.external > 0) return { tone: "external", text: S.hm.whoExternal };
  if (allMerged(row)) return row.closed === row.total ? { tone: "idle", text: S.hm.whoClosed } : { tone: "done", text: S.hm.whoDone };
  return { tone: "idle", text: S.hm.whoIdle };
}

/**
 * 一个 ticket 自己的那一项：主进程标了 ticketLevel 的那条（它的 ticketTurn 选的，首页、范围页的表格都是它）。
 * 多出来的提问再急也不是 ticket 的状态。不在板上（合了、没开始的不在不带 filter 的板上）为 null。
 */
export function ticketItem(items: TurnItem[], ticketKey: string): TurnItem | null {
  return items.find((i) => i.ticketKey === ticketKey && i.ticketLevel === true) ?? null;
}

/**
 * 全部工作里一个单独 ticket 的「谁该动」：ticket 自己的轮次（同首页「进行中」、范围页的表格，用 whoLabel 说）；
 * 不在板上时按它自己的 scope 行是合了还是没开始；什么都不知道为 null（写「—」）。
 */
export function ticketWhoTurn(items: TurnItem[], scope: ScopeTurnRow | null, ticketKey: string): Turn | null {
  const own = ticketItem(items, ticketKey);
  if (own) return own.turn;
  if (scope === null || scope.total === 0) return null;
  if (scope.closed >= scope.total) return { owner: "done", kind: "closed" };
  return scope.merged + scope.closed >= scope.total ? { owner: "done", kind: "merged" } : { owner: "idle", kind: "not_started" };
}

/**
 * 全部工作里一个单独 ticket 的「现在怎么样」：板上有它自己的那一项就写那一项的一句话；
 * 没有（合了、还没开始的不在不带 filter 的板上）就按它自己的 scope 行说「合了」「还没开始」，什么都不知道写「—」。
 * 不写 scope 级的「1 个里合了 1 个」。
 */
export function ticketNowText(items: TurnItem[], scope: ScopeTurnRow | null, ticketKey: string, S: UiStrings): string {
  const own = ticketItem(items, ticketKey);
  if (own) return own.others > 0 ? `${turnSentence(own.turn, own, S)} · ${S.lay.morePrs(own.others)}` : turnSentence(own.turn, own, S);
  if (scope === null || scope.total === 0) return "—";
  if (scope.closed >= scope.total) return S.turn.closed;
  if (scope.merged + scope.closed >= scope.total) return S.turn.done;
  if (scope.bar.idle > 0) return S.turn.idle;
  return "—";
}

export interface RunningRow { key: string; ticketKey: string | null; owner: "agent" | "external"; who: string; sentence: string; age: string }

/** 「进行中」：agent 和外部在推进的项，等得久的在前。ticket 还有别的 PR 时那句话后面加「另有 N 个 PR」（spec §5.1）。 */
export function runningRows(items: TurnItem[], S: UiStrings, now: number): RunningRow[] {
  const rows: { since: number; row: RunningRow }[] = [];
  for (const i of items) {
    const t = i.turn;
    if (t.owner !== "agent" && t.owner !== "external") continue;
    const who = t.owner === "agent" ? S.hm.whoAgent : externalWho(t, S);
    const pr = i.pr ? `${i.pr.repo}#${i.pr.number}` : "";
    rows.push({ since: i.since, row: {
      // 不属于 ticket 的（feature 的总控）同页可以有好几个在干活：key 带上 session。
      key: `${i.ticketKey ?? ""}|${pr}|${t.kind}${i.ticketKey === null ? `|${sessionOf(t) ?? ""}` : ""}`, ticketKey: i.ticketKey, owner: t.owner, who,
      sentence: i.others > 0 ? `${turnSentence(t, i, S)} · ${S.lay.morePrs(i.others)}` : turnSentence(t, i, S), age: i.since > 0 ? agoText(now - i.since, S, S.hm.ago) : "",
    } });
  }
  return rows.sort((a, b) => a.since - b.since).map((r) => r.row);
}

/**
 * 第 1 层的 turn:home-opened：路由从别的页切到首页（含启动就在首页）时发一次，停在首页时不再发。
 * App 在 route.page 变化的 effect 里问它；turn:changed 引起的重取不改路由，所以不会走到这里。
 * 记的是上一次看到的页面，所以 StrictMode 下 effect 多跑一遍也不会发两次。
 */
export function homeOpenedSignal(): { observe: (page: string) => boolean } {
  let last: string | null = null;
  return {
    observe(page) {
      const opened = page === "home" && last !== "home";
      last = page;
      return opened;
    },
  };
}

/** 一件工作都没有时首页整页放 FirstRunHome（第 6 层的组件）：三个新建按钮开对话框，设置链接去「设置 › 功能」。 */
export function firstRunProps(d: { onNewTicket: () => void; onNewFeature: () => void; onGo: (r: Route) => void }): FirstRunHomeProps {
  return { onNewTicket: d.onNewTicket, onNewFeature: d.onNewFeature, onOpenSettings: () => d.onGo({ page: "settings", section: "features" }) };
}
