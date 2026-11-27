import { describe, expect, it } from "vitest";
import type { Turn } from "../../shared/turn";
import { buildTurnBoard, type BoardInput, type BoardPr, type BoardTicket } from "./turn-board";

const NOW = 10_000_000;
const ext: Turn = { owner: "external", kind: "ci_running", names: [] };
const agent: Turn = { owner: "agent", kind: "working", sessionId: "s1" };
const merge: Turn = { owner: "you", kind: "merge", risk: "low" };
const done: Turn = { owner: "done", kind: "merged" };
const ask = (id: number): Turn => ({ owner: "you", kind: "answer", question: `q${id}`, options: [], askId: id, sessionId: "s1" });
const prOf = (n: number, turn: Turn, since = NOW - n, mergedAt: number | null = null): BoardPr =>
  ({ repo: "acme/app", number: n, title: `PR ${n}`, url: `https://ghe.example.com/acme/app/pull/${n}`, turn, since, mergedAt });
const tk = (key: string, featureId: number | null, o: Partial<BoardTicket> = {}): BoardTicket => ({ key, name: key, featureId, prs: [], others: [], moreAsks: [], ...o });

const input = (): BoardInput => ({
  features: [{ id: 10, name: "收银台" }, { id: 11, name: "退款" }, { id: 12, name: "杂项" }],
  tickets: [
    tk("PAY-1", 10, { prs: [prOf(1, merge), prOf(2, ext)] }),
    tk("PAY-2", 10, { others: [{ turn: agent, since: NOW - 500 }], moreAsks: [{ turn: ask(9), since: NOW - 5 }] }),
    tk("PAY-3", 11, { prs: [prOf(3, done, NOW - 900, NOW - 10)] }),
    tk("PAY-4", 11, { others: [{ turn: ask(8), since: NOW - 7 }] }),
    tk("SOLO-1", null),
  ],
  loose: [{ turn: ask(5), since: NOW - 3, featureId: 11 }],
  reviews: [{ repo: "other/lib", number: 77, title: "Fix", url: "https://github.com/other/lib/pull/77", author: "amy", since: NOW - 60 }],
  dayStart: NOW - 1000,
  now: NOW,
});

describe("buildTurnBoard", () => {
  it("counts equal items without a filter; done and idle are not items", () => {
    const b = buildTurnBoard(input(), null);
    const n = (o: string) => b.items.filter((i) => i.turn.owner === o).length;
    // PAY-1（merge，两个 PR 只算一条）、PAY-2 的额外提问、PAY-4、loose、review = 5 条 you；PAY-2 是 agent
    expect(b.counts).toEqual({ you: n("you"), agent: n("agent"), external: n("external"), mergedToday: 1 });
    expect(b.counts.you).toBe(5);
    expect(b.items.some((i) => i.turn.owner === "done" || i.turn.owner === "idle")).toBe(false);
    const pay1 = b.items.find((i) => i.ticketKey === "PAY-1")!;
    expect(pay1).toMatchObject({ featureId: 10, others: 1, since: NOW - 1, pr: { number: 1, url: "https://ghe.example.com/acme/app/pull/1" } });
    expect(b.items.find((i) => i.turn.kind === "review")).toMatchObject({
      ticketKey: null, featureId: null, others: 0, since: NOW - 60,
      pr: { repo: "other/lib", number: 77 }, turn: { owner: "you", kind: "review", author: "amy", title: "Fix", url: "https://github.com/other/lib/pull/77" },
    });
    expect(b.items.find((i) => i.ticketKey === "PAY-2" && i.turn.owner === "agent")).toMatchObject({ pr: null, since: NOW - 500 });
    expect(b.generatedAt).toBe(NOW);
  });
  it("no filter: scopes are every feature and standalone tickets", () => {
    const ids = buildTurnBoard(input(), null).scopes.map((s) => `${s.kind}:${s.id}`);
    expect(ids).toEqual(["feature:10", "feature:11", "feature:12", "ticket:SOLO-1"]);
  });
  it("an empty filter is the same as no filter", () => {
    expect(buildTurnBoard(input(), {})).toEqual(buildTurnBoard(input(), null));
  });
  it("feature filter: items split per PR, done included, reviews excluded", () => {
    const pay = buildTurnBoard(input(), { featureId: 10 });
    expect(pay.items.filter((i) => i.ticketKey === "PAY-1").map((i) => i.pr?.number)).toEqual([1, 2]);
    const refund = buildTurnBoard(input(), { featureId: 11 });
    expect(refund.items.some((i) => i.turn.owner === "done")).toBe(true);
    expect(refund.items.some((i) => i.turn.kind === "review")).toBe(false);
    // PAY-4 的提问加上 feature 级的 loose 提问
    expect(refund.counts.you).toBe(2);
  });
  it("feature filter → feature row plus ticket rows; ticket filter → only that row", () => {
    expect(buildTurnBoard(input(), { featureId: 10 }).scopes.map((s) => s.id)).toEqual([10, "PAY-1", "PAY-2"]);
    const t = buildTurnBoard(input(), { ticketKey: "PAY-1" });
    // slowest：PR 2 的 since（NOW-2）比 PR 1（NOW-1）早，最久没进展的是 #2
    expect(t.scopes).toEqual([{ kind: "ticket", id: "PAY-1", name: "PAY-1", total: 2, merged: 0, closed: 0, bar: { done: 0, agent: 0, you: 1, external: 1, idle: 0 }, youCount: 1, slowest: "acme/app#2" }]);
  });
  it("feature row totals count tickets; youCount adds loose feature-level asks", () => {
    const refund = buildTurnBoard(input(), null).scopes.find((s) => s.kind === "feature" && s.id === 11)!;
    expect(refund).toMatchObject({ total: 2, merged: 1, youCount: 2, bar: { done: 1, agent: 0, you: 1, external: 0, idle: 0 } });
  });
  it("a ticket without PRs is its own member; idle tickets count in the bar", () => {
    const solo = buildTurnBoard(input(), null).scopes.find((s) => s.id === "SOLO-1")!;
    expect(solo).toMatchObject({ kind: "ticket", total: 1, merged: 0, bar: { idle: 1 }, youCount: 0, slowest: null });
  });
});

