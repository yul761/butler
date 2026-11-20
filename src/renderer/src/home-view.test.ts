import { describe, expect, it } from "vitest";
import type { ScopeTurnRow, Turn, TurnBoard, TurnItem } from "../../shared/turn";
import { STRINGS } from "./strings";
import {
  HOME_CARD_CAP, YOU_KIND_ORDER, barSegments, capCards, cardActions, cardKey, homeLede, homeTitle, isNoWork, locationOf, lookTarget, prUrl,
  runningRows, scopeLine, scopeRoute, scopeWho, topItem, turnTone, visibleScopes, youCards, type NameCtx,
} from "./home-view";
import { formatDuration } from "./components/TicketActivity";
import { turnSentence } from "./turn-text";

const S = STRINGS.zh;
const MIN = 60_000;

function item(turn: Turn, o: Partial<TurnItem> = {}): TurnItem {
  return { ticketKey: "BTL-1", pr: null, epicId: null, featureId: null, turn, since: 1000, others: 0, ...o };
}
const answer = (o: Partial<Extract<Turn, { kind: "answer" }>> = {}): Turn =>
  ({ owner: "you", kind: "answer", question: "q?", options: ["可以", "不行，先回测", "再说"], askId: 7, sessionId: "s1", ...o });
const merge: Turn = { owner: "you", kind: "merge", risk: null };
const review: Turn = { owner: "you", kind: "review", author: "bob", title: "Fix", url: "https://gh.example/acme/app/pull/12" };
const stuck = (sessionId: string | null): Turn => ({ owner: "you", kind: "stuck", source: "silent", detail: null, sessionId });
const unattended = (canSend: boolean): Turn => ({ owner: "you", kind: "unattended", why: "ci_failing", canSend, sessionId: "s1" });
const butler: Turn = { owner: "you", kind: "butler", notice: { kind: "lessons_paused" } as never };
const agent: Turn = { owner: "agent", kind: "working", sessionId: "s1" };
const ci: Turn = { owner: "external", kind: "ci_running", names: [] };
const pr = { repo: "acme/app", number: 12, title: "Fix", url: "https://gh.example/acme/app/pull/12" };

function scope(o: Partial<ScopeTurnRow> = {}): ScopeTurnRow {
  return { kind: "epic", id: 1, name: "E", total: 10, merged: 2, bar: { done: 2, agent: 3, you: 1, external: 2, idle: 2 }, youCount: 1, slowest: null, ...o };
}

describe("turnTone", () => {
  it("maps who-moves to a colour", () => {
    expect(turnTone(answer())).toBe("ask");
    expect(turnTone(review)).toBe("ask");
    expect(turnTone(merge)).toBe("merge");
    expect(turnTone(stuck("s"))).toBe("stuck");
    expect(turnTone(unattended(true))).toBe("stuck");
    expect(turnTone(butler)).toBe("butler");
    expect(turnTone(agent)).toBe("agent");
    expect(turnTone(ci)).toBe("external");
    expect(turnTone({ owner: "done", kind: "merged" })).toBe("done");
    expect(turnTone({ owner: "idle", kind: "not_started" })).toBe("idle");
  });
});

describe("youCards", () => {
  it("keeps only your items, ordered by the layer-1 urgency and then oldest first", () => {
    const input = [
      item(merge, { since: 5 }), item(agent), item(review, { since: 3 }), item(answer(), { since: 9 }), item(ci),
      item(answer(), { since: 2 }), item(butler, { since: 1 }), item(unattended(true), { since: 1 }), item(stuck("s"), { since: 4 }),
    ];
    const copy = [...input];
    const out = youCards(input);
    expect(out.map((i) => [i.turn.kind, i.since])).toEqual([
      ["answer", 2], ["answer", 9], ["stuck", 4], ["butler", 1], ["unattended", 1], ["review", 3], ["merge", 5],
    ]);
    expect(input).toEqual(copy);
    expect(YOU_KIND_ORDER[0]).toBe("answer");
  });
});

describe("capCards", () => {
  const many = (n: number) => Array.from({ length: n }, () => item(merge));
  it("caps at 20 unless expanded", () => {
    expect(HOME_CARD_CAP).toBe(20);
    expect([capCards(many(25), false).shown.length, capCards(many(25), false).hidden]).toEqual([20, 5]);
    expect([capCards(many(25), true).shown.length, capCards(many(25), true).hidden]).toEqual([25, 0]);
    expect([capCards(many(3), false).shown.length, capCards(many(3), false).hidden]).toEqual([3, 0]);
  });
});

