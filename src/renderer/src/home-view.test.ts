import { describe, expect, it, vi } from "vitest";
import type { ScopeTurnRow, Turn, TurnBoard, TurnItem } from "../../shared/turn";
import type { NowNotice } from "../../shared/types";
import { STRINGS } from "./strings";
import {
  firstRunProps,
  homeOpenedSignal,
  ticketNowText,
  HOME_CARD_CAP, YOU_KIND_ORDER, barSegments, capCards, cardActions, cardKey, homeLede, homeTitle, isNoWork, locationOf, lookTarget, noticeKey, prUrl,
  runningRows, scopeLine, scopeRoute, scopeWho, ticketItem, turnTone, visibleScopes, youCards, type NameCtx,
} from "./home-view";
import { formatDuration } from "./components/TicketActivity";
import { turnSentence } from "./turn-text";

const S = STRINGS.zh;
const MIN = 60_000;

function item(turn: Turn, o: Partial<TurnItem> = {}): TurnItem {
  return { ticketKey: "BTL-1", pr: null, featureId: null, turn, since: 1000, others: 0, ...o };
}
const answer = (o: Partial<Extract<Turn, { kind: "answer" }>> = {}): Turn =>
  ({ owner: "you", kind: "answer", question: "q?", options: ["可以", "不行，先回测", "再说"], askId: 7, sessionId: "s1", ...o });
const merge: Turn = { owner: "you", kind: "merge", risk: null };
const review: Turn = { owner: "you", kind: "review", author: "bob", title: "Fix", url: "https://gh.example/acme/app/pull/12" };
const stuck = (sessionId: string | null): Turn => ({ owner: "you", kind: "stuck", source: "silent", detail: null, sessionId });
const unattended = (canSend: boolean): Turn => ({ owner: "you", kind: "unattended", why: "ci_failing", canSend, sessionId: "s1" });
const shipherd: Turn = { owner: "you", kind: "shipherd", notice: { kind: "lessons_paused" } as never };
const agent: Turn = { owner: "agent", kind: "working", sessionId: "s1" };
const ci: Turn = { owner: "external", kind: "ci_running", names: [] };
const pr = { repo: "acme/app", number: 12, title: "Fix", url: "https://gh.example/acme/app/pull/12" };

function scope(o: Partial<ScopeTurnRow> = {}): ScopeTurnRow {
  return { kind: "feature", id: 1, name: "F", total: 10, merged: 2, closed: 0, bar: { done: 2, agent: 3, you: 1, external: 2, idle: 2 }, youCount: 1, slowest: null, ...o };
}

