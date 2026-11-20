import { describe, expect, it } from "vitest";
import type { ScopeTurnRow, Turn, TurnItem } from "../../shared/turn";
import { flatGroup, groupByFeature, prTag, progressLine, scopeBoardView, scopeRowLine, scopeTotal, slowestLine, ticketRows, ticketsWithPr, whoLabel } from "./scope-view";
import { runningRows } from "./home-view";
import { buildTurnBoard, type BoardInput, type BoardPr, type BoardTicket, type LooseItem } from "../../main/turn/turn-board";
import { STRINGS } from "./strings";

const S = STRINGS.zh;
const SE = STRINGS.en;

const item = (key: string, turn: Turn, pr: { repo: string; number: number } | null, o: Partial<TurnItem> = {}): TurnItem => ({
  ticketKey: key, pr: pr && { ...pr, title: "t", url: "u" }, epicId: 1, featureId: 10, turn, since: 5, others: 0, ...o,
});
const ext: Turn = { owner: "external", kind: "ci_running", names: ["CI"] };
const you: Turn = { owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: null };
const agent: Turn = { owner: "agent", kind: "working", sessionId: "s" };
const tk = (key: string, featureId: number | null = 10, effectiveStatus: "done" | "in_progress" = "in_progress") =>
  ({ key, title: `T ${key}`, featureId, effectiveStatus }) as never;

describe("ticketRows", () => {
  it("takes the item main marked as the ticket's own turn (with its other-PR count) and lists every PR", () => {
    const a = item("K-1", ext, { repo: "app", number: 52 });
    const b = item("K-1", you, { repo: "app", number: 51 }, { ticketLevel: true, others: 1 });
    const s = item("K-1", agent, null);
    const [row] = ticketRows([tk("K-1")], [a, b, s]);
    expect(row.turn.owner).toBe("you");
    expect(row.others).toBe(1);
    expect(row.item).toBe(b);
    expect(row.prs.map((p) => p.number)).toEqual([51, 52]);
    expect(row.prs[0].tag).toBe("#51");
  });
  it("an item main did not mark never becomes the ticket's turn, however urgent", () => {
    const marked = item("K-1", { owner: "external", kind: "awaiting_review", names: [] }, { repo: "app", number: 5 }, { ticketLevel: true });
    const urgent = item("K-1", you, null);
    const [row] = ticketRows([tk("K-1")], [urgent, marked]);
    expect(row.item).toBe(marked);
  });
  it("tags PRs with the repo when there are several repos", () => {
    const [row] = ticketRows([tk("K-1")], [item("K-1", ext, { repo: "app", number: 52 }), item("K-1", ext, { repo: "api", number: 7 })]);
    expect(row.prs.map((p) => p.tag)).toEqual(["api#7", "app#52"]);
  });
  it("synthesizes done and idle rows", () => {
    const [d, i] = ticketRows([tk("K-2", 10, "done"), tk("K-3")], []);
    expect(d.turn).toEqual({ owner: "done", kind: "merged" });
    expect(i.turn).toEqual({ owner: "idle", kind: "not_started" });
    expect(d.item).toMatchObject({ ticketKey: "K-2", pr: null, since: 0, turn: d.turn });
    expect(i.since).toBe(0);
  });
});

describe("groupByFeature", () => {
  it("follows feature order, counts merged, keeps empty groups, ignores featureId null", () => {
    const rows = ticketRows([tk("A", 2, "done"), tk("B", 1), tk("C", null)], []);
    const g = groupByFeature(rows, [{ id: 1, name: "one" }, { id: 2, name: "two" }, { id: 3, name: "three" }]);
    expect(g.map((x) => [x.feature.id, x.rows.map((r) => r.key), x.merged])).toEqual([[1, ["B"], 0], [2, ["A"], 1], [3, [], 0]]);
  });
});

