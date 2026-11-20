import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { NowNotice, SessionView, TicketView, WatchedPr } from "../../shared/types";
import type { InboxItem } from "../db/inbox-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import { TURN_CHANGED_DEBOUNCE_MS, TurnService, localDayStart, type TurnServiceDeps } from "./turn-service";

const NOW = 1_000_000;
const URL3 = "https://github.com/O/r/pull/3";

const ticket = (key: string, over: Partial<TicketView> = {}): TicketView => ({
  key, title: `${key} title`, repos: [], status: "active", statusManual: null, createdAt: 0, archivedAt: null, featureId: null,
  effectiveStatus: "active", sessions: [], hiddenSessions: [], waiting: false, ...over,
});
const sv = (id: string, over: Partial<SessionView> = {}): SessionView =>
  ({ id, ticketKey: "BTL-1", origin: "butler", termId: `t-${id}`, replacedBy: null, coordinator: false, repoId: 1, featureId: null, epicId: null, butler: false, ...over }) as SessionView;
const watched = (over: Partial<WatchedPr> = {}): WatchedPr => ({
  ticketKey: "BTL-1", prId: 1, repoId: 1, repoPath: "/r", branch: "feat", number: 3, url: URL3, state: "open", review: null,
  ci: "failing", headSha: "abc", checkedAt: 10, readError: false, ...over,
});
const row = (over: Partial<TicketPr> = {}): TicketPr =>
  ({
    id: 1, ticketKey: "BTL-1", url: URL3.toLowerCase(), slug: "o/r", repoId: 1, number: 3, headBranch: "feat", state: "open", review: null,
    ci: "failing", headSha: "abc", openedAt: 5, mergedAt: null, deliveredKey: null, deliveredAt: null, deliveredTo: null, checkedAt: 10,
    isDraft: false, title: "Fix it", reviewers: [], reviewRequests: [], mergeable: null, mergeState: null, statusChangedAt: null, ...over,
  }) as TicketPr;
const act = (kind: SessionActivity["kind"], over: Partial<SessionActivity> = {}): SessionActivity => ({
  sessionId: "s1", kind, detail: null, background: false, startedAt: 100, lastOutputAt: 200, stuck: false, reason: null, action: null, lastOutput: [], ...over,
});
const ask = (id: number, sessionId: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id, kind: "decision", sessionId, ticketKey: null, featureId: null, epicId: null, text: `q${id}`, options: ["a", "b"], context: null,
  reportKind: null, status: "pending", answer: null, createdAt: 50 + id, resolvedAt: null, ...over,
});

function fakeDeps(over: Partial<TurnServiceDeps> = {}): TurnServiceDeps {
  return {
    tickets: () => [], features: () => [], epics: () => [], hibernatedHeads: () => [], coordinators: () => [],
    head: (id) => ({ id }) as never, prs: () => [], prRow: () => null, recipient: () => ({ ok: false, reason: "no_session" }),
    activity: () => null, lastReplyAt: () => null, needsYou: () => ({ reasons: new Map(), categories: new Map() }), decisions: () => [],
    lastReport: () => null, refreshing: () => false, mergeQueued: () => false, risk: () => null, ciUndelivered: () => [],
    comments: { deliveredAt: () => null, sendable: () => false, sendAll: vi.fn(async () => 0) },
    ciResend: vi.fn(async () => "sent" as const), notices: () => [], reviews: () => [], reviewScope: () => "all", registeredSlugs: () => [],
    homeOpened: vi.fn(), emit: vi.fn(), now: () => NOW, ...over,
  };
}

/** BTL-1 有一个 CI 挂了的 PR，推它的是 s1。 */
const failingPr = (over: Partial<TurnServiceDeps> = {}): TurnServiceDeps =>
  fakeDeps({
    tickets: () => [ticket("BTL-1", { sessions: [sv("s1")] })],
    prs: (key) => (key === "BTL-1" ? [watched()] : []),
    prRow: (id) => (id === 1 ? row() : null),
    recipient: () => ({ ok: true, sessionId: "s1", via: "owner" }),
    ...over,
  });

