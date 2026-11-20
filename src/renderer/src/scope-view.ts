// 范围页（epic / feature）的纯函数（UI 重做第 3 层）：ticket 一行、按 feature 分组、进度那一句、谁该动的字。
// 状态一律取自第 1 层的 ticketTurn / mostUrgent，这里不重新判断任何 PR 的状态。
import { mostUrgent, ticketTurn, type ScopeTurnRow, type Turn, type TurnItem } from "../../shared/turn";
import type { TicketView } from "../../shared/types";
import { runningRows, youCards, type RunningRow } from "./home-view";
import type { UiStrings } from "./strings";

export interface TicketRow {
  key: string;
  title: string | null;
  featureId: number | null;
  turn: Turn;
  others: number;
  item: TurnItem;
  since: number;
  prs: { tag: string; number: number; repo: string }[];
}

export function prTag(pr: { repo: string; number: number }, multiRepo: boolean): string {
  return multiRepo ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
}

/**
 * 一个 ticket 在带 filter 的看板里的那几条（按 PR 拆开的、session 级的、多出来的提问）收成 ticket 级的一条：
 * 和主进程不带 filter 时（首页）同一个 ticketTurn。item 是选中的那条；全都不参与时为 null。
 */
function ticketPick(mine: TurnItem[]): { turn: Turn; others: number; item: TurnItem | null } {
  const prTurns = mine.filter((i) => i.pr !== null).map((i) => i.turn);
  const sessionTurn = mostUrgent(mine.filter((i) => i.pr === null))?.turn ?? null;
  const { turn, others } = ticketTurn(prTurns, sessionTurn);
  return { turn, others, item: mine.find((i) => i.turn === turn) ?? null };
}

export function ticketRows(tickets: Pick<TicketView, "key" | "title" | "featureId" | "effectiveStatus">[], items: TurnItem[]): TicketRow[] {
  return tickets.map((t) => {
    const mine = items.filter((i) => i.ticketKey === t.key);
    const { turn, others, item: picked } = ticketPick(mine);
    const item: TurnItem = picked ?? {
      ticketKey: t.key, pr: null, epicId: null, featureId: t.featureId, since: 0, others,
      turn: t.effectiveStatus === "done" ? { owner: "done", kind: "merged" } : turn,
    };
    const seen = new Map<string, { repo: string; number: number }>();
    for (const i of mine) if (i.pr) seen.set(`${i.pr.repo}#${i.pr.number}`, i.pr);
    const list = [...seen.values()];
    const multi = new Set(list.map((p) => p.repo)).size > 1;
    const prs = list.sort((a, b) => a.number - b.number).map((p) => ({ tag: prTag(p, multi), number: p.number, repo: p.repo }));
    return { key: t.key, title: t.title, featureId: t.featureId, turn: item.turn, others, item, since: item.since, prs };
  });
}

/**
 * epic / feature 页的「轮到你」卡片、概况页签的标红和「进行中」：和首页、全部 ticket 表格、进度那一句同一口径（spec「不并存两套状态算法」）。
 * 每个 ticket 一条（ticketPick 选的那条，带上别的 PR 个数）；再加这个 ticket 多出来的没回答的提问（首页也各出一张），
 * 和不属于 ticket 的（总控 session、Butler 提醒）。被 ticket 级口径排除的 session 级那条（有 PR 时 session 停着）不出。
 */
export function scopeBoardView(items: TurnItem[], S: UiStrings, now: number): { youItems: TurnItem[]; running: RunningRow[]; attention: boolean } {
  const out: TurnItem[] = [];
  const byTicket = new Map<string, TurnItem[]>();
  for (const i of items) {
    if (i.ticketKey === null) out.push(i);
    else byTicket.set(i.ticketKey, [...(byTicket.get(i.ticketKey) ?? []), i]);
  }
  for (const mine of byTicket.values()) {
    const { others, item } = ticketPick(mine);
    if (item === null) continue;
    out.push(others === item.others ? item : { ...item, others });
    for (const i of mine) if (i !== item && i.pr === null && i.turn.owner === "you" && i.turn.kind === "answer") out.push(i);
  }
  const youItems = youCards(out);
  return { youItems, running: runningRows(out, S, now), attention: youItems.length > 0 };
}

/** 一组里合了几个。 */
const mergedOf = (rows: TicketRow[]): number => rows.filter((r) => r.turn.owner === "done").length;

/** 按传入的 feature 顺序分组；没有 feature 的行忽略；feature 下没有 ticket 也返回该组。 */
export function groupByFeature(rows: TicketRow[], features: { id: number; name: string }[]): { feature: { id: number; name: string }; rows: TicketRow[]; merged: number }[] {
  return features.map((feature) => {
    const mine = rows.filter((r) => r.featureId === feature.id);
    return { feature, rows: mine, merged: mergedOf(mine) };
  });
}

/** 不分组（feature 页）：一组、没有组名；没有行时没有组（表格显示空状态）。 */
export function flatGroup(rows: TicketRow[]): { name: null; merged: number; total: number; rows: TicketRow[] }[] {
  return rows.length === 0 ? [] : [{ name: null, merged: mergedOf(rows), total: rows.length, rows }];
}

/** 范围自己那一行（epic / feature 的总数）；看板里没有时把它下面的行（feature / ticket）加起来，最慢的不算。 */
export function scopeTotal(scopes: ScopeTurnRow[], kind: "epic" | "feature", id: number): ScopeTurnRow {
  const own = scopes.find((r) => r.kind === kind && r.id === id);
  if (own) return own;
  const child = kind === "epic" ? "feature" : "ticket";
  const sum: ScopeTurnRow = { kind, id, name: "", total: 0, merged: 0, bar: { done: 0, agent: 0, you: 0, external: 0, idle: 0 }, youCount: 0, slowest: null };
  for (const r of scopes) {
    if (r.kind !== child) continue;
    sum.total += r.total;
    sum.merged += r.merged;
    sum.youCount += r.youCount;
    for (const k of Object.keys(sum.bar) as (keyof ScopeTurnRow["bar"])[]) sum.bar[k] += r.bar[k];
  }
  return sum;
}

export function progressLine(r: Pick<ScopeTurnRow, "total" | "merged" | "youCount">, S: UiStrings): string {
  return S.lay.progressLine(r.merged, r.total, r.youCount);
}

export function slowestLine(slowest: string | null, S: UiStrings): string {
  return slowest === null ? S.lay.noSlowest : S.lay.slowest(slowest);
}

export function whoLabel(turn: Turn, S: UiStrings): string {
  switch (turn.owner) {
    case "you": return S.lay.whoYou;
    case "agent": return S.hm.whoAgent;
    case "external": return turn.names.length > 0 ? turn.names.join(S.lay.nameSep) : S.hm.whoExternal;
    case "done": return S.hm.whoDone;
    case "idle": return S.hm.whoIdle;
  }
}