describe("lines and labels", () => {
  it("progressLine", () => {
    const r = { total: 15, merged: 9, youCount: 2 };
    expect(progressLine(r, S)).toBe("15 个里合了 9 个 · 2 件轮到你");
    expect(progressLine({ ...r, youCount: 0 }, S)).toBe("15 个里合了 9 个 · 没有事轮到你");
    expect(progressLine({ total: 0, merged: 0, youCount: 0 }, S)).toBe("还没有 ticket");
    expect(progressLine(r, SE)).toBe("9 of 15 merged · 2 waiting on you");
    expect(progressLine({ ...r, youCount: 0 }, SE)).toBe("9 of 15 merged · nothing waiting on you");
    expect(progressLine({ total: 0, merged: 0, youCount: 0 }, SE)).toBe("No tickets yet");
  });
  it("slowestLine", () => {
    expect(slowestLine("收尾 R/X", S)).toBe("最慢的是「收尾 R/X」。");
    expect(slowestLine(null, S)).toBe("没有明显落后的。");
  });
  it("whoLabel", () => {
    expect(whoLabel(you, S)).toBe("你");
    expect(whoLabel(agent, S)).toBe("agent");
    expect(whoLabel({ owner: "external", kind: "awaiting_review", names: ["甲", "乙"] }, S)).toBe("甲、乙");
    expect(whoLabel({ owner: "external", kind: "awaiting_review", names: ["a", "b"] }, SE)).toBe("a, b");
    expect(whoLabel({ owner: "external", kind: "awaiting_review", names: [] }, S)).toBe("外部");
    expect(whoLabel({ owner: "done", kind: "merged" }, S)).toBe("合了");
    expect(whoLabel({ owner: "idle", kind: "not_started" }, S)).toBe("没开始");
  });
  it("whoLabel says who the same way as the running tab: CI, the layer below, or the names", () => {
    expect(whoLabel({ owner: "external", kind: "ci_running", names: [] }, S)).toBe("CI");
    expect(whoLabel({ owner: "external", kind: "stack_below", names: ["feature/BTL-0"] }, S)).toBe("栈的下一层");
    const ext = (t: Turn) => ({ ticketKey: "K-1", pr: null, epicId: null, featureId: null, turn: t, since: 1, others: 0 });
    const turns: Turn[] = [
      { owner: "external", kind: "ci_running", names: [] }, { owner: "external", kind: "merge_queue", names: [] },
      { owner: "external", kind: "stack_below", names: ["b"] }, { owner: "external", kind: "awaiting_review", names: ["bob", "amy"] },
    ];
    for (const lang of [S, SE]) for (const t of turns) expect(runningRows([ext(t)], lang, 2)[0].who).toBe(whoLabel(t, lang));
  });
  it("prTag", () => {
    expect(prTag({ repo: "app", number: 52 }, false)).toBe("#52");
    expect(prTag({ repo: "app", number: 52 }, true)).toBe("app#52");
  });
});

describe("scopeTotal", () => {
  const bar = (done: number, you: number): ScopeTurnRow["bar"] => ({ done, agent: 0, you, external: 0, idle: 0 });
  const f1: ScopeTurnRow = { kind: "feature", id: 1, name: "a", total: 3, merged: 1, bar: bar(1, 2), youCount: 2, slowest: "a" };
  const f2: ScopeTurnRow = { kind: "feature", id: 2, name: "b", total: 2, merged: 2, bar: bar(2, 0), youCount: 1, slowest: null };
  it("is the scope's own row when the board has it", () => {
    const own: ScopeTurnRow = { ...f1, kind: "epic", id: 9, name: "E", total: 5 };
    expect(scopeTotal([f1, own, f2], "epic", 9)).toBe(own);
  });
  it("otherwise adds up the rows under it, with no slowest", () => {
    expect(scopeTotal([f1, f2], "epic", 9)).toEqual({ kind: "epic", id: 9, name: "", total: 5, merged: 3, bar: bar(3, 2), youCount: 3, slowest: null });
    expect(scopeTotal([], "epic", 9).total).toBe(0);
  });
  it("for a feature, uses the feature's own row, or else adds up only its ticket rows", () => {
    const own: ScopeTurnRow = { ...f1, id: 4 };
    const t1: ScopeTurnRow = { kind: "ticket", id: "K-1", name: "K-1", total: 2, merged: 1, bar: bar(1, 1), youCount: 1, slowest: "K-1" };
    const t2: ScopeTurnRow = { kind: "ticket", id: "K-2", name: "K-2", total: 1, merged: 0, bar: bar(0, 0), youCount: 0, slowest: null };
    expect(scopeTotal([own, t1, t2], "feature", 4)).toBe(own);
    // 另一个 feature 的行不算它自己的；feature 行也不算进 ticket 的和里。
    expect(scopeTotal([f1, t1, t2], "feature", 4)).toEqual({ kind: "feature", id: 4, name: "", total: 3, merged: 1, bar: bar(1, 1), youCount: 1, slowest: null });
    expect(scopeTotal([f1], "feature", 4).total).toBe(0);
  });
});

describe("flatGroup", () => {
  it("is one unnamed group with the same merged count as groupByFeature, or nothing when there are no rows", () => {
    const rows = ticketRows([tk("K-1"), tk("K-2", 10, "done"), tk("K-3")], [item("K-1", agent, null)]);
    const [byFeature] = groupByFeature(rows, [{ id: 10, name: "F" }]);
    expect(flatGroup(rows)).toEqual([{ name: null, merged: byFeature.merged, total: 3, rows }]);
    expect(byFeature.merged).toBe(1);
    expect(flatGroup([])).toEqual([]);
  });
});