describe("homeTitle and homeLede", () => {
  it("says nothing is your turn instead of zero", () => {
    expect(homeTitle(0, S)).toBe(S.hm.titleZero);
    expect(homeTitle(3, S)).toBe(S.hm.title(3));
    expect(STRINGS.en.hm.title(1)).toBe("1 thing needs you");
    expect(STRINGS.en.hm.title(2)).toBe("2 things need you");
  });
  it("sums up the rest in one line", () => {
    expect(homeLede({ you: 0, agent: 5, external: 2, mergedToday: 5 }, S)).toBe(S.hm.lede(5, 2, 5));
    expect(homeLede({ you: 3, agent: 0, external: 0, mergedToday: 0 }, S)).toBe(S.hm.ledeIdle);
  });
});

describe("cardActions", () => {
  const ids = (i: TurnItem) => cardActions(i).map((a) => (a.id === "answer" ? `answer:${a.option}` : a.id) + (a.primary ? "*" : ""));
  it("answer: first two options and a look", () => {
    expect(ids(item(answer()))).toEqual(["answer:可以*", "answer:不行，先回测", "look"]);
    expect(ids(item(answer({ askId: null })))).toEqual(["look*"]);
    expect(ids(item(answer({ options: [] })))).toEqual(["look*"]);
  });
  it("merge, review, stuck, unattended, butler", () => {
    expect(ids(item(merge, { pr }))).toEqual(["openPr*", "look"]);
    expect(ids(item(merge))).toEqual(["look*"]);
    expect(ids(item(review, { ticketKey: null, pr }))).toEqual(["openPr*"]);
    expect(ids(item(stuck("s"), { featureId: 3 }))).toEqual(["look*", "fix"]);
    expect(ids(item(stuck("s")))).toEqual(["look*"]);
    expect(ids(item(stuck(null), { featureId: 3 }))).toEqual(["look*"]);
    // 总控卡住了（loose 里，ticketKey 为 null）：修复 session 要找 ticket，点了只会 no_session，所以不给按钮。
    expect(ids(item(stuck("s"), { featureId: 3, ticketKey: null }))).toEqual(["look*"]);
    expect(ids(item(unattended(true), { pr }))).toEqual(["send*", "look"]);
    expect(ids(item(unattended(true)))).toEqual(["look*"]);
    expect(ids(item(unattended(false), { pr }))).toEqual(["look*"]);
    expect(ids(item(butler))).toEqual([]);
  });
});

describe("prUrl and lookTarget", () => {
  it("review uses the turn url, others the item pr url", () => {
    expect(prUrl(item(review, { ticketKey: null, pr: { ...pr, url: "x" } }))).toBe("https://gh.example/acme/app/pull/12");
    expect(prUrl(item(merge, { pr }))).toBe(pr.url);
    expect(prUrl(item(merge))).toBeNull();
  });
  it("lands on the ticket, or on the page of the session that asked", () => {
    expect(lookTarget(item(review, { ticketKey: null, pr }))).toBeNull();
    expect(lookTarget(item(answer()))).toEqual({ page: "ticket", key: "BTL-1", sessionId: "s1" });
    expect(lookTarget(item(merge, { pr }))).toEqual({ page: "ticket", key: "BTL-1", sessionId: null });
    // 没有 ticket 的提问：feature、epic 的总控，或者全局总控
    expect(lookTarget(item(answer(), { ticketKey: null, featureId: 4 }))).toEqual({ page: "feature", id: 4, sessionId: "s1" });
    expect(lookTarget(item(answer(), { ticketKey: null, epicId: 2 }))).toEqual({ page: "epic", id: 2, sessionId: "s1" });
    expect(lookTarget(item(answer(), { ticketKey: null }))).toEqual({ page: "butler", sessionId: "s1" });
  });
});