describe("the item that carries a ticket's own turn", () => {
  // K-1：PR 在等 review，session 在干活，还有一条孤儿提问（它的 head 已经不在 known 里，进了 moreAsks）。
  const review: Turn = { owner: "external", kind: "awaiting_review", names: ["amy"] };
  const orphan = (): BoardInput => ({
    ...input(),
    tickets: [tk("K-1", 10, { prs: [prOf(5, review)], others: [{ turn: agent, since: NOW - 50 }], moreAsks: [{ turn: ask(3), since: NOW - 4 }] })],
  });
  const own = (items: { ticketKey: string | null; ticketLevel?: true }[]) => items.filter((i) => i.ticketLevel === true);
  it("no filter: the ticket's item is marked, its extra questions are not", () => {
    const b = buildTurnBoard(orphan(), null);
    expect(own(b.items)).toMatchObject([{ ticketKey: "K-1", pr: null, turn: agent, others: 1 }]);
    expect(b.items.find((i) => i.turn.kind === "answer")?.ticketLevel).toBeUndefined();
  });
  it("with a filter: of the per-PR and session items, the one the ticket's turn came from is marked, with the other PRs counted", () => {
    for (const f of [{ featureId: 10 }, { ticketKey: "K-1" }]) {
      const b = buildTurnBoard(orphan(), f);
      expect(own(b.items), JSON.stringify(f)).toMatchObject([{ ticketKey: "K-1", pr: null, turn: agent, others: 1 }]);
      // 按 PR 拆开的那条照旧在，不带标记。
      expect(b.items.find((i) => i.pr?.number === 5)).toMatchObject({ turn: review, others: 0 });
      expect(b.items.find((i) => i.pr?.number === 5)?.ticketLevel).toBeUndefined();
    }
  });
  it("with a filter, a PR's turn is marked when the ticket takes it", () => {
    const b = buildTurnBoard(input(), { featureId: 10 });
    expect(own(b.items).find((i) => i.ticketKey === "PAY-1")).toMatchObject({ pr: { number: 1 }, turn: merge, others: 1 });
    expect(own(b.items).find((i) => i.ticketKey === "PAY-2")).toMatchObject({ pr: null, turn: agent, others: 0 });
  });
});

describe("several sessions under one ticket each asked", () => {
  const askBy = (id: number, sid: string): Turn => ({ owner: "you", kind: "answer", question: `q${id}`, options: [], askId: id, sessionId: sid });
  const two = (extra: Partial<BoardTicket> = {}): BoardInput => ({
    ...input(), loose: [], reviews: [],
    tickets: [tk("K-1", 10, { others: [{ turn: askBy(1, "a"), since: NOW - 9 }, { turn: askBy(2, "b"), since: NOW - 3 }], ...extra })],
  });
  const answers = (items: { turn: Turn }[]) => items.flatMap((i) => (i.turn.kind === "answer" ? [i.turn.askId] : [])).sort();
  it("every head's question is an item; the ticket's own item is unchanged", () => {
    const b = buildTurnBoard(two(), null);
    expect(answers(b.items)).toEqual([1, 2]);
    expect(b.items.filter((i) => i.ticketLevel === true)).toHaveLength(1);
    expect(b.counts.you).toBe(2);
    expect(buildTurnBoard(two(), { ticketKey: "K-1" }).scopes.find((s) => s.id === "K-1")?.youCount).toBe(2);
  });
  it("with a filter too, and a PR on the ticket does not hide either question", () => {
    for (const f of [{ ticketKey: "K-1" }, { featureId: 10 }]) {
      expect(answers(buildTurnBoard(two({ prs: [prOf(5, merge)] }), f).items)).toEqual([1, 2]);
    }
    const b = buildTurnBoard(two({ prs: [prOf(5, merge)] }), null);
    expect(answers(b.items)).toEqual([1, 2]);
    expect(b.counts.you).toBe(2);
  });
});