describe("scopeBoardView (epic / feature overview and running tab)", () => {
  // 看板由主进程按 feature 取（同 FeaturePage），前端只看它标的那条。
  const stopped: Turn = { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s1" };
  const review: Turn = { owner: "external", kind: "awaiting_review", names: ["amy"] };
  const pr = (n: number, turn: Turn): BoardPr => ({ repo: "app", number: n, title: "t", url: `u${n}`, turn, since: n, mergedAt: null });
  const bt = (key: string, o: Partial<BoardTicket>): BoardTicket => ({ key, name: key, featureId: 10, prs: [], others: [], moreAsks: [], ...o });
  const featureBoard = (tickets: BoardTicket[], loose: LooseItem[] = []) => buildTurnBoard({
    epics: [{ id: 1, name: "E" }], features: [{ id: 10, name: "F", epicId: 1 }], tickets, loose, reviews: [], dayStart: 0, now: 1000,
  }, { featureId: 10 }).items;
  it("an open PR waiting for review and a stopped session: no card is your turn, the tab is not flagged", () => {
    const items = featureBoard([bt("K-1", { prs: [pr(5, review)], others: [{ turn: stopped, since: 1 }] })]);
    const v = scopeBoardView(items, S, 1000);
    expect(v.youItems).toEqual([]);
    expect(v.attention).toBe(false);
    // 和全部 ticket 表格同一口径：这个 ticket 在等外部。
    expect(ticketRows([tk("K-1")], items)[0].turn.owner).toBe("external");
  });
  it("a stopped session with no PR is still your turn", () => {
    const v = scopeBoardView(featureBoard([bt("K-1", { others: [{ turn: stopped, since: 1 }] })]), S, 1000);
    expect(v.youItems.map((i) => i.turn)).toEqual([stopped]);
    expect(v.attention).toBe(true);
  });
  it("one card per ticket (the ticket's own turn, with the other PRs counted), plus its extra questions and loose items", () => {
    const merge: Turn = { owner: "you", kind: "merge", risk: null };
    const ask = (id: number): Turn => ({ owner: "you", kind: "answer", question: `q${id}`, options: [], askId: id, sessionId: "s1" });
    const items = featureBoard([
      bt("K-1", { prs: [pr(5, merge), pr(6, merge)] }),
      bt("K-2", { others: [{ turn: ask(1), since: 1 }], moreAsks: [{ turn: ask(2), since: 2 }], prs: [pr(7, review)] }),
    ], [{ turn: ask(9), since: 1, epicId: 1, featureId: 10 }]);
    const v = scopeBoardView(items, S, 1000);
    const k1 = v.youItems.filter((i) => i.ticketKey === "K-1");
    expect(k1).toHaveLength(1);
    expect(k1[0].others).toBe(1);
    expect(v.youItems.filter((i) => i.ticketKey === "K-2").map((i) => i.turn)).toEqual([ask(1), ask(2)]);
    expect(v.youItems.filter((i) => i.ticketKey === null).map((i) => i.turn)).toEqual([ask(9)]);
  });
  it("running lists each ticket once, by the ticket's own turn", () => {
    const ci: Turn = { owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: null };
    const items = featureBoard([
      // K-1：一个 PR 在等 review、session 在干活 → 整个 ticket 是 agent 在推进，一行。
      bt("K-1", { prs: [pr(5, review)], others: [{ turn: agent, since: 1 }] }),
      // K-2：一个 PR 挂了 CI 轮到你，另一个在等 review → 这个 ticket 轮到你，不进「进行中」。
      bt("K-2", { prs: [pr(6, ci), pr(7, review)] }),
    ]);
    const v = scopeBoardView(items, S, 1000);
    expect(v.running.map((r) => [r.ticketKey, r.owner])).toEqual([["K-1", "agent"]]);
  });
});

describe("scopeRowLine / ticketsWithPr", () => {
  it("a ticket with no PR says so; tickets with PRs and feature rows count merged", () => {
    const withPr = ticketsWithPr([item("K-2", ext, { repo: "app", number: 1 }), item("K-3", agent, null), { ...item("K-4", ext, null), ticketKey: null }]);
    expect([...withPr]).toEqual(["K-2"]);
    expect(scopeRowLine({ kind: "ticket", id: "K-3", merged: 0, total: 1 }, withPr, S)).toBe("还没开 PR");
    expect(scopeRowLine({ kind: "ticket", id: "K-2", merged: 0, total: 1 }, withPr, S)).toBe("0/1 合了");
    expect(scopeRowLine({ kind: "feature", id: 3, merged: 1, total: 2 }, withPr, S)).toBe("1/2 合了");
    expect(scopeRowLine({ kind: "ticket", id: "K-3", merged: 0, total: 1 }, withPr, SE)).toBe("No PR yet");
  });
  it("a ticket with no PR that is done (its bar is all green) says merged, not that it has no PR yet", () => {
    expect(scopeRowLine({ kind: "ticket", id: "K-5", merged: 1, total: 1 }, new Set(), S)).toBe(S.turn.done);
    expect(scopeRowLine({ kind: "ticket", id: "K-5", merged: 1, total: 1 }, new Set(), SE)).toBe(SE.turn.done);
    expect(scopeRowLine({ kind: "ticket", id: "K-5", merged: 0, total: 1 }, new Set(), S)).toBe(S.lay.noPrYet);
  });
});

describe("the renderer takes the ticket's turn from main (one state algorithm)", () => {
  // PR 在等 review、session 在干活、还有一条孤儿提问（head 已经不在 known 里，主进程放在 moreAsks）。
  const NOW = 1_000_000;
  const review: Turn = { owner: "external", kind: "awaiting_review", names: ["amy"] };
  const ask: Turn = { owner: "you", kind: "answer", question: "q", options: [], askId: 3, sessionId: "s" };
  const input: BoardInput = {
    epics: [{ id: 1, name: "E" }], features: [{ id: 10, name: "F", epicId: 1 }],
    tickets: [{
      key: "K-1", name: "K-1", featureId: 10,
      prs: [{ repo: "acme/app", number: 5, title: "t", url: "u", turn: review, since: NOW - 9, mergedAt: null }],
      others: [{ turn: agent, since: NOW - 50 }], moreAsks: [{ turn: ask, since: NOW - 4 }],
    }],
    loose: [], reviews: [], dayStart: 0, now: NOW,
  };
  const home = buildTurnBoard(input, null);
  const feature = buildTurnBoard(input, { featureId: 10 });
  const mainTurn = home.items.find((i) => i.ticketKey === "K-1" && i.turn.kind !== "answer")!.turn;
  it("the ticket table says what main says (agent), not the orphan question", () => {
    expect(mainTurn.owner).toBe("agent");
    const [row] = ticketRows([tk("K-1")], feature.items);
    expect(row.turn).toEqual(mainTurn);
    expect(row.others).toBe(1);
  });
  it("the feature page's running tab lists the ticket like the home page does, and the question is still a card", () => {
    const v = scopeBoardView(feature.items, S, NOW);
    expect(v.running.map((r) => [r.ticketKey, r.owner])).toEqual(runningRows(home.items, S, NOW).map((r) => [r.ticketKey, r.owner]));
    expect(v.running.map((r) => r.ticketKey)).toEqual(["K-1"]);
    expect(v.youItems.map((i) => i.turn)).toEqual([ask]);
  });
});

describe("an orphan question on a ticket with nothing else going (no PR, no live session)", () => {
  // 发问的 session 已经结束（提问进了 moreAsks），也没有别的活 session：ticket 自己的轮次是没开始，主进程不出 ticketLevel 那条。
  const NOW = 1_000_000;
  const ask: Turn = { owner: "you", kind: "answer", question: "q", options: [], askId: 3, sessionId: "s" };
  const input: BoardInput = {
    epics: [{ id: 1, name: "E" }], features: [{ id: 10, name: "F", epicId: 1 }],
    tickets: [{ key: "K-1", name: "K-1", featureId: 10, prs: [], others: [], moreAsks: [{ turn: ask, since: NOW - 4 }] }],
    loose: [], reviews: [], dayStart: 0, now: NOW,
  };
  it("the home page has the card, and so do the feature and epic pages, with the overview flagged", () => {
    const home = buildTurnBoard(input, null);
    expect(home.items.filter((i) => i.turn.kind === "answer")).toHaveLength(1);
    for (const f of [{ featureId: 10 }, { epicId: 1 }]) {
      const v = scopeBoardView(buildTurnBoard(input, f).items, S, NOW);
      expect(v.youItems.map((i) => i.turn), JSON.stringify(f)).toEqual([ask]);
      expect(v.attention).toBe(true);
    }
  });
  it("the ticket row keeps the ticket's own turn and carries the question, so the ticket page can show it", () => {
    const [row] = ticketRows([tk("K-1")], buildTurnBoard(input, { ticketKey: "K-1" }).items);
    expect(row.turn.owner).toBe("idle");
    expect(row.asks.map((i) => i.turn)).toEqual([ask]);
  });
  it("a ticket whose own turn is the question does not list it again", () => {
    const one: BoardInput = { ...input, tickets: [{ key: "K-1", name: "K-1", featureId: 10, prs: [], others: [{ turn: ask, since: NOW - 4 }], moreAsks: [] }] };
    const [row] = ticketRows([tk("K-1")], buildTurnBoard(one, { ticketKey: "K-1" }).items);
    expect(row.turn).toEqual(ask);
    expect(row.asks).toEqual([]);
  });
});