describe("locationOf", () => {
  const ctx: NameCtx = { epics: new Map([[1, "Epic名"]]), features: new Map([[2, "Feature名"]]), tickets: new Map([["BTL-1", "标题"]]) };
  const now = 1000 + 12 * MIN;
  it("writes epic › feature › ticket", () => {
    const l = locationOf(item(merge, { epicId: 1, featureId: 2 }), ctx, now, S);
    expect(l.path).toBe("Epic名 › Feature名 › BTL-1");
    expect(l.age).toBe(S.hm.ago(S.durationMinutes(12)));
    // 名字太长时省略的是前面的 epic、feature，ticket 号单独放、不省略。
    expect(l.scope).toBe("Epic名 › Feature名 › ");
    expect(l.key).toBe("BTL-1");
    expect(locationOf(item(merge, { ticketKey: null, featureId: 2 }), ctx, now, S)).toMatchObject({ scope: "Feature名", key: null });
  });
  it("a loose ticket is just its key; a missing epic is skipped", () => {
    expect(locationOf(item(merge), ctx, now, S).path).toBe("BTL-1");
    expect(locationOf(item(merge, { epicId: 99, featureId: 2 }), ctx, now, S).path).toBe("Feature名 › BTL-1");
  });
  it("a review is repo#number · author, aged by how long you were asked", () => {
    const l = locationOf(item(review, { ticketKey: null, pr }), ctx, now, S);
    expect(l.path).toBe("acme/app#12 · bob");
    expect(l.age).toBe(S.hm.reviewAgo(S.durationMinutes(12)));
  });
  it("a question with no ticket names the overseer when it has no scope", () => {
    expect(locationOf(item(answer(), { ticketKey: null }), ctx, now, S).path).toBe(S.butlerNav);
    expect(locationOf(item(answer(), { ticketKey: null, epicId: 1 }), ctx, now, S).path).toBe("Epic名");
  });
  it("an unknown start time has no age", () => {
    expect(locationOf(item(merge, { since: 0 }), ctx, now, S).age).toBe("");
  });
});

describe("visibleScopes", () => {
  it("puts more of your turns first, all-merged last, and caps at 8", () => {
    const rows = Array.from({ length: 10 }, (_, i) => scope({ id: i, youCount: i % 3 }));
    rows[0] = scope({ id: 0, youCount: 5, total: 4, merged: 4 });
    const copy = [...rows];
    const { shown, hidden } = visibleScopes(rows);
    expect(shown).toHaveLength(8);
    expect(hidden).toBe(2);
    expect(shown[0].youCount).toBe(2);
    expect(shown.map((r) => r.id)).not.toContain(0);
    expect(rows).toEqual(copy);
    for (let i = 1; i < shown.length; i++) expect(shown[i - 1].youCount).toBeGreaterThanOrEqual(shown[i].youCount);
  });
});

describe("barSegments", () => {
  it("orders done, agent, you, external, idle and drops empty ones", () => {
    expect(barSegments({ done: 6, agent: 2, you: 1, external: 1, idle: 0 }, 10)).toEqual([
      { tone: "done", pct: 60 }, { tone: "agent", pct: 20 }, { tone: "ask", pct: 10 }, { tone: "external", pct: 10 },
    ]);
    expect(barSegments({ done: 0, agent: 0, you: 0, external: 0, idle: 0 }, 0)).toEqual([]);
  });
});

describe("scope rows", () => {
  it("routes to the page of the scope", () => {
    expect(scopeRoute(scope({ kind: "epic", id: 3 }))).toEqual({ page: "epic", id: 3 });
    expect(scopeRoute(scope({ kind: "feature", id: 4 }))).toEqual({ page: "feature", id: 4 });
    expect(scopeRoute(scope({ kind: "ticket", id: "BTL-9" }))).toEqual({ page: "ticket", key: "BTL-9" });
  });
  it("says how far it got", () => {
    expect(scopeLine(scope({ total: 15, merged: 9, slowest: "收尾" }), S)).toBe(S.hm.scopeLine(15, 9, "收尾"));
    expect(scopeLine(scope({ total: 0, merged: 0 }), S)).toBe(S.hm.scopeEmpty);
    expect(S.hm.scopeLine(15, 9, null)).not.toContain("最慢");
  });
  it("says who moves", () => {
    expect(scopeWho(scope({ youCount: 2 }), S)).toEqual({ tone: "ask", text: S.hm.whoYou(2) });
    expect(scopeWho(scope({ youCount: 0 }), S)).toEqual({ tone: "agent", text: S.hm.whoAgent });
    expect(scopeWho(scope({ youCount: 0, bar: { done: 1, agent: 0, you: 0, external: 1, idle: 0 } }), S)).toEqual({ tone: "external", text: S.hm.whoExternal });
    expect(scopeWho(scope({ youCount: 0, total: 3, merged: 3, bar: { done: 3, agent: 0, you: 0, external: 0, idle: 0 } }), S)).toEqual({ tone: "done", text: S.hm.whoDone });
    expect(scopeWho(scope({ youCount: 0, total: 0, merged: 0, bar: { done: 0, agent: 0, you: 0, external: 0, idle: 0 } }), S)).toEqual({ tone: "idle", text: S.hm.whoIdle });
  });
});

