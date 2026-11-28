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
  ({ id, ticketKey: "BTL-1", origin: "shipherd", termId: `t-${id}`, replacedBy: null, coordinator: false, repoId: 1, featureId: null, shipherd: false, ...over }) as SessionView;
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
  id, kind: "decision", sessionId, ticketKey: null, featureId: null, text: `q${id}`, options: ["a", "b"], context: null,
  reportKind: null, status: "pending", answer: null, createdAt: 50 + id, resolvedAt: null, behalfBy: null, behalfSeenAt: null, ...over,
});

function fakeDeps(over: Partial<TurnServiceDeps> = {}): TurnServiceDeps {
  return {
    tickets: () => [], features: () => [], hibernatedHeads: () => [], coordinators: () => [],
    head: (id) => ({ id }) as never, prs: () => [], prRow: () => null, recipient: () => ({ ok: false, reason: "no_session" }),
    activity: () => null, lastReplyAt: () => null, needsYou: () => ({ reasons: new Map(), categories: new Map() }), decisions: () => [],
    lastReport: () => null, refreshing: () => false, mergeQueued: () => false, risk: () => null, ciUndelivered: () => [],
    comments: { deliveredAt: () => null, sendable: () => false, sendAll: vi.fn(async () => 0) },
    ciResend: vi.fn(async () => "sent" as const), notices: () => [], reviews: () => [], reviewScope: () => "all", registeredSlugs: () => [],
    homeOpened: vi.fn(), emit: vi.fn(), now: () => NOW, stackBelow: () => null, ...over,
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

  it("CI already delivered and the pusher stopped again: unattended, but nothing left to send", () => {
    const s = new TurnService(failingPr({ prRow: () => row({ deliveredKey: "abc:failing", deliveredAt: 300, deliveredTo: "s1" }), lastReplyAt: () => 400 }));
    expect(s.board(null).items[0].turn).toEqual({ owner: "you", kind: "unattended", why: "ci_failing", canSend: false, sessionId: "s1" });
  });

  it("a hibernated or wake-failed pusher is not fixing anything, whatever was delivered to it", () => {
    const delivered = row({ deliveredKey: "abc:failing", deliveredAt: 500, deliveredTo: "s1" });
    for (const state of [{ hibernatedAt: 600 }, { wakeError: "boom" }]) {
      const s = new TurnService(failingPr({ prRow: () => delivered, head: (id) => ({ id, ...state }) as never, lastReplyAt: () => null }));
      expect(s.board(null).items[0].turn, JSON.stringify(state)).toMatchObject({ owner: "you", kind: "unattended", why: "ci_failing" });
    }
    const human = { login: "amy", state: "changes_requested" as const, at: 1, bot: false };
    const reviewed = new TurnService(failingPr({
      prs: () => [watched({ ci: "passing" })], prRow: () => row({ ci: "passing", reviewers: [human] }),
      head: (id) => ({ id, hibernatedAt: 600 }) as never, lastReplyAt: () => null,
      comments: { deliveredAt: () => 500, sendable: () => true, sendAll: vi.fn(async () => 1) },
    }));
    expect(reviewed.board(null).items[0].turn).toMatchObject({ owner: "you", kind: "unattended", why: "changes_requested", canSend: true });
  });

  it("a draft whose CI failed and never reached the agent still shows the undelivered CI", () => {
    const prCi = { item: { kind: "pr", id: 1 }, ticketKey: "BTL-1", number: 3, branch: "feat", reason: "no_session", since: 77, sessionId: null } as const;
    const s = new TurnService(failingPr({
      prRow: () => row({ isDraft: true }),
      ciUndelivered: () => [prCi],
      notices: () => [{ kind: "ci_undelivered", ci: prCi, target: { page: "ticket", key: "BTL-1", sessionId: null }, title: null }],
    }));
    const b = s.board(null);
    expect(b.items.map((i) => i.turn)).toEqual([{ owner: "you", kind: "unattended", why: "ci_undelivered", canSend: true, sessionId: "s1" }]);
  });

  it("an upper stack layer kept as a draft waits on the layer below, not on you", () => {
    const stackBelow = vi.fn(() => "feature/a");
    const s = new TurnService(failingPr({ prs: () => [watched({ ci: "passing" })], prRow: () => row({ ci: "passing", isDraft: true }), stackBelow }));
    const b = s.board(null);
    expect(b.items[0].turn).toEqual({ owner: "external", kind: "stack_below", names: ["feature/a"] });
    expect(b.counts).toMatchObject({ you: 0, external: 1 });
    expect(stackBelow).toHaveBeenCalledWith(URL3, "feat");
  });

  it("comments waiting on a PR that is already sendable as changes requested are not a second item", () => {
    const human = { login: "amy", state: "changes_requested" as const, at: 1, bot: false };
    const waiting = { reason: "review" as const, ticketKey: "BTL-1", prId: 1, number: 3, count: 2, since: 40 };
    const s = new TurnService(failingPr({
      prs: () => [watched({ ci: "passing" })], prRow: () => row({ ci: "passing", reviewers: [human] }),
      comments: { deliveredAt: () => null, sendable: () => true, sendAll: vi.fn(async () => 2) },
      notices: () => [{ kind: "comments_waiting", waiting, target: { page: "ticket", key: "BTL-1", sessionId: null }, title: null }],
    }));
    const b = s.board({ ticketKey: "BTL-1" });
    expect(b.items.some((i) => i.turn.kind === "shipherd")).toBe(false);
    expect(b.items.find((i) => i.pr?.number === 3)?.turn).toMatchObject({ kind: "unattended", why: "changes_requested", canSend: true });
    // PR 不在「没人在改」时（比如 agent 在改），提醒照旧挂着
    const busy = new TurnService(failingPr({
      prs: () => [watched({ ci: "passing" })], prRow: () => row({ ci: "passing", reviewers: [human] }), activity: (id) => (id === "s1" ? act("edit") : null),
      notices: () => [{ kind: "comments_waiting", waiting, target: { page: "ticket", key: "BTL-1", sessionId: null }, title: null }],
    }));
    expect(busy.board({ ticketKey: "BTL-1" }).items.some((i) => i.turn.kind === "shipherd")).toBe(true);
  });

  it("comments waiting are matched to their own PR by id, and kept when that PR row cannot send", () => {
    const human = { login: "amy", state: "changes_requested" as const, at: 1, bot: false };
    // 多仓库：两个仓库都有 #3；A（prId 1）要求修改可以发，评论等着的是 B（prId 2）的
    const other = { reason: "review" as const, ticketKey: "BTL-1", prId: 2, number: 3, count: 2, since: 40 };
    const s = new TurnService(failingPr({
      prs: () => [watched({ ci: "passing" })], prRow: () => row({ ci: "passing", reviewers: [human] }),
      comments: { deliveredAt: () => null, sendable: () => true, sendAll: vi.fn(async () => 2) },
      notices: () => [{ kind: "comments_waiting", waiting: other, target: { page: "ticket", key: "BTL-1", sessionId: null }, title: null }],
    }));
    expect(s.board({ ticketKey: "BTL-1" }).items.some((i) => i.turn.kind === "shipherd")).toBe(true);
    // 排队超过 30 分钟没送出：PR 行发不了（canSend false），提醒要留着
    const stuck = { reason: "undelivered" as const, ticketKey: "BTL-1", prId: 1, number: 3, count: 2, since: 40 };
    const u = new TurnService(failingPr({
      prs: () => [watched({ ci: "passing" })], prRow: () => row({ ci: "passing", reviewers: [human] }),
      comments: { deliveredAt: () => null, sendable: () => false, sendAll: vi.fn(async () => 0) },
      notices: () => [{ kind: "comments_waiting", waiting: stuck, target: { page: "ticket", key: "BTL-1", sessionId: null }, title: null }],
    }));
    const b = u.board({ ticketKey: "BTL-1" });
    expect(b.items.find((i) => i.pr?.number === 3)?.turn).toMatchObject({ why: "changes_requested", canSend: false });
    expect(b.items.some((i) => i.turn.kind === "shipherd")).toBe(true);
  });

  it("a passing PR whose CI verdict never reached the agent keeps its ci_undelivered notice", () => {
    const prCi = { item: { kind: "pr", id: 1 }, ticketKey: "BTL-1", number: 3, branch: "feat", reason: "no_session", since: 77, sessionId: null } as const;
    const s = new TurnService(failingPr({
      prs: () => [watched({ ci: "passing" })], prRow: () => row({ ci: "passing" }),
      ciUndelivered: () => [prCi],
      notices: () => [{ kind: "ci_undelivered", ci: prCi, target: { page: "ticket", key: "BTL-1", sessionId: null }, title: null }],
    }));
    const b = s.board({ ticketKey: "BTL-1" });
    expect(b.items.find((i) => i.turn.kind === "shipherd")).toMatchObject({ turn: { notice: { kind: "ci_undelivered" } }, since: 77 });
  });

  it("a blocked report only makes its own session stuck on a multi-repo ticket", () => {
    const s = new TurnService(fakeDeps({
      tickets: () => [ticket("BTL-1", { sessions: [sv("s1"), sv("s2", { repoId: 2 })] })],
      lastReport: () => ({ kind: "blocked", text: "等接口", at: 300, sessionId: "s2" }),
      lastReplyAt: () => 250,
    }));
    const b = s.board({ ticketKey: "BTL-1" });
    const stuck = b.items.filter((i) => i.turn.kind === "stuck");
    expect(stuck.map((i) => i.turn)).toEqual([{ owner: "you", kind: "stuck", source: "blocked_report", detail: "等接口", sessionId: "s2" }]);
  });

  it("a coordinator's ask_user is a loose you/answer with the inbox id", () => {
    const c = sv("c1", { ticketKey: null, featureId: 3, coordinator: true });
    const s = new TurnService(fakeDeps({
      features: () => [{ id: 3, name: "F", archivedAt: null, tickets: [] } as never],
      coordinators: () => [{ session: c, featureId: 3, target: { page: "feature", id: 3, sessionId: "c1" }, title: "F" }],
      decisions: () => [ask(7, "c1", { featureId: 3 })],
      activity: (id) => (id === "c1" ? act("idle") : null),
    }));
    const b = s.board(null);
    expect(b.items).toContainEqual(expect.objectContaining({
      ticketKey: null, featureId: 3, turn: { owner: "you", kind: "answer", question: "q7", options: ["a", "b"], askId: 7, sessionId: "c1" }, since: 57,
    }));
    // 只有那条 ask：总控停着本身不算要你动手
    expect(b.counts.you).toBe(1);
  });

  it("an idle coordinator without asks only shows when it needs you", () => {
    const c = sv("c1", { ticketKey: null, featureId: null, shipherd: true, coordinator: true });
    const working = new TurnService(fakeDeps({
      coordinators: () => [{ session: c, featureId: null, target: { page: "shipherd", sessionId: "c1" }, title: null }],
      activity: () => act("edit"),
    }));
    expect(working.board(null).items).toEqual([]);
    // 停在提示符等输入的总控（Shipherd、feature 的）不占一张「轮到你」
    const idle = new TurnService(fakeDeps({
      coordinators: () => [{ session: c, featureId: null, target: { page: "shipherd", sessionId: "c1" }, title: null }],
      activity: () => act("idle"), lastReplyAt: () => 500,
    }));
    expect(idle.board(null).items).toEqual([]);
    expect(idle.board(null).counts.you).toBe(0);
  });

  it("the Shipherd session hitting its usage limit is a loose you/shipherd session_limited", () => {
    const c = sv("b1", { ticketKey: null, shipherd: true, coordinator: true });
    const limit = { kind: "usage_limit" as const, resetsAt: null, message: "limit" };
    const s = new TurnService(fakeDeps({
      coordinators: () => [{ session: c, featureId: null, target: { page: "shipherd", sessionId: "b1" }, title: null }],
      activity: () => act("idle", { sessionId: "b1", limit } as never), lastReplyAt: () => 500,
    }));
    const b = s.board(null);
    expect(b.items.map((i) => i.turn)).toEqual([{ owner: "you", kind: "shipherd", notice: { kind: "session_limited", target: { page: "shipherd", sessionId: "b1" }, title: null, limit } }]);
    expect(b.counts.you).toBe(1);
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

  it("two live sessions under one ticket each asked: both first questions are items, each with its own session and askId", () => {
    const s = new TurnService(fakeDeps({
      tickets: () => [ticket("BTL-1", { sessions: [sv("s1"), sv("s2")] })],
      decisions: () => [ask(1, "s1", { ticketKey: "BTL-1" }), ask(2, "s2", { ticketKey: "BTL-1" })],
    }));
    for (const f of [null, { ticketKey: "BTL-1" }]) {
      const b = s.board(f);
      const asks = b.items.flatMap((i) => (i.turn.kind === "answer" ? [{ id: i.turn.askId, sid: i.turn.sessionId }] : []));
      expect(asks.sort((a, c) => (a.id ?? 0) - (c.id ?? 0))).toEqual([{ id: 1, sid: "s1" }, { id: 2, sid: "s2" }]);
      expect(b.counts.you).toBe(2);
    }
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

  it("a closed ticket is finished: its failing PR and blocked status no longer make it stuck, its open question still shows (BTL-270)", () => {
    const s = new TurnService(failingPr({
      tickets: () => [ticket("BTL-1", { effectiveStatus: "closed", status: "blocked", statusManual: "closed", closure: { at: 77, reason: "需求变了", source: "coordinator" }, sessions: [sv("s1")] })],
      decisions: () => [ask(3, "s1", { ticketKey: "BTL-1" })],
    }));
    const b = s.board({ ticketKey: "BTL-1" });
    expect(b.items.find((i) => i.ticketLevel)?.turn).toEqual({ owner: "done", kind: "closed" });
    expect(b.items.some((i) => i.turn.owner === "you" && i.turn.kind === "answer" && i.turn.askId === 3)).toBe(true);
    expect(b.items.some((i) => i.turn.kind === "stuck" || i.pr !== null)).toBe(false);
    expect(b.scopes).toEqual([expect.objectContaining({ id: "BTL-1", total: 1, merged: 0, closed: 1 })]);
  });

  it("a closed ticket whose PR stayed open drops its comments / CI-undelivered notices but keeps its open question (BTL-270)", () => {
    const waiting = { reason: "review" as const, ticketKey: "BTL-1", prId: 1, number: 3, count: 2, since: 40 };
    const prCi = { item: { kind: "pr", id: 1 }, ticketKey: "BTL-1", number: 3, branch: "feat", reason: "no_session", since: 77, sessionId: null } as const;
    const branchCi = { ...prCi, item: { kind: "branch", repoId: 1 }, number: null } as const;
    const target = { page: "ticket", key: "BTL-1", sessionId: null } as const;
    const s = new TurnService(failingPr({
      tickets: () => [ticket("BTL-1", { effectiveStatus: "closed", statusManual: "closed", closure: { at: 77, reason: "需求变了", source: "user" }, sessions: [sv("s1")] })],
      ciUndelivered: () => [prCi, branchCi],
      decisions: () => [ask(3, "s1", { ticketKey: "BTL-1" })],
      notices: () => [
        { kind: "comments_waiting", waiting, target, title: null },
        { kind: "ci_undelivered", ci: prCi, target, title: null },
        { kind: "ci_undelivered", ci: branchCi, target, title: null },
      ],
    }));
    for (const f of [null, { ticketKey: "BTL-1" }]) {
      const b = s.board(f);
      expect(b.items.some((i) => i.turn.kind === "shipherd")).toBe(false);
      expect(b.items.filter((i) => i.turn.owner === "you").map((i) => i.turn.kind)).toEqual(["answer"]);
      expect(b.counts.you).toBe(1);
    }
    const b = s.board({ ticketKey: "BTL-1" });
    expect(b.items.find((i) => i.ticketLevel)?.turn).toEqual({ owner: "done", kind: "closed" });
    expect(b.scopes).toEqual([expect.objectContaining({ id: "BTL-1", total: 1, closed: 1 })]);
  });

  it("a ticket whose PRs were all closed unmerged waits for your decision (BTL-270)", () => {
    const s = new TurnService(fakeDeps({ tickets: () => [ticket("BTL-1", { effectiveStatus: "needs_decision" })] }));
    expect(s.board(null).items[0].turn).toEqual({ owner: "you", kind: "stuck", source: "ticket_needs_decision", detail: null, sessionId: null });
  });

  it("needs_decision whose PR was already reopened on GitHub (status not caught up yet) does not ask you to decide (BTL-270)", () => {
    const deps = { tickets: () => [ticket("BTL-1", { effectiveStatus: "needs_decision" })], prs: () => [watched({ ci: "passing" })], prRow: () => row({ ci: "passing" }) };
    const items = new TurnService(fakeDeps(deps)).board(null).items;
    expect(items.some((i) => i.turn.kind === "stuck" && i.turn.source === "ticket_needs_decision")).toBe(false);
    // 还没读过、放弃读了的开着的 PR 不算：照样要你决定。
    for (const w of [watched({ checkedAt: 0 }), watched({ gaveUp: true })]) {
      const again = new TurnService(fakeDeps({ ...deps, prs: () => [w] })).board(null).items;
      expect(again.some((i) => i.turn.kind === "stuck" && i.turn.source === "ticket_needs_decision")).toBe(true);
    }
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
    expect(b.items.find((i) => i.ticketKey === "BTL-2")).toMatchObject({ turn: { kind: "shipherd", notice: { kind: "ci_undelivered" } }, since: 77 });
    expect(b.items).toHaveLength(2);
  });

  it("review scope registered drops unknown repos; only opening the home page triggers a catch-up, not refetching the board", () => {
    const rv = (slug: string, n: number) => ({ url: `https://github.com/${slug}/pull/${n}`, slug, number: n, title: `t${n}`, author: "amy", firstSeenAt: 9, lastSeenAt: 9 });
    const d = fakeDeps({ reviews: () => [rv("o/a", 1), rv("o/b", 2)], reviewScope: () => "registered", registeredSlugs: () => ["O/B"] });
    const s = new TurnService(d);
    const b = s.board(null);
    expect(b.items).toEqual([{
      ticketKey: null, pr: { repo: "o/b", number: 2, title: "t2", url: "https://github.com/o/b/pull/2" }, featureId: null,
      turn: { owner: "you", kind: "review", author: "amy", title: "t2", url: "https://github.com/o/b/pull/2" }, since: 9, others: 0,
    }]);
    // 第 2 层每次收到 turn:changed 都会不带 filter 重取：不能每次都去补查
    s.board({ ticketKey: "BTL-1" });
    s.board({});
    s.board(null);
    expect(d.homeOpened).not.toHaveBeenCalled();
    s.homeOpened();
    expect(d.homeOpened).toHaveBeenCalledTimes(1);
  });
});

describe("TurnService.prTurns", () => {
  it("looks up each open PR's turn by link, whatever the case, from the same algorithm as the board", () => {
    const of = new TurnService(failingPr()).prTurns();
    expect(of(URL3)).toEqual({ owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: "s1" });
    expect(of(URL3.toLowerCase())).toEqual(of(URL3));
    expect(of("https://github.com/O/r/pull/9")).toBeNull();
  });
  it("a PR linked to two tickets gets each ticket's own turn when the ticket is given", () => {
    const of = new TurnService(failingPr({
      tickets: () => [ticket("BTL-1", { sessions: [sv("s1")] }), ticket("BTL-2", { sessions: [sv("s2")] })],
      prs: (key) => [watched({ ticketKey: key })],
      recipient: (key) => ({ ok: true, sessionId: key === "BTL-1" ? "s1" : "s2", via: "owner" }),
      activity: (id) => (id === "s2" ? act("edit") : null),
    })).prTurns();
    expect(of(URL3, "BTL-1")).toMatchObject({ owner: "you", kind: "unattended" });
    expect(of(URL3, "BTL-2")).toMatchObject({ owner: "agent", kind: "fixing_ci", sessionId: "s2" });
    // 不给 ticket 时落回第一个 ticket 的；给了但那个 ticket 不认识这个 PR（比如归档了）时是 null，不借别的 ticket 的推的人。
    expect(of(URL3)).toEqual(of(URL3, "BTL-1"));
    expect(of(URL3, "BTL-9")).toBeNull();
  });
  it("a closed PR has no turn", () => {
    const of = new TurnService(failingPr({ prs: () => [watched({ state: "closed" })] })).prTurns();
    expect(of(URL3)).toBeNull();
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
    const refused = failingPr({ ciResend: vi.fn(async () => "failed" as const) });
    expect(await new TurnService(refused).sendToAgent(target)).toEqual({ ok: false, reason: "failed" });
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

describe("TurnService input cache (BTL-242)", () => {
  it("builds the board input once per cache generation, across filters", () => {
    let views = 0;
    let gen = 0;
    const cache = new Map<string, unknown>();
    const deps = failingPr();
    const s = new TurnService({
      ...deps,
      tickets: () => {
        views++;
        return deps.tickets();
      },
      cache: <T,>(key: string, build: () => T): T => {
        const k = `${gen}:${key}`;
        if (!cache.has(k)) cache.set(k, build());
        return cache.get(k) as T;
      },
    });
    s.board(null);
    s.board(null);
    s.prTurns();
    expect(views).toBe(1);
    gen++;
    s.board(null);
    expect(views).toBe(2);
  });
});
