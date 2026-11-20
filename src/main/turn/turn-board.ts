// 「谁该动」看板（UI 重做第 1 层，计划 R8）：把 TurnService 拼好的输入算成 items、counts、scopes。纯函数。
import {
  mostUrgent, normTurnFilter, slowestOf, ticketTurn,
  type ScopeTurnRow, type TimedTurn, type Turn, type TurnBoard, type TurnFilter, type TurnItem, type TurnOwner,
} from "../../shared/turn";

export interface BoardPr { repo: string; number: number; title: string; url: string; turn: Turn; since: number; mergedAt: number | null }
export interface BoardTicket {
  key: string;
  name: string;
  featureId: number | null;
  /** 没关闭的 PR。 */
  prs: BoardPr[];
  /** 非 PR 的候选（R4）。 */
  others: TimedTurn[];
  /** 第一条以后没回答的 ask_user（R6）。 */
  moreAsks: TimedTurn[];
}
export interface LooseItem { turn: Turn; since: number; epicId: number | null; featureId: number | null }
export interface BoardReview { repo: string; number: number; title: string; url: string; author: string; since: number }
export interface BoardInput {
  epics: { id: number; name: string }[];
  features: { id: number; name: string; epicId: number | null }[];
  tickets: BoardTicket[];
  loose: LooseItem[];
  reviews: BoardReview[];
  /** 本地今天 0 点。 */
  dayStart: number;
  now: number;
}

/** 一个 ticket 算一次的结果：ticket 的 turn、来源 PR、since、别的 PR 个数。counts、items 和 scope 行都用这一份。 */
interface TicketCalc {
  t: BoardTicket;
  epicId: number | null;
  turn: Turn;
  pr: BoardPr | null;
  since: number;
  others: number;
  /** 别的 session 的提问：others 里 mostUrgent 只取一条，其余的提问不能折掉，各自出一条提问 item（同 moreAsks）。 */
  extraAsks: TimedTurn[];
  /** 不带 filter 口径下 owner 为 you 的条数：ticket 那条再加 moreAsks 和 extraAsks。 */
  youCount: number;
}

type Bar = ScopeTurnRow["bar"];
const emptyBar = (): Bar => ({ done: 0, agent: 0, you: 0, external: 0, idle: 0 });
const live = (o: TurnOwner) => o === "you" || o === "agent" || o === "external";
const prRef = (p: { repo: string; number: number; title: string; url: string }) => ({ repo: p.repo, number: p.number, title: p.title, url: p.url });

const isAsk = (o: TimedTurn) => o.turn.owner === "you" && o.turn.kind === "answer";

function calcTicket(t: BoardTicket, epicId: number | null): TicketCalc {
  const session = mostUrgent(t.others);
  const r = ticketTurn(t.prs.map((p) => p.turn), session?.turn ?? null);
  // 按引用找来源：PR 的 turn 还是 others 里那条
  const pr = t.prs.find((p) => p.turn === r.turn) ?? null;
  const since = pr ? pr.since : session && session.turn === r.turn ? session.since : 0;
  const extraAsks = t.others.filter((o) => o.turn !== r.turn && isAsk(o));
  const youCount = (r.turn.owner === "you" ? 1 : 0) + t.moreAsks.filter((a) => a.turn.owner === "you").length + extraAsks.length;
  return { t, epicId, turn: r.turn, pr, since, others: r.others, extraAsks, youCount };
}

const normFilter = normTurnFilter;