describe("topItem", () => {
  it("takes the most urgent item of a ticket", () => {
    const items = [item(agent), item(merge, { pr }), item(ci, { ticketKey: "BTL-2" })];
    expect(topItem(items, "BTL-1")?.turn.kind).toBe("merge");
    expect(topItem(items, "BTL-3")).toBeNull();
  });
});

// 编译期检查：TurnBoard 的 counts 能直接给 homeLede
const _c: TurnBoard["counts"] = { you: 0, agent: 0, external: 0, mergedToday: 0 };
void homeLede(_c, S);

describe("runningRows", () => {
  const it0 = (turn: Turn, o: Partial<TurnItem> = {}): TurnItem => ({ ticketKey: "BTL-1", pr: null, epicId: null, featureId: null, turn, since: 1000, others: 0, ...o });
  it("lists agent and external work, longest wait first, with who and the sentence", () => {
    const agent = it0({ owner: "agent", kind: "fixing_ci", sessionId: "s" }, { ticketKey: "BTL-2", since: 5000 });
    const ci = it0({ owner: "external", kind: "ci_running", names: [] }, { ticketKey: "BTL-3", since: 2000 });
    const review = it0({ owner: "external", kind: "awaiting_review", names: ["bob", "amy"] }, { ticketKey: "BTL-4", since: 3000 });
    const rows = runningRows([
      it0({ owner: "you", kind: "merge", risk: null }), it0({ owner: "done", kind: "merged" }), it0({ owner: "idle", kind: "not_started" }), agent, ci, review,
    ], S, 65_000);
    expect(rows.map((r) => r.ticketKey)).toEqual(["BTL-3", "BTL-4", "BTL-2"]);
    expect(rows.map((r) => r.who)).toEqual([S.hm.whoCi, "bob, amy", S.hm.whoAgent]);
    expect(rows.map((r) => r.owner)).toEqual(["external", "external", "agent"]);
    expect(rows[2].sentence).toBe(turnSentence(agent.turn, agent, S));
    expect(rows[0].age).toBe(S.hm.ago(formatDuration(63_000, S)));
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("names a waiting merge queue as others", () => {
    expect(runningRows([it0({ owner: "external", kind: "merge_queue", names: [] })], S, 2000)[0].who).toBe(S.hm.whoExternal);
  });

  it("a stacked draft waits on the layer below; the branch is in the sentence, not in who", () => {
    const row = runningRows([it0({ owner: "external", kind: "stack_below", names: ["feature/BTL-0"] })], S, 2000)[0];
    expect(row.who).toBe(S.hm.whoStackBelow);
    expect(row.sentence).toContain("feature/BTL-0");
  });
});

describe("isNoWork", () => {
  it("is the empty workspace only while nothing is on the turn board either", () => {
    expect(isNoWork(0, [])).toBe(true);
    expect(isNoWork(0, null)).toBe(true);
    expect(isNoWork(1, [])).toBe(false);
    // Butler 自己的提醒（用量受限、复盘暂停）不属于任何 ticket：工作区空着也要能看到。
    expect(isNoWork(0, [item(butler, { ticketKey: null })])).toBe(false);
    // 只是告知的提醒（检查自动升级了，可以撤销）不在板上，在「运行情况」里：有它也不算空。
    expect(isNoWork(0, [], 1)).toBe(false);
  });
});

describe("cardKey", () => {
  it("tells apart cards that share ticket, PR and kind", () => {
    // 同一个 session 接连问了两句（第二句在 moreAsks 里），总控的两句（ticketKey 是 null），同一类的两条 Butler 提醒。
    const keys = [
      item(answer({ askId: 7 })), item(answer({ askId: 8 })),
      item(answer({ askId: 9, sessionId: "c1" }), { ticketKey: null }), item(answer({ askId: 10, sessionId: "c1" }), { ticketKey: null }),
      item(answer({ askId: null, sessionId: "s2" })), item(answer({ askId: null, sessionId: "s3" })),
      item({ owner: "you", kind: "butler", notice: { kind: "intake", item: { key: "a" } } as never }, { ticketKey: null }),
      item({ owner: "you", kind: "butler", notice: { kind: "intake", item: { key: "b" } } as never }, { ticketKey: null }),
      item(stuck("s4")), item(stuck("s5")),
      item(merge, { pr }), item(merge, { pr: { ...pr, number: 13 } }),
    ].map(cardKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stays the same for the same card across reloads", () => {
    expect(cardKey(item(answer({ askId: 7 }), { since: 1 }))).toBe(cardKey(item(answer({ askId: 7 }), { since: 2 })));
  });
});
