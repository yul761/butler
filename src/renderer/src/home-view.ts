// 首页（轮到你）和全部工作页的纯函数（UI 重做第 2 层，spec §5.3）。
// 状态由第 1 层的 turn:board 给出，这里只排序、截断、取位置和按钮，不自己算状态，也不拼状态文案。
import type { NowTarget } from "../../shared/types";
import { mostUrgent, YOU_KIND_RANK, type ScopeTurnRow, type Turn, type TurnBoard, type TurnItem, type YouKind } from "../../shared/turn";
import type { Route } from "./App";
import { formatDuration } from "./components/TicketActivity";
import type { UiStrings } from "./strings";
import { turnSentence } from "./turn-text";
import type { TurnTone } from "./turn-tone";

export { turnTone, type TurnTone } from "./turn-tone";

/** 「你」这一类的顺序，和第 1 层 mostUrgent 用的是同一份（YOU_KIND_RANK），不另起一套。 */
export const YOU_KIND_ORDER: readonly YouKind[] = (Object.keys(YOU_KIND_RANK) as YouKind[]).sort((a, b) => YOU_KIND_RANK[a] - YOU_KIND_RANK[b]);
export const HOME_CARD_CAP = 20;
export const HOME_SCOPE_CAP = 8;

const youRank = (t: Turn) => (t.owner === "you" ? YOU_KIND_RANK[t.kind] : 99);

/** 工作区里什么都没有（ticket、feature、epic 都是 0），轮到你的板上也空着：首页只放空状态。板上有 Butler 自己的提醒时照常显示。 */
export function isNoWork(workCount: number, items: TurnItem[] | null): boolean {
  return workCount === 0 && (items ?? []).length === 0;
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

export type CardAction = { id: "answer"; option: string; primary: boolean } | { id: "openPr" | "look" | "fix" | "send"; primary: boolean };

/** 卡片上的 1–3 个按钮；butler 卡用 Notice 自己的按钮，这里给空。 */
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
    case "stuck": return item.featureId !== null && t.sessionId !== null ? [look(true), { id: "fix", primary: false }] : [look(true)];
    case "unattended": return t.canSend && item.ticketKey !== null && item.pr !== null ? [{ id: "send", primary: true }, look(false)] : [look(true)];
    case "butler": return [];
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
 * 没有 ticket 的提问来自 feature、epic 的总控或者全局总控，落到那一页的那个 session。
 */
export function lookTarget(item: TurnItem): NowTarget | null {
  const sessionId = sessionOf(item.turn);
  if (item.ticketKey !== null) return { page: "ticket", key: item.ticketKey, sessionId };
  if (sessionId === null) return null;
  if (item.featureId !== null) return { page: "feature", id: item.featureId, sessionId };
  if (item.epicId !== null) return { page: "epic", id: item.epicId, sessionId };
  return { page: "butler", sessionId };
}

export interface NameCtx { epics: Map<number, string>; features: Map<number, string>; tickets: Map<string, string | null> }

export function locationOf(item: TurnItem, ctx: NameCtx, now: number, S: UiStrings): { path: string; age: string } {
  const d = item.since > 0 ? formatDuration(now - item.since, S) : null;
  const t = item.turn;
  if (t.owner === "you" && t.kind === "review") {
    const where = item.pr ? `${item.pr.repo}#${item.pr.number}` : t.title;
    return { path: `${where} · ${t.author}`, age: d === null ? "" : S.hm.reviewAgo(d) };
  }
  const parts: string[] = [];
  const epic = item.epicId === null ? undefined : ctx.epics.get(item.epicId);
  const feature = item.featureId === null ? undefined : ctx.features.get(item.featureId);
  if (epic) parts.push(epic);
  if (feature) parts.push(feature);
  if (item.ticketKey !== null) parts.push(item.ticketKey);
  if (parts.length === 0 && item.epicId === null && item.featureId === null) parts.push(S.butlerNav);
  return { path: parts.join(" › "), age: d === null ? "" : S.hm.ago(d) };
}

const allMerged = (r: ScopeTurnRow) => r.total > 0 && r.merged === r.total;

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
  return row.kind === "epic" ? { page: "epic", id: Number(row.id) } : { page: "feature", id: Number(row.id) };
}

export function scopeLine(row: ScopeTurnRow, S: UiStrings): string {
  return row.total === 0 ? S.hm.scopeEmpty : S.hm.scopeLine(row.total, row.merged, row.slowest);
}

export function scopeWho(row: ScopeTurnRow, S: UiStrings): { tone: TurnTone | null; text: string } {
  if (row.youCount > 0) return { tone: "ask", text: S.hm.whoYou(row.youCount) };
  if (row.bar.agent > 0) return { tone: "agent", text: S.hm.whoAgent };
  if (row.bar.external > 0) return { tone: "external", text: S.hm.whoExternal };
  if (allMerged(row)) return { tone: "done", text: S.hm.whoDone };
  return { tone: "idle", text: S.hm.whoIdle };
}

/** 一个 ticket 里最急的那一项（第 1 层的 mostUrgent）。 */
export function topItem(items: TurnItem[], ticketKey: string): TurnItem | null {
  return mostUrgent(items.filter((i) => i.ticketKey === ticketKey));
}

export interface RunningRow { key: string; ticketKey: string | null; owner: "agent" | "external"; who: string; sentence: string; age: string }

/** 「进行中」：agent 和外部在推进的项，等得久的在前。 */
export function runningRows(items: TurnItem[], S: UiStrings, now: number): RunningRow[] {
  const rows: { since: number; row: RunningRow }[] = [];
  for (const i of items) {
    const t = i.turn;
    if (t.owner !== "agent" && t.owner !== "external") continue;
    const who = t.owner === "agent" ? S.hm.whoAgent : t.names.length > 0 ? t.names.join(", ") : t.kind === "ci_running" ? S.hm.whoCi : S.hm.whoExternal;
    const pr = i.pr ? `${i.pr.repo}#${i.pr.number}` : "";
    rows.push({ since: i.since, row: {
      key: `${i.ticketKey ?? ""}|${pr}|${t.kind}`, ticketKey: i.ticketKey, owner: t.owner, who,
      sentence: turnSentence(t, i, S), age: i.since > 0 ? S.hm.ago(formatDuration(now - i.since, S)) : "",
    } });
  }
  return rows.sort((a, b) => a.since - b.since).map((r) => r.row);
}