afterEach(() => vi.useRealTimers());

describe("TurnService.board", () => {
  it("a failing PR whose recipient is working shows as agent fixing_ci", () => {
    const s = new TurnService(failingPr({ activity: (id) => (id === "s1" ? act("edit") : null) }));
    const b = s.board(null);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({
      ticketKey: "BTL-1", pr: { repo: "o/r", number: 3, title: "Fix it", url: URL3 }, turn: { owner: "agent", kind: "fixing_ci", sessionId: "s1" }, since: 5,
    });
    expect(b.counts).toMatchObject({ you: 0, agent: 1, external: 0 });
  });

  it("a stopped recipient leaves the failing PR unattended and sendable", () => {
    const b = new TurnService(failingPr()).board(null);
    expect(b.items[0].turn).toEqual({ owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: "s1" });
  });

  it("CI delivered to the pusher after it last stopped is agent fixing_ci; delivered to someone else is not", () => {
    const delivered = (to: string) => row({ deliveredKey: "abc:failing", deliveredAt: 500, deliveredTo: to });
    const mine = new TurnService(failingPr({ prRow: () => delivered("old-s1"), head: (id) => ({ id: id === "old-s1" ? "s1" : id }) as never, lastReplyAt: () => 400 }));
    expect(mine.board(null).items[0].turn).toMatchObject({ owner: "agent", kind: "fixing_ci" });
    const theirs = new TurnService(failingPr({ prRow: () => delivered("s9"), lastReplyAt: () => 400 }));
    expect(theirs.board(null).items[0].turn).toMatchObject({ owner: "you", kind: "unattended" });
  });

  it("a coordinator's ask_user is a loose you/answer with the inbox id", () => {
    const c = sv("c1", { ticketKey: null, featureId: 3, coordinator: true });
    const s = new TurnService(fakeDeps({
      features: () => [{ id: 3, name: "F", epicId: 1, archivedAt: null, tickets: [] } as never],
      epics: () => [{ id: 1, name: "E", archivedAt: null } as never],
      coordinators: () => [{ session: c, featureId: 3, epicId: null, target: { page: "feature", id: 3, sessionId: "c1" }, title: "F" }],
      decisions: () => [ask(7, "c1", { featureId: 3, epicId: 1 })],
      activity: (id) => (id === "c1" ? act("idle") : null),
    }));
    const b = s.board(null);
    expect(b.items).toContainEqual(expect.objectContaining({
      ticketKey: null, featureId: 3, epicId: 1, turn: { owner: "you", kind: "answer", question: "q7", options: ["a", "b"], askId: 7, sessionId: "c1" }, since: 57,
    }));
    // 总控停着（agent_stopped）也是 you：总控没人推进要你说话
    expect(b.counts.you).toBe(1);
  });

  it("an idle coordinator without asks only shows when it needs you", () => {
    const c = sv("c1", { ticketKey: null, featureId: null, butler: true, coordinator: true });
    const working = new TurnService(fakeDeps({
      coordinators: () => [{ session: c, featureId: null, epicId: null, target: { page: "butler", sessionId: "c1" }, title: null }],
      activity: () => act("edit"),
    }));
    expect(working.board(null).items).toEqual([]);
  });

  it("two asks on one ticket: the ticket item answers the first, the second is its own item", () => {
    const s = new TurnService(fakeDeps({
      tickets: () => [ticket("BTL-1", { sessions: [sv("s1")] })],
      decisions: () => [ask(1, "s1", { ticketKey: "BTL-1" }), ask(2, "s1", { ticketKey: "BTL-1" })],
    }));
    const b = s.board(null);
    expect(b.items.map((i) => (i.turn.kind === "answer" ? i.turn.askId : null))).toEqual([1, 2]);
    expect(b.items.every((i) => i.ticketKey === "BTL-1")).toBe(true);
    expect(b.counts.you).toBe(2);
  });

  it("an ask whose session is closed still shows on its ticket", () => {
    const s = new TurnService(fakeDeps({
      tickets: () => [ticket("BTL-1", { sessions: [sv("s1", { termId: null })] })],
      decisions: () => [ask(4, "gone", { ticketKey: "BTL-1" })],
    }));
    expect(s.board(null).items).toEqual([expect.objectContaining({ ticketKey: "BTL-1", turn: expect.objectContaining({ kind: "answer", askId: 4 }) })]);
  });

  it("a ticket marked blocked is stuck/ticket_blocked; in_review is not stuck", () => {
    const blocked = new TurnService(fakeDeps({ tickets: () => [ticket("BTL-1", { effectiveStatus: "blocked", sessions: [sv("s1")] })], activity: () => act("edit") }));
    expect(blocked.board(null).items[0].turn).toEqual({ owner: "you", kind: "stuck", source: "ticket_blocked", detail: null, sessionId: "s1" });
    const review = new TurnService(fakeDeps({ tickets: () => [ticket("BTL-1", { effectiveStatus: "in_review", sessions: [sv("s1")] })], activity: () => act("edit") }));
    expect(review.board(null).items[0].turn).toEqual({ owner: "agent", kind: "working", sessionId: "s1" });
  });

  it("a done ticket without PRs shows only with a filter", () => {
    const s = new TurnService(fakeDeps({ tickets: () => [ticket("BTL-1", { effectiveStatus: "done" })] }));
    expect(s.board(null).items).toEqual([]);
    expect(s.board({ ticketKey: "BTL-1" }).items).toEqual([expect.objectContaining({ ticketKey: "BTL-1", pr: null, turn: { owner: "done", kind: "merged" } })]);
  });

  it("archived tickets are skipped", () => {
    const s = new TurnService(fakeDeps({ tickets: () => [ticket("BTL-1", { archivedAt: 1, sessions: [sv("s1")] })], activity: () => act("edit") }));
    expect(s.board(null).items).toEqual([]);
  });

  it("a branch-row ci_undelivered notice goes on its ticket; the PR-row one is folded into the PR turn", () => {
    const branchCi = { item: { kind: "branch", repoId: 1 }, ticketKey: "BTL-2", number: null, branch: "x", reason: "no_session", since: 77, sessionId: null } as const;
    const prCi = { ...branchCi, item: { kind: "pr", id: 1 }, ticketKey: "BTL-1", number: 3 } as const;
    const notice = (ci: typeof branchCi | typeof prCi): NowNotice => ({ kind: "ci_undelivered", ci, target: { page: "ticket", key: ci.ticketKey, sessionId: null }, title: null });
    const s = new TurnService(failingPr({
      tickets: () => [ticket("BTL-1", { sessions: [sv("s1")] }), ticket("BTL-2")],
      ciUndelivered: () => [prCi, branchCi],
      notices: () => [notice(prCi), notice(branchCi), { kind: "lessons_paused" }],
    }));
    const b = s.board(null);
    expect(b.items.find((i) => i.ticketKey === "BTL-1")?.turn).toMatchObject({ kind: "unattended", why: "ci_undelivered" });
    expect(b.items.find((i) => i.ticketKey === "BTL-2")).toMatchObject({ turn: { kind: "butler", notice: { kind: "ci_undelivered" } }, since: 77 });
    expect(b.items).toHaveLength(2);
  });

  it("review scope registered drops unknown repos, and the home board triggers a catch-up", () => {
    const rv = (slug: string, n: number) => ({ url: `https://github.com/${slug}/pull/${n}`, slug, number: n, title: `t${n}`, author: "amy", firstSeenAt: 9, lastSeenAt: 9 });
    const d = fakeDeps({ reviews: () => [rv("o/a", 1), rv("o/b", 2)], reviewScope: () => "registered", registeredSlugs: () => ["O/B"] });
    const s = new TurnService(d);
    const b = s.board(null);
    expect(b.items).toEqual([{
      ticketKey: null, pr: { repo: "o/b", number: 2, title: "t2", url: "https://github.com/o/b/pull/2" }, epicId: null, featureId: null,
      turn: { owner: "you", kind: "review", author: "amy", title: "t2", url: "https://github.com/o/b/pull/2" }, since: 9, others: 0,
    }]);
    expect(d.homeOpened).toHaveBeenCalledTimes(1);
    s.board({ ticketKey: "BTL-1" });
    s.board({});
    expect(d.homeOpened).toHaveBeenCalledTimes(2);
  });
});