describe("turnTone", () => {
  it("maps who-moves to a colour", () => {
    expect(turnTone(answer())).toBe("ask");
    expect(turnTone(review)).toBe("ask");
    expect(turnTone(merge)).toBe("merge");
    expect(turnTone(stuck("s"))).toBe("stuck");
    expect(turnTone(unattended(true))).toBe("stuck");
    expect(turnTone(shipherd)).toBe("shipherd");
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
      item(answer(), { since: 2 }), item(shipherd, { since: 1 }), item(unattended(true), { since: 1 }), item(stuck("s"), { since: 4 }),
    ];
    const copy = [...input];
    const out = youCards(input);
    expect(out.map((i) => [i.turn.kind, i.since])).toEqual([
      ["answer", 2], ["answer", 9], ["stuck", 4], ["shipherd", 1], ["unattended", 1], ["review", 3], ["merge", 5],
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
  it("merge, review, stuck, unattended, shipherd", () => {
    expect(ids(item(merge, { pr }))).toEqual(["openPr*", "look"]);
    expect(ids(item(merge))).toEqual(["look*"]);
    expect(ids(item(review, { ticketKey: null, pr }))).toEqual(["openPr*"]);
    // 「没动静」判的卡住可能是误判（比如在跑很长的测试）：多一个「忽略」；别的来源（session 自己说卡住、blocked 汇报）没有。
    expect(ids(item(stuck("s"), { featureId: 3 }))).toEqual(["look*", "fix", "ignore"]);
    expect(ids(item(stuck("s")))).toEqual(["look*", "ignore"]);
    expect(ids(item(stuck(null), { featureId: 3 }))).toEqual(["look*"]);
    // 总控卡住了（loose 里，ticketKey 为 null）：修复 session 要找 ticket，点了只会 no_session，所以不给「修复」；「忽略」照样有。
    expect(ids(item(stuck("s"), { featureId: 3, ticketKey: null }))).toEqual(["look*", "ignore"]);
    expect(ids(item({ owner: "you", kind: "stuck", source: "needs_you", detail: "x", sessionId: "s" }, { featureId: 3 }))).toEqual(["look*", "fix"]);
    expect(ids(item({ owner: "you", kind: "stuck", source: "blocked_report", detail: "x", sessionId: "s" }))).toEqual(["look*"]);
    expect(ids(item(unattended(true), { pr }))).toEqual(["send*", "look"]);
    expect(ids(item(unattended(true)))).toEqual(["look*"]);
    expect(ids(item(unattended(false), { pr }))).toEqual(["look*"]);
    expect(ids(item(shipherd))).toEqual([]);
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
    // 没有 ticket 的提问：feature 的总控，或者全局总控
    expect(lookTarget(item(answer(), { ticketKey: null, featureId: 4 }))).toEqual({ page: "feature", id: 4, sessionId: "s1" });
    expect(lookTarget(item(answer(), { ticketKey: null }))).toEqual({ page: "shipherd", sessionId: "s1" });
  });
});

describe("locationOf", () => {
  const ctx: NameCtx = { features: new Map([[2, "Feature名"]]), tickets: new Map([["BTL-1", "标题"]]) };
  const now = 1000 + 12 * MIN;
  it("says just now (asked just now for a review), not just now ago, under a minute", () => {
    for (const T of [STRINGS.zh, STRINGS.en]) {
      expect(locationOf(item(merge, { featureId: 2, since: now - 20_000 }), ctx, now, T).age).toBe(T.durationNow);
      expect(locationOf(item(review, { pr, since: now - 20_000 }), ctx, now, T).age).toBe(T.hm.reviewNow);
    }
  });
  it("writes feature › ticket", () => {
    const l = locationOf(item(merge, { featureId: 2 }), ctx, now, S);
    expect(l.path).toBe("Feature名 › BTL-1");
    expect(l.age).toBe(S.hm.ago(S.durationMinutes(12)));
    // 名字太长时省略的是前面的 feature，ticket 号单独放、不省略。
    expect(l.scope).toBe("Feature名 › ");
    expect(l.key).toBe("BTL-1");
    expect(locationOf(item(merge, { ticketKey: null, featureId: 2 }), ctx, now, S)).toMatchObject({ scope: "Feature名", key: null });
  });
  it("a loose ticket is just its key; a missing feature is skipped", () => {
    expect(locationOf(item(merge), ctx, now, S).path).toBe("BTL-1");
    expect(locationOf(item(merge, { featureId: 99 }), ctx, now, S).path).toBe("BTL-1");
  });
  it("a review is repo#number · author, aged by how long you were asked", () => {
    const l = locationOf(item(review, { ticketKey: null, pr }), ctx, now, S);
    expect(l.path).toBe("acme/app#12 · bob");
    expect(l.age).toBe(S.hm.reviewAgo(S.durationMinutes(12)));
  });
  it("a question with no ticket names the overseer when it has no scope", () => {
    expect(locationOf(item(answer(), { ticketKey: null }), ctx, now, S).path).toBe(S.shipherdNav);
    expect(locationOf(item(answer(), { ticketKey: null, featureId: 2 }), ctx, now, S).path).toBe("Feature名");
  });
  it("an unknown start time has no age", () => {
    expect(locationOf(item(merge, { since: 0 }), ctx, now, S).age).toBe("");
  });
});

describe("visibleScopes", () => {
  it("puts more of your turns first, all-merged last, and caps at 8", () => {
    const rows = Array.from({ length: 10 }, (_, i) => scope({ id: i, youCount: i % 3 }));
    rows[0] = scope({ id: 0, youCount: 5, total: 4, merged: 4, closed: 0 });
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
    expect(scopeRoute(scope({ kind: "feature", id: 4 }))).toEqual({ page: "feature", id: 4 });
    expect(scopeRoute(scope({ kind: "ticket", id: "BTL-9" }))).toEqual({ page: "ticket", key: "BTL-9" });
  });
  it("says how far it got", () => {
    expect(scopeLine(scope({ total: 15, merged: 9, closed: 0, slowest: "收尾" }), S)).toBe(S.hm.scopeLine(15, 9, "收尾"));
    expect(scopeLine(scope({ total: 0, merged: 0, closed: 0 }), S)).toBe(S.hm.scopeEmpty);
    expect(S.hm.scopeLine(15, 9, null)).not.toContain("最慢");
  });
  it("says who moves", () => {
    expect(scopeWho(scope({ youCount: 2 }), S)).toEqual({ tone: "ask", text: S.hm.whoYou(2) });
    expect(scopeWho(scope({ youCount: 0 }), S)).toEqual({ tone: "agent", text: S.hm.whoAgent });
    expect(scopeWho(scope({ youCount: 0, bar: { done: 1, agent: 0, you: 0, external: 1, idle: 0 } }), S)).toEqual({ tone: "external", text: S.hm.whoExternal });
    expect(scopeWho(scope({ youCount: 0, total: 3, merged: 3, closed: 0, bar: { done: 3, agent: 0, you: 0, external: 0, idle: 0 } }), S)).toEqual({ tone: "done", text: S.hm.whoDone });
    expect(scopeWho(scope({ youCount: 0, total: 0, merged: 0, closed: 0, bar: { done: 0, agent: 0, you: 0, external: 0, idle: 0 } }), S)).toEqual({ tone: "idle", text: S.hm.whoIdle });
  });
});

describe("ticketItem", () => {
  it("takes the item main marked as the ticket's own turn, not a more urgent extra question", () => {
    const own = item(agent, { ticketLevel: true });
    const items = [item(answer({ askId: 3 })), own, item(ci, { ticketKey: "BTL-2", ticketLevel: true })];
    expect(ticketItem(items, "BTL-1")).toBe(own);
    expect(ticketItem(items, "BTL-3")).toBeNull();
  });
});

// 编译期检查：TurnBoard 的 counts 能直接给 homeLede
const _c: TurnBoard["counts"] = { you: 0, agent: 0, external: 0, mergedToday: 0 };
void homeLede(_c, S);

describe("runningRows", () => {
  const it0 = (turn: Turn, o: Partial<TurnItem> = {}): TurnItem => ({ ticketKey: "BTL-1", pr: null, featureId: null, turn, since: 1000, others: 0, ...o });
  it("lists agent and external work, longest wait first, with who and the sentence", () => {
    const agent = it0({ owner: "agent", kind: "fixing_ci", sessionId: "s" }, { ticketKey: "BTL-2", since: 5000 });
    const ci = it0({ owner: "external", kind: "ci_running", names: [] }, { ticketKey: "BTL-3", since: 2000 });
    const review = it0({ owner: "external", kind: "awaiting_review", names: ["bob", "amy"] }, { ticketKey: "BTL-4", since: 3000 });
    const rows = runningRows([
      it0({ owner: "you", kind: "merge", risk: null }), it0({ owner: "done", kind: "merged" }), it0({ owner: "idle", kind: "not_started" }), agent, ci, review,
    ], S, 65_000);
    expect(rows.map((r) => r.ticketKey)).toEqual(["BTL-3", "BTL-4", "BTL-2"]);
    expect(rows.map((r) => r.who)).toEqual([S.hm.whoCi, `bob${S.lay.nameSep}amy`, S.hm.whoAgent]);
    expect(rows.map((r) => r.owner)).toEqual(["external", "external", "agent"]);
    expect(rows[2].sentence).toBe(turnSentence(agent.turn, agent, S));
    expect(rows[0].age).toBe(S.hm.ago(formatDuration(63_000, S)));
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("says when the ticket has other PRs too (spec §5.1)", () => {
    const i = it0({ owner: "external", kind: "awaiting_review", names: ["amy"] }, { others: 2 });
    expect(runningRows([i], S, 2000)[0].sentence).toBe(`${turnSentence(i.turn, i, S)} · ${S.lay.morePrs(2)}`);
    expect(runningRows([{ ...i, others: 0 }], S, 2000)[0].sentence).toBe(turnSentence(i.turn, i, S));
  });

  it("two coordinators working on one page get different keys", () => {
    const loose = (sessionId: string, featureId: number | null) => it0({ owner: "agent", kind: "working", sessionId }, { ticketKey: null, featureId });
    const rows = runningRows([loose("shipherd-ctl", null), loose("feature-ctl", 10)], S, 2000);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
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
    // Shipherd 自己的提醒（用量受限、复盘暂停）不属于任何 ticket：工作区空着也要能看到。
    expect(isNoWork(0, [item(shipherd, { ticketKey: null })])).toBe(false);
    // 只是告知的提醒（检查自动升级了，可以撤销）不在板上，在「运行情况」里：有它也不算空。
    expect(isNoWork(0, [], 1)).toBe(false);
  });
});

describe("cardKey", () => {
  it("tells apart cards that share ticket, PR and kind", () => {
    // 同一个 session 接连问了两句（第二句在 moreAsks 里），总控的两句（ticketKey 是 null），同一类的两条 Shipherd 提醒。
    const keys = [
      item(answer({ askId: 7 })), item(answer({ askId: 8 })),
      item(answer({ askId: 9, sessionId: "c1" }), { ticketKey: null }), item(answer({ askId: 10, sessionId: "c1" }), { ticketKey: null }),
      item(answer({ askId: null, sessionId: "s2" })), item(answer({ askId: null, sessionId: "s3" })),
      item({ owner: "you", kind: "shipherd", notice: { kind: "intake", item: { key: "a" } } as never }, { ticketKey: null }),
      item({ owner: "you", kind: "shipherd", notice: { kind: "intake", item: { key: "b" } } as never }, { ticketKey: null }),
      item(stuck("s4")), item(stuck("s5")),
      item(merge, { pr }), item(merge, { pr: { ...pr, number: 13 } }),
    ].map(cardKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stays the same for the same card across reloads", () => {
    expect(cardKey(item(answer({ askId: 7 }), { since: 1 }))).toBe(cardKey(item(answer({ askId: 7 }), { since: 2 })));
  });
});

describe("homeOpenedSignal (layer 1's turn:home-opened contract)", () => {
  it("fires when the route switches to home, not again while it stays there", () => {
    const sig = homeOpenedSignal();
    expect(sig.observe("home")).toBe(true); // 启动就在首页
    // 停在首页时又看到一次 home（turn:changed 重取、StrictMode 再跑一次 effect）都不算再打开。
    expect(sig.observe("home")).toBe(false);
    expect(sig.observe("ticket")).toBe(false);
    expect(sig.observe("all")).toBe(false);
    expect(sig.observe("home")).toBe(true);
    expect(sig.observe("home")).toBe(false);
  });
});

describe("ticketNowText (All work ticket rows)", () => {
  const s1 = (o: Partial<ScopeTurnRow>) => scope({ kind: "ticket", id: "BTL-1", total: 1, merged: 0, closed: 0, bar: { done: 0, agent: 0, you: 0, external: 0, idle: 0 }, ...o });
  it("a live item gives its sentence", () => {
    const i = item(merge, { pr, ticketLevel: true });
    expect(ticketNowText([i], s1({ bar: { done: 0, agent: 0, you: 1, external: 0, idle: 0 } }), "BTL-1", S)).toBe(turnSentence(i.turn, i, S));
  });
  it("without a live item: merged or not started, said as a ticket, never the scope line", () => {
    expect(ticketNowText([], s1({ merged: 1, closed: 0, bar: { done: 1, agent: 0, you: 0, external: 0, idle: 0 } }), "BTL-1", S)).toBe(S.turn.done);
    expect(ticketNowText([], s1({ bar: { done: 0, agent: 0, you: 0, external: 0, idle: 1 } }), "BTL-1", S)).toBe(S.turn.idle);
    expect(ticketNowText([], s1({ merged: 1, closed: 0, bar: { done: 1, agent: 0, you: 0, external: 0, idle: 0 } }), "BTL-1", S)).not.toBe(S.hm.scopeLine(1, 1, null));
  });
  it("says when the ticket has other PRs too, like the running tab and the scope pages (spec §5.1)", () => {
    const i = item(merge, { pr, ticketLevel: true, others: 1 });
    expect(ticketNowText([i], s1({}), "BTL-1", S)).toBe(`${turnSentence(i.turn, i, S)} · ${S.lay.morePrs(1)}`);
  });
  it("nothing known gives a dash", () => {
    expect(ticketNowText([], null, "BTL-1", S)).toBe("—");
    expect(ticketNowText([], s1({ total: 0 }), "BTL-1", S)).toBe("—");
  });
});

describe("firstRunProps (home with no work at all)", () => {
  it("the two create buttons open their dialogs; the settings link lands on Settings › Features", () => {
    const d = { onNewTicket: vi.fn(), onNewFeature: vi.fn(), onGo: vi.fn() };
    const p = firstRunProps(d);
    p.onNewTicket(); p.onNewFeature();
    expect([d.onNewTicket, d.onNewFeature].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    expect(d.onGo).not.toHaveBeenCalled();
    p.onOpenSettings();
    expect(d.onGo).toHaveBeenCalledWith({ page: "settings", section: "features" });
  });
});

describe("noticeKey (BTL-269 behalf answers, BTL-272 info flow)", () => {
  it("tells apart two behalf answers and two info flow notices of each kind", () => {
    const target = { page: "ticket", key: "BTL-1", sessionId: null } as const;
    const behalf = (askId: number): NowNotice => ({ kind: "behalf_answered", askId, question: "q", answer: "a", by: "epic 总控", at: 1, target, title: null });
    expect(noticeKey(behalf(1))).toBe("behalf_answered:1");
    expect(noticeKey(behalf(1))).not.toBe(noticeKey(behalf(2)));
    const leftovers = { prErrors: [], sessionErrors: [] };
    const flows = (actionId: number): NowNotice[] => [
      { kind: "flow_proposal", actionId, label: "l", source: "s", text: "t", at: 1 },
      { kind: "flow_synced", actionId, label: "l", source: "s", at: 1 },
      { kind: "flow_partial", actionId, label: "l", source: "s", leftovers, at: 1 },
    ];
    const keys = [...flows(1), ...flows(2)].map(noticeKey);
    expect(new Set(keys).size).toBe(6);
    expect(keys).toContain("flow_partial:2");
  });
});
