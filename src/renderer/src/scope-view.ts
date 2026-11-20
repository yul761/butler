// 范围页（epic / feature）的纯函数（UI 重做第 3 层）：ticket 一行、按 feature 分组、进度那一句、谁该动的字。
// 状态一律取自第 1 层：ticket 的轮次是主进程标了 ticketLevel 的那条，这里不重新判断任何 PR 或 ticket 的状态。
import type { ScopeTurnRow, Turn, TurnItem } from "../../shared/turn";
import type { TicketView } from "../../shared/types";
import { runningRows, ticketItem, youCards, type RunningRow } from "./home-view";
import type { UiStrings } from "./strings";
import { externalWho } from "./turn-text";

export interface TicketRow {
  key: string;
  title: string | null;
  featureId: number | null;
  turn: Turn;
  others: number;
  item: TurnItem;
  since: number;
  prs: { tag: string; number: number; repo: string }[];
  /** 这个 ticket 多出来的没回答的提问（发问的 session 不在了，不算 ticket 的轮次，首页照样各出一张卡）。 */
  asks: TurnItem[];
}

export function prTag(pr: { repo: string; number: number }, multiRepo: boolean): string {
  return multiRepo ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
}

const NOT_STARTED: Turn = { owner: "idle", kind: "not_started" };

/** 一个 ticket 的那几条里，除了它自己那条以外没回答的提问（ticket 自己的轮次不是活的时候也要出）。 */
function extraAsks(mine: TurnItem[], own: TurnItem | null): TurnItem[] {
  return mine.filter((i) => i !== own && i.pr === null && i.turn.owner === "you" && i.turn.kind === "answer");
}

/**
 * 一个 ticket 在看板里的那几条（带 filter 时按 PR 拆开的、session 级的、多出来的提问）里，主进程标了 ticketLevel 的那一条（ticketItem）：
 * 主进程用 ticketTurn 选好的 ticket 级轮次（首页也是它），前端不再自己选（spec「不并存两套状态算法」）。
 * 没有这一条（没开始：板上不出 idle）时 item 为 null。
 */
function ticketPick(key: string, mine: TurnItem[]): { turn: Turn; others: number; item: TurnItem | null } {
  const item = ticketItem(mine, key);
  return item === null ? { turn: NOT_STARTED, others: 0, item: null } : { turn: item.turn, others: item.others, item };
}

export function ticketRows(tickets: Pick<TicketView, "key" | "title" | "featureId" | "effectiveStatus">[], items: TurnItem[]): TicketRow[] {
  return tickets.map((t) => {
    const mine = items.filter((i) => i.ticketKey === t.key);
    const { turn, others, item: picked } = ticketPick(t.key, mine);
    const item: TurnItem = picked ?? {
      ticketKey: t.key, pr: null, epicId: null, featureId: t.featureId, since: 0, others,
      turn: t.effectiveStatus === "done" ? { owner: "done", kind: "merged" } : turn,
    };
    const seen = new Map<string, { repo: string; number: number }>();
    for (const i of mine) if (i.pr) seen.set(`${i.pr.repo}#${i.pr.number}`, i.pr);
    const list = [...seen.values()];
    const multi = new Set(list.map((p) => p.repo)).size > 1;
    const prs = list.sort((a, b) => a.number - b.number).map((p) => ({ tag: prTag(p, multi), number: p.number, repo: p.repo }));
    return { key: t.key, title: t.title, featureId: t.featureId, turn: item.turn, others, item, since: item.since, prs, asks: extraAsks(mine, picked) };
  });
}

/**
 * epic / feature 页的「轮到你」卡片、概况页签的标红和「进行中」：和首页、全部 ticket 表格、进度那一句同一口径（spec「不并存两套状态算法」）。
 * 每个 ticket 一条（主进程标了 ticketLevel 的那条，带着别的 PR 个数）；再加这个 ticket 多出来的没回答的提问（首页也各出一张），
 * 和不属于 ticket 的（总控 session、Butler 提醒）。被 ticket 级口径排除的 session 级那条（有 PR 时 session 停着）不出。
 */
export function scopeBoardView(items: TurnItem[], S: UiStrings, now: number): { youItems: TurnItem[]; running: RunningRow[]; attention: boolean } {
  const out: TurnItem[] = [];
  const byTicket = new Map<string, TurnItem[]>();
  for (const i of items) {
    if (i.ticketKey === null) out.push(i);
    else byTicket.set(i.ticketKey, [...(byTicket.get(i.ticketKey) ?? []), i]);
  }
  for (const [key, mine] of byTicket) {
    const item = ticketItem(mine, key);
    // ticket 自己的轮次不在板上（没开始）时，多出来的提问照样出卡。
    if (item !== null) out.push(item);
    out.push(...extraAsks(mine, item));
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

/** 看板里有 PR 的 ticket（带 filter 的看板按 PR 拆开，merged 的也在）。 */
export function ticketsWithPr(items: TurnItem[]): Set<string> {
  return new Set(items.flatMap((i) => (i.pr !== null && i.ticketKey !== null ? [i.ticketKey] : [])));
}

/**
 * 概况里一行的那句：feature 行和有 PR 的 ticket 行是「合了几个」；ticket 没有 PR 时说还没开（不写「0/1 合了」），
 * 但没有 PR 也已经完成的（进度条全绿）说「合了」。
 */
export function scopeRowLine(r: Pick<ScopeTurnRow, "kind" | "id" | "merged" | "total">, withPr: ReadonlySet<string> | undefined, S: UiStrings): string {
  if (r.kind === "ticket" && withPr !== undefined && !withPr.has(String(r.id))) return r.total > 0 && r.merged === r.total ? S.turn.done : S.lay.noPrYet;
  return S.lay.featureCard(r.merged, r.total);
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
    case "external": return externalWho(turn, S);
    case "done": return S.hm.whoDone;
    case "idle": return S.hm.whoIdle;
  }
}