export function buildTurnBoard(input: BoardInput, rawFilter: TurnFilter | null): TurnBoard {
  const filter = normFilter(rawFilter);
  const featureEpic = new Map(input.features.map((f) => [f.id, f.epicId]));
  const epicOfFeature = (id: number | null) => (id === null ? null : featureEpic.get(id) ?? null);
  const calcs = input.tickets.map((t) => calcTicket(t, epicOfFeature(t.featureId)));

  // 范围
  const inScope = (c: TicketCalc) =>
    filter === null ? true
      : filter.ticketKey !== undefined ? c.t.key === filter.ticketKey
        : filter.featureId !== undefined ? c.t.featureId === filter.featureId
          : c.epicId === filter.epicId;
  const looseInScope = (l: LooseItem) =>
    filter === null ? true
      : filter.ticketKey !== undefined ? false
        : filter.featureId !== undefined ? l.featureId === filter.featureId
          : (l.epicId ?? epicOfFeature(l.featureId)) === filter.epicId;
  const scoped = calcs.filter(inScope);
  const loose = input.loose.filter(looseInScope);

  const looseItem = (l: LooseItem): TurnItem => ({
    ticketKey: null, pr: null, epicId: l.epicId ?? epicOfFeature(l.featureId), featureId: l.featureId, turn: l.turn, since: l.since, others: 0,
  });
  const askItem = (c: TicketCalc, a: TimedTurn): TurnItem => ({
    ticketKey: c.t.key, pr: null, epicId: c.epicId, featureId: c.t.featureId, turn: a.turn, since: a.since, others: 0,
  });

  // items
  const items: TurnItem[] = [];
  if (filter === null) {
    for (const c of scoped) {
      items.push({ ticketKey: c.t.key, pr: c.pr ? prRef(c.pr) : null, epicId: c.epicId, featureId: c.t.featureId, turn: c.turn, since: c.since, others: c.others, ticketLevel: true });
      for (const a of c.t.moreAsks) items.push(askItem(c, a));
      for (const a of c.extraAsks) items.push(askItem(c, a));
    }
    for (const l of loose) items.push(looseItem(l));
    for (const r of input.reviews) {
      items.push({
        ticketKey: null, pr: prRef(r), epicId: null, featureId: null,
        turn: { owner: "you", kind: "review", author: r.author, title: r.title, url: r.url }, since: r.since, others: 0,
      });
    }
  } else {
    // 带 filter：按 PR 拆开，再加 session 级的那条；出 done（ticket 页要显示「合了」），不出 idle，不含请你 review 的 PR。
    // ticket 的轮次是从哪一条来的（calcTicket 按引用选的），那一条标上 ticketLevel、带上别的 PR 个数：前端照它显示，不再自己选。
    const own = (c: TicketCalc, turn: Turn) => (turn === c.turn ? { others: c.others, ticketLevel: true as const } : { others: 0 });
    for (const c of scoped) {
      for (const p of c.t.prs) items.push({ ticketKey: c.t.key, pr: prRef(p), epicId: c.epicId, featureId: c.t.featureId, turn: p.turn, since: p.since, ...own(c, p.turn) });
      const s = mostUrgent(c.t.others);
      if (s) items.push({ ticketKey: c.t.key, pr: null, epicId: c.epicId, featureId: c.t.featureId, turn: s.turn, since: s.since, ...own(c, s.turn) });
      for (const a of c.t.moreAsks) items.push(askItem(c, a));
      // 上面 session 那条已经出了的不重复出
      for (const a of c.extraAsks) if (a !== s) items.push(askItem(c, a));
    }
    for (const l of loose) items.push(looseItem(l));
  }
  const shown = items.filter((i) => (filter === null ? live(i.turn.owner) : i.turn.owner !== "idle"));

  // counts：一个 ticket 一条，加 moreAsks、loose 和 review（带 filter 时不含 review）
  const counts = { you: 0, agent: 0, external: 0, mergedToday: 0 };
  const bump = (o: TurnOwner) => { if (o === "you" || o === "agent" || o === "external") counts[o]++; };
  for (const c of scoped) {
    bump(c.turn.owner);
    for (const a of c.t.moreAsks) bump(a.turn.owner);
    for (const a of c.extraAsks) bump(a.turn.owner);
  }
  for (const l of loose) bump(l.turn.owner);
  if (filter === null) counts.you += input.reviews.length;
  const mergedUrls = new Set<string>();
  for (const c of scoped) for (const p of c.t.prs) if (p.mergedAt !== null && p.mergedAt >= input.dayStart) mergedUrls.add(p.url);
  counts.mergedToday = mergedUrls.size;

  // scopes
  const looseYou = (pred: (l: LooseItem) => boolean) => input.loose.filter((l) => l.turn.owner === "you" && pred(l)).length;
  const ticketRow = (c: TicketCalc): ScopeTurnRow => {
    const members = c.t.prs.length > 0
      ? c.t.prs.map((p) => ({ name: `${p.repo}#${p.number}`, owner: p.turn.owner, progressAt: p.since }))
      : [{ name: c.t.name, owner: c.turn.owner, progressAt: c.since }];
    return row("ticket", c.t.key, c.t.name, members, c.youCount);
  };
  const ticketsOfFeature = (id: number) => calcs.filter((c) => c.t.featureId === id);
  const ticketMembers = (cs: TicketCalc[]) => cs.map((c) => ({ name: c.t.name, owner: c.turn.owner, progressAt: c.since }));
  const featureRow = (f: { id: number; name: string }): ScopeTurnRow => {
    const cs = ticketsOfFeature(f.id);
    const you = cs.reduce((n, c) => n + c.youCount, 0) + looseYou((l) => l.featureId === f.id);
    return row("feature", f.id, f.name, ticketMembers(cs), you);
  };
  const epicRow = (e: { id: number; name: string }): ScopeTurnRow => {
    const fs = input.features.filter((f) => f.epicId === e.id);
    const cs = fs.flatMap((f) => ticketsOfFeature(f.id));
    const r = row("epic", e.id, e.name, ticketMembers(cs), 0);
    r.youCount = fs.reduce((n, f) => n + featureRow(f).youCount, 0) + looseYou((l) => l.epicId === e.id && l.featureId === null);
    // epic 的成员是 feature：每组取活跃 ticket 的 since 的最大值（这一组最近一次动的时间）
    r.slowest = slowestOf(fs.flatMap((f) => {
      const act = ticketsOfFeature(f.id).filter((c) => live(c.turn.owner));
      const top = mostUrgent(act);
      return top ? [{ name: f.name, owner: top.turn.owner, progressAt: Math.max(...act.map((c) => c.since)) }] : [];
    }));
    return r;
  };

  const scopes: ScopeTurnRow[] = [];
  if (filter === null) {
    for (const e of input.epics) scopes.push(epicRow(e));
    for (const f of input.features) if (f.epicId === null) scopes.push(featureRow(f));
    for (const c of calcs) if (c.t.featureId === null) scopes.push(ticketRow(c));
  } else if (filter.ticketKey !== undefined) {
    for (const c of scoped) scopes.push(ticketRow(c));
  } else if (filter.featureId !== undefined) {
    const f = input.features.find((x) => x.id === filter.featureId);
    if (f) {
      scopes.push(featureRow(f));
      for (const c of scoped) scopes.push(ticketRow(c));
    }
  } else {
    const e = input.epics.find((x) => x.id === filter.epicId);
    if (e) {
      scopes.push(epicRow(e));
      for (const f of input.features) if (f.epicId === e.id) scopes.push(featureRow(f));
    }
  }

  return { items: shown, counts, scopes, generatedAt: input.now };
}

function row(kind: ScopeTurnRow["kind"], id: number | string, name: string, members: { name: string; owner: TurnOwner; progressAt: number }[], youCount: number): ScopeTurnRow {
  const bar = emptyBar();
  for (const m of members) bar[m.owner]++;
  return { kind, id, name, total: members.length, merged: bar.done, bar, youCount, slowest: slowestOf(members) };
}
