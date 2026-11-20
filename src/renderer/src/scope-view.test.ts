import { describe, expect, it } from "vitest";
import type { ScopeTurnRow, Turn, TurnItem } from "../../shared/turn";
import { flatGroup, groupByFeature, prTag, progressLine, scopeBoardView, scopeRowLine, scopeTotal, slowestLine, ticketRows, ticketsWithPr, whoLabel } from "./scope-view";
import { runningRows } from "./home-view";
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
  it("picks the most urgent PR turn and the item it came from", () => {
    const a = item("K-1", ext, { repo: "app", number: 52 });
    const b = item("K-1", you, { repo: "app", number: 51 });
    const s = item("K-1", agent, null);
    const [row] = ticketRows([tk("K-1")], [a, b, s]);
    expect(row.turn.owner).toBe("you");
    expect(row.others).toBe(1);
    expect(row.item).toBe(b);
    expect(row.prs.map((p) => p.number)).toEqual([51, 52]);
    expect(row.prs[0].tag).toBe("#51");
  });
  it("uses the most urgent session-level item, not the first", () => {
    const first = item("K-1", { owner: "external", kind: "awaiting_review", names: [] }, null);
    const urgent = item("K-1", agent, null);
    const [row] = ticketRows([tk("K-1")], [first, urgent]);
    expect(row.item).toBe(urgent);
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
  const stopped: Turn = { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s1" };
  const review: Turn = { owner: "external", kind: "awaiting_review", names: ["amy"] };
  it("an open PR waiting for review and a stopped session: no card is your turn, the tab is not flagged", () => {
    const items = [item("K-1", review, { repo: "app", number: 5 }), item("K-1", stopped, null)];
    const v = scopeBoardView(items, S, 1000);
    expect(v.youItems).toEqual([]);
    expect(v.attention).toBe(false);
    // 和全部 ticket 表格同一口径：这个 ticket 在等外部。
    expect(ticketRows([tk("K-1")], items)[0].turn.owner).toBe("external");
  });
  it("a stopped session with no PR is still your turn", () => {
    const v = scopeBoardView([item("K-1", stopped, null)], S, 1000);
    expect(v.youItems.map((i) => i.turn)).toEqual([stopped]);
    expect(v.attention).toBe(true);
  });
  it("one card per ticket (the ticket's own turn, with the other PRs counted), plus its extra questions and loose items", () => {
    const merge: Turn = { owner: "you", kind: "merge", risk: null };
    const ask = (id: number): Turn => ({ owner: "you", kind: "answer", question: `q${id}`, options: [], askId: id, sessionId: "s1" });
    const loose: TurnItem = { ticketKey: null, pr: null, epicId: 1, featureId: 10, turn: ask(9), since: 1, others: 0 };
    const items = [
      item("K-1", merge, { repo: "app", number: 5 }), item("K-1", merge, { repo: "app", number: 6 }),
      item("K-2", ask(1), null), item("K-2", ask(2), null), item("K-2", review, { repo: "app", number: 7 }),
      loose,
    ];
    const v = scopeBoardView(items, S, 1000);
    const k1 = v.youItems.filter((i) => i.ticketKey === "K-1");
    expect(k1).toHaveLength(1);
    expect(k1[0].others).toBe(1);
    expect(v.youItems.filter((i) => i.ticketKey === "K-2").map((i) => i.turn)).toEqual([ask(1), ask(2)]);
    expect(v.youItems).toContain(loose);
  });
  it("running lists each ticket once, by the ticket's own turn", () => {
    const ci: Turn = { owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: null };
    const items = [
      // K-1：一个 PR 在等 review、session 在干活 → 整个 ticket 是 agent 在推进，一行。
      item("K-1", review, { repo: "app", number: 5 }), item("K-1", agent, null),
      // K-2：一个 PR 挂了 CI 轮到你，另一个在等 review → 这个 ticket 轮到你，不进「进行中」。
      item("K-2", ci, { repo: "app", number: 6 }), item("K-2", review, { repo: "app", number: 7 }),
    ];
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
});