describe("TurnService.sendToAgent", () => {
  const target = { ticketKey: "BTL-1", pr: { repo: "o/r", number: 3 } };

  it("sends CI through ciResend and comments through sendAll", async () => {
    const d = failingPr();
    const s = new TurnService(d);
    expect(await s.sendToAgent(target)).toEqual({ ok: true });
    expect(d.ciResend).toHaveBeenCalledWith({ kind: "pr", id: 1 });

    const sendAll = vi.fn(async () => 2);
    const c = failingPr({
      prs: () => [watched({ ci: "passing", review: "changes_requested" })],
      prRow: () => row({ ci: "passing", review: "changes_requested" }),
      comments: { deliveredAt: () => null, sendable: () => true, sendAll },
    });
    const cs = new TurnService(c);
    expect(await cs.sendToAgent({ ticketKey: "BTL-1", pr: { repo: "O/R", number: 3 } })).toEqual({ ok: true });
    expect(sendAll).toHaveBeenCalledWith(1);
    expect(c.ciResend).not.toHaveBeenCalled();
  });

  it("refuses when the turn cannot be sent", async () => {
    // agent 在修
    const busy = failingPr({ activity: () => act("edit") });
    expect(await new TurnService(busy).sendToAgent(target)).toEqual({ ok: false, reason: "not_sendable" });
    // 找不到 PR
    const missing = failingPr();
    expect(await new TurnService(missing).sendToAgent({ ticketKey: "BTL-1", pr: { repo: "o/r", number: 4 } })).toEqual({ ok: false, reason: "not_found" });
    expect(await new TurnService(missing).sendToAgent({ ticketKey: "BTL-9", pr: { repo: "o/r", number: 3 } })).toEqual({ ok: false, reason: "not_found" });
    // 没有 pusher：canSend 为 false
    const nobody = failingPr({ recipient: () => ({ ok: false, reason: "no_session" }) });
    expect(await new TurnService(nobody).sendToAgent(target)).toEqual({ ok: false, reason: "not_sendable" });
    for (const d of [busy, missing, nobody]) {
      expect(d.ciResend).not.toHaveBeenCalled();
      expect(d.comments.sendAll).not.toHaveBeenCalled();
    }
    // 递送路径自己拒绝
    const refused = failingPr({ ciResend: vi.fn(async () => "busy_delivering" as const) });
    expect(await new TurnService(refused).sendToAgent(target)).toEqual({ ok: false, reason: "busy_delivering" });
    // 评论没有可送的
    const none = failingPr({
      prs: () => [watched({ ci: "passing", review: "changes_requested" })],
      prRow: () => row({ ci: "passing", review: "changes_requested" }),
      comments: { deliveredAt: () => null, sendable: () => true, sendAll: vi.fn(async () => 0) },
    });
    expect(await new TurnService(none).sendToAgent(target)).toEqual({ ok: false, reason: "no_comments" });
  });
});

describe("TurnService.changed", () => {
  it("changed() is debounced into one emit", () => {
    vi.useFakeTimers();
    const d = fakeDeps();
    const s = new TurnService(d);
    s.changed();
    s.changed();
    s.changed();
    vi.advanceTimersByTime(TURN_CHANGED_DEBOUNCE_MS - 1);
    expect(d.emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(d.emit).toHaveBeenCalledTimes(1);
    s.changed();
    s.dispose();
    vi.advanceTimersByTime(TURN_CHANGED_DEBOUNCE_MS);
    expect(d.emit).toHaveBeenCalledTimes(1);
  });

  it("localDayStart is local midnight", () => {
    const t = new Date(2026, 10, 19, 15, 30).getTime();
    expect(localDayStart(t)).toBe(new Date(2026, 10, 19).getTime());
  });
});
