import { describe, expect, it, vi } from "vitest";
import { BranchWatchRepo } from "../db/branch-watch-repo";
import { TicketPrsRepo, type TicketPrPatch } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { DeliveryGuard } from "../sessions/delivery-guard";
import { deliveryNeedsYou, NeedsYouTracker, type NeedsYouVerdict } from "../sessions/needs-you";
import { memDb } from "../test-utils";
import type { Session } from "../../shared/types";
import { CI_UNDELIVERED_MS, CiDelivery, ciRecipient, deliveryKey, pickRecipient, type CiDeliveryDeps, type RecipientCandidate } from "./ci-delivery";

type Deliver = (term: string, text: string, recheck: () => boolean) => Promise<"sent" | "exited" | "timeout" | "blocked">;

function setup(opts: { session?: string | null; guard?: ReturnType<DeliveryGuard["check"]>; deliver?: Deliver; guardImpl?: CiDeliveryDeps["guard"]; recipient?: CiDeliveryDeps["recipient"] } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  for (const key of ["BTL-1", "BTL-2"]) tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "BTL-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", createdAt: 1 });
  const otherRepo = tickets.addRepo({ ticketKey: "BTL-2", repoPath: "/r2", workMode: "branch", worktreePath: null, branch: "b2", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const branches = new BranchWatchRepo(db);
  const state = {
    guard: opts.guard ?? ({ ok: true, termId: "t1", headId: "h1" } as ReturnType<DeliveryGuard["check"]>),
    /** 开着的 session（ticket 仓库的 head）；session: null 时一个都没有。 */
    open: (opts.session === null ? [] : [{ id: opts.session ?? "h1", gitBranch: null, coordinator: false }]) as RecipientCandidate[],
    /** 记下的分支归属：`${ticket}:${repoId}:${branch}` → head id。 */
    owners: new Map<string, string>(),
    closed: new Set<string>(),
    recheck: true,
    now: 1,
  };
  const deliver = vi.fn(opts.deliver ?? (async () => "sent" as const));
  const log = vi.fn();
  const d = new CiDelivery({
    prs, branches,
    currentBranch: (id) => tickets.getRepo(id)?.branch ?? null,
    guard: opts.guardImpl ?? { check: () => state.guard, recheckAfter: () => () => state.recheck },
    recipient: opts.recipient ?? ((key, rid, branch) => {
      const owner = state.owners.get(`${key}:${rid}:${branch}`) ?? null;
      return pickRecipient({ owner, ownerOpen: owner !== null && !state.closed.has(owner), open: state.open, ticketBranch: tickets.getRepo(rid)?.branch ?? null, branch });
    }),
    deliver, now: () => state.now, log,
  });
  /** 一个读过的 PR 行。 */
  const pr = (o: TicketPrPatch & { ticketKey?: string; repoId?: number | null; number?: number } = {}) => {
    const { ticketKey = "BTL-1", repoId: rid = repoId, number = 7, ...patch } = o;
    const { pr: row } = prs.link({ ticketKey, url: `https://github.com/o/r/pull/${number}`, slug: "o/r", repoId: rid, number, headBranch: "b", state: "open", source: "branch", linkedAt: 1 });
    prs.update(row.id, { ci: "failing", headSha: "abcdef1234567", checkedAt: 1, ...patch });
    return prs.get(row.id)!;
  };
  return { db, tickets, prs, branches, repoId, otherRepo, state, deliver, log, d, pr };
}

describe("CiDelivery", () => {
  it("delivers a failure with the failed checks and log tails", async () => {
    const s = setup();
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const r = s.pr({ failed: [{ name: "test", state: "failing", runId: 1, log: lines }, { name: "lint", state: "failing", runId: 1 }] });
    await s.d.settled({ kind: "pr", id: r.id });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    const [term, text] = s.deliver.mock.calls[0] as unknown as [string, string];
    expect(term).toBe("t1");
    expect(text).toContain("PR #7");
    expect(text).toContain("abcdef1");
    expect(text).not.toContain("abcdef12");
    expect(text).toMatch(/test(、|, )lint/);
    expect(text).toContain("line99");
    expect(text).toContain("line40");
    expect(text).not.toContain("line39\n");
    expect(s.prs.get(r.id)!.deliveredKey).toBe("abcdef1234567:failing");
  });

  it("without an owner, delivers a PR row's CI only when head_branch is the repo's current branch", async () => {
    const s = setup();
    const r = s.pr({ ci: "passing" });
    // ticket 换了分支：旧分支 PR 的 CI 不递给现在的 session。
    s.tickets.updateRepo({ id: s.repoId, workMode: "branch", worktreePath: null, branch: "other" });
    await s.d.settled({ kind: "pr", id: r.id });
    await s.d.flush();
    expect(s.deliver).not.toHaveBeenCalled();
    s.tickets.updateRepo({ id: s.repoId, workMode: "branch", worktreePath: null, branch: "b" });
    await s.d.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.prs.get(r.id)!.deliveredKey).toBe(deliveryKey(r));
  });

  it("does not deliver for a PR that is not one of the ticket's repos, or that is no longer open", async () => {
    const s = setup();
    const slugOnly = s.pr({ repoId: null, number: 8 });
    const merged = s.pr({ number: 9, state: "merged" });
    await s.d.settled({ kind: "pr", id: slugOnly.id });
    await s.d.settled({ kind: "pr", id: merged.id });
    await s.d.flush();
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("delivers the same PR to each ticket that links it, through that ticket's own session", async () => {
    const seen: [string, number][] = [];
    const s = setup({ recipient: (key, repoId) => (seen.push([key, repoId]), { ok: true, sessionId: `h-${key}`, via: "ticket" }) });
    const a = s.pr({ ci: "passing" });
    const b = s.pr({ ci: "passing", ticketKey: "BTL-2", repoId: s.otherRepo });
    s.tickets.updateRepo({ id: s.otherRepo, workMode: "branch", worktreePath: null, branch: "b" });
    await s.d.flush();
    expect(seen).toEqual([["BTL-1", s.repoId], ["BTL-2", s.otherRepo]]);
    expect(s.deliver).toHaveBeenCalledTimes(2);
    expect([s.prs.get(a.id)!.deliveredKey, s.prs.get(b.id)!.deliveredKey]).toEqual(["abcdef1234567:passing", "abcdef1234567:passing"]);
  });

  it("branch rows deliver with ciWhereBranch", async () => {
    const s = setup();
    s.branches.upsert({ repoId: s.repoId, ticketKey: "BTL-1", branch: "b", ci: "passing", headSha: "abcdef1234567", failed: [], readError: false, checkedAt: 1 });
    await s.d.settled({ kind: "branch", repoId: s.repoId });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    const text = (s.deliver.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain("b");
    expect(text).not.toContain("PR #");
    expect(s.branches.get(s.repoId)!.deliveredKey).toBe("abcdef1234567:passing");
    // 分支行是旧分支的：不递。
    s.branches.upsert({ repoId: s.otherRepo, ticketKey: "BTL-2", branch: "old", ci: "failing", headSha: "f1", failed: [], readError: false, checkedAt: 1 });
    await s.d.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("a log containing a fence cannot break out", async () => {
    const s = setup();
    const r = s.pr({ failed: [{ name: "t", state: "failing", runId: 1, log: "a\n```\nb" }] });
    await s.d.settled({ kind: "pr", id: r.id });
    expect((s.deliver.mock.calls[0] as unknown as [string, string])[1]).toContain("````\na\n```\nb\n````");
  });

  it("queues until the session stops", async () => {
    const s = setup({ guard: { ok: false, block: "busy" } });
    const r = s.pr();
    await s.d.settled({ kind: "pr", id: r.id });
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.prs.get(r.id)!.deliveredKey).toBeNull();
    s.state.guard = { ok: true, termId: "t1", headId: "h1" };
    await s.d.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("passes a recheck to deliver and keeps the result when it is held back right before the paste (I2)", async () => {
    const s = setup({ deliver: async (_t, _x, recheck) => (recheck() ? "sent" : "blocked") });
    const r = s.pr();
    s.state.recheck = false;
    await s.d.settled({ kind: "pr", id: r.id });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.prs.get(r.id)!.deliveredKey).toBeNull();
    s.state.recheck = true;
    await s.d.flush();
    expect(s.deliver).toHaveBeenCalledTimes(2);
    expect(s.prs.get(r.id)!.deliveredKey).toBe(deliveryKey(r));
  });

  it("does not deliver twice for the same key", async () => {
    const s = setup();
    const r = s.pr();
    await s.d.settled({ kind: "pr", id: r.id });
    await s.d.settled({ kind: "pr", id: r.id });
    await s.d.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("does not mark when deliver fails", async () => {
    const s = setup({ deliver: async () => "timeout" });
    const r = s.pr();
    await s.d.settled({ kind: "pr", id: r.id });
    expect(s.prs.get(r.id)!.deliveredKey).toBeNull();
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the repo has no open session", async () => {
    const s = setup({ session: null });
    const r = s.pr();
    await s.d.settled({ kind: "pr", id: r.id });
    await s.d.flush();
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.prs.get(r.id)!.deliveredKey).toBeNull();
  });

  it("skips pending rows in flush and sends one at a time per session", async () => {
    let release!: () => void;
    const s = setup({ deliver: () => new Promise((res) => { release = () => res("sent"); }) });
    const r = s.pr();
    s.pr({ number: 8, ci: "pending" });
    const p1 = s.d.settled({ kind: "pr", id: r.id });
    const p2 = s.d.flush();
    await Promise.resolve();
    release();
    await Promise.all([p1, p2]);
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });
});

describe("CiDelivery picks the session the PR belongs to (workstream W)", () => {
  it("delivers a PR opened from a worktree branch to the session that pushed it", async () => {
    const s = setup();
    // 子 session 在自己的 worktree 里开 feat/ws-a，ticket 仓库的分支还是 b。
    const r = s.pr({ ci: "passing", headBranch: "feat/ws-a" });
    s.state.owners.set(`BTL-1:${s.repoId}:feat/ws-a`, "h1");
    await s.d.settled({ kind: "pr", id: r.id });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.prs.get(r.id)!.deliveredKey).toBe(deliveryKey(r));
  });

  it("with several sessions on one repo, each gets only the PR on its own branch", async () => {
    const terms: Record<string, string> = { ha: "ta", hb: "tb", hc: "tc" };
    const s = setup({
      guardImpl: { check: (id) => ({ ok: true, termId: terms[id], headId: id }), recheckAfter: () => () => true },
    });
    s.state.open = [{ id: "hc", gitBranch: "b", coordinator: false }, { id: "ha", gitBranch: "b", coordinator: false }, { id: "hb", gitBranch: "b", coordinator: false }];
    const a = s.pr({ number: 1, ci: "passing", headBranch: "feat/a" });
    const b = s.pr({ number: 2, ci: "failing", headBranch: "feat/b" });
    s.state.owners.set(`BTL-1:${s.repoId}:feat/a`, "ha");
    s.state.owners.set(`BTL-1:${s.repoId}:feat/b`, "hb");
    await s.d.flush();
    const sent = s.deliver.mock.calls.map((c) => [c[0], (c[1] as string).match(/PR #(\d+)/)?.[1]]);
    expect(sent.sort()).toEqual([["ta", "1"], ["tb", "2"]]);
    expect([s.prs.get(a.id)!.deliveredKey, s.prs.get(b.id)!.deliveredKey]).toEqual([deliveryKey(a), deliveryKey(b)]);
  });

  it("does not hand an owned PR's result to a session on another branch when the owner's terminal is closed", async () => {
    const s = setup();
    s.state.open = [{ id: "h2", gitBranch: "feat/other", coordinator: false }];
    const r = s.pr({ ci: "passing", headBranch: "b" });
    s.state.owners.set(`BTL-1:${s.repoId}:b`, "h1");
    s.state.closed.add("h1");
    await s.d.settled({ kind: "pr", id: r.id });
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith(expect.stringMatching(/BTL-1#7 .*not delivered: owner_closed/));
  });

  it("hands it to the new session on the same branch when the session that pushed it has closed", async () => {
    const s = setup();
    s.state.open = [{ id: "h2", gitBranch: "b", coordinator: false }];
    const r = s.pr({ ci: "passing", headBranch: "b" });
    s.state.owners.set(`BTL-1:${s.repoId}:b`, "h1");
    s.state.closed.add("h1");
    await s.d.settled({ kind: "pr", id: r.id });
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("an unidentified PR off the ticket branch is only logged, never a Now notice (nobody was promised it)", async () => {
    const s = setup();
    s.state.open = [{ id: "h2", gitBranch: "feat/x", coordinator: false }, { id: "h3", gitBranch: "feat/y", coordinator: false }];
    const r = s.pr({ ci: "passing", headBranch: "feat/related" });
    await s.d.settled({ kind: "pr", id: r.id });
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith(expect.stringMatching(/not delivered: unowned/));
    s.state.now = CI_UNDELIVERED_MS + 10;
    expect(s.d.undelivered()).toEqual([]);
  });

  it("logs every reason it does not deliver, once per reason", async () => {
    const s = setup({ guard: { ok: false, block: "typing" } });
    const r = s.pr();
    await s.d.settled({ kind: "pr", id: r.id });
    await s.d.flush();
    await s.d.flush();
    const lines = () => s.log.mock.calls.map((c) => c[0] as string).filter((m) => m.startsWith("ci delivery"));
    expect(lines()).toEqual([expect.stringMatching(/BTL-1#7 \(abcdef1:failing\) not delivered: guard:typing/)]);
    s.state.guard = { ok: false, block: "draft" };
    await s.d.flush();
    expect(lines()).toHaveLength(2);
    // 没有 sha、没有开着的 session、PR 不在 ticket 仓库：都记一笔。
    const noSha = s.pr({ number: 8, headSha: null });
    const elsewhere = s.pr({ number: 9, repoId: null });
    s.state.guard = { ok: true, termId: "t1", headId: "h1" };
    s.state.open = [];
    const other = s.pr({ number: 10, headBranch: "feat/x" });
    await s.d.flush();
    for (const [n, reason] of [[8, "no_sha"], [9, "no_repo"], [10, "no_session"], [7, "no_session"]] as const) {
      expect(lines().some((m) => m.includes(`BTL-1#${n} `) && m.endsWith(`not delivered: ${reason}`))).toBe(true);
    }
    // 两个开着的 session、PR 不在 ticket 分支上、没有归属：认不出是谁的。
    s.state.open = [{ id: "h1", gitBranch: "b", coordinator: false }, { id: "h2", gitBranch: "b", coordinator: false }];
    await s.d.flush();
    expect(lines().some((m) => m.includes("BTL-1#10 ") && m.endsWith("not delivered: unowned"))).toBe(true);
    void noSha; void elsewhere; void other;
  });

  it("lists results stuck for 30 minutes and resends them on request", async () => {
    const s = setup({ guard: { ok: false, block: "busy" } });
    const r = s.pr();
    await s.d.settled({ kind: "pr", id: r.id });
    expect(s.d.undelivered()).toEqual([]);
    s.state.now = 1 + CI_UNDELIVERED_MS;
    await s.d.flush();
    expect(s.d.undelivered()).toEqual([
      expect.objectContaining({ item: { kind: "pr", id: r.id }, ticketKey: "BTL-1", number: 7, branch: "b", reason: "guard:busy", since: 1, sessionId: "h1" }),
    ]);
    // 归属的终端关了、没有 session：没人在等，不提醒。
    const owned = s.pr({ number: 8, headBranch: "feat/o" });
    s.state.owners.set(`BTL-1:${s.repoId}:feat/o`, "hx");
    s.state.closed.add("hx");
    await s.d.flush();
    s.state.now += CI_UNDELIVERED_MS;
    await s.d.flush();
    expect(s.d.undelivered().map((u) => u.number)).toEqual([7]);
    s.state.guard = { ok: true, termId: "t1", headId: "h1" };
    expect(await s.d.resend({ kind: "pr", id: r.id })).toBe("sent");
    expect(s.d.undelivered()).toEqual([]);
    expect(await s.d.resend({ kind: "pr", id: r.id })).toBe("delivered");
    expect(await s.d.resend({ kind: "pr", id: owned.id })).toBe("owner_closed");
  });

  it("a new commit restarts the undelivered clock", async () => {
    const s = setup({ guard: { ok: false, block: "busy" } });
    const r = s.pr();
    await s.d.settled({ kind: "pr", id: r.id });
    s.state.now = CI_UNDELIVERED_MS;
    s.prs.update(r.id, { headSha: "fedcba9876543" });
    await s.d.flush();
    s.state.now = CI_UNDELIVERED_MS + 10;
    expect(s.d.undelivered()).toEqual([]);
  });
});

describe("pickRecipient", () => {
  const c = (id: string, gitBranch: string | null = null, coordinator = false): RecipientCandidate => ({ id, gitBranch, coordinator });
  const pick = (owner: string | null, ownerOpen: boolean, open: RecipientCandidate[], branch: string, ticketBranch = "main") => pickRecipient({ owner, ownerOpen, open, ticketBranch, branch });
  it("prefers the open owner", () => {
    expect(pick("o", true, [c("a", "b")], "b")).toEqual({ ok: true, sessionId: "o", via: "owner" });
  });
  it("a closed owner is replaced only by the one session started on that branch", () => {
    expect(pick("o", false, [c("a", "b")], "b")).toEqual({ ok: true, sessionId: "a", via: "branch" });
    expect(pick("o", false, [c("a", "feat")], "b")).toEqual({ ok: false, reason: "owner_closed" });
    expect(pick("o", false, [c("a", "b"), c("x", "b")], "b")).toEqual({ ok: false, reason: "owner_closed" });
    expect(pick("o", false, [c("a")], "main")).toEqual({ ok: false, reason: "owner_closed" });
  });
  it("without an owner: the one session on that branch; off the ticket branch an unknown one is unowned and not promised", () => {
    expect(pick(null, false, [c("a", "main"), c("x", "feat"), c("k", "feat", true)], "feat")).toEqual({ ok: true, sessionId: "x", via: "branch" });
    expect(pick(null, false, [c("a"), c("b")], "feat")).toEqual({ ok: false, reason: "unowned", candidates: ["a", "b"], promised: false });
    expect(pick(null, false, [c("a")], "feat")).toEqual({ ok: false, reason: "unowned", candidates: ["a"], promised: false });
  });
  it("on the ticket branch: the first session started on it; child sessions on their own branches never get it", () => {
    expect(pick(null, false, [c("k", "main", true), c("a", "main"), c("b", "main")], "main")).toEqual({ ok: true, sessionId: "a", via: "ticket" });
    expect(pick(null, false, [c("w1", "feat/a"), c("w2", "feat/b")], "main")).toEqual({ ok: false, reason: "unowned", candidates: ["w1", "w2"], promised: true });
    expect(pick(null, false, [c("w1", "feat/a"), c("s", "main")], "main")).toEqual({ ok: true, sessionId: "s", via: "ticket" });
    // 只开着一个、还不知道在哪个分支上的：原来的规则。两个就认不出了。
    expect(pick(null, false, [c("k", null, true), c("a")], "main")).toEqual({ ok: true, sessionId: "a", via: "ticket" });
    expect(pick(null, false, [c("a"), c("b")], "main")).toEqual({ ok: false, reason: "unowned", candidates: ["a", "b"], promised: true });
    expect(pick(null, false, [c("k", null, true)], "main")).toEqual({ ok: false, reason: "no_session" });
  });
});

describe("CiDelivery with the real guard and needs-you tracker (I1)", () => {
  it("a Stop whose new reply is not judged yet does not get the CI result; the flush after a 'not needed' verdict does", async () => {
    const head = {
      id: "h1", ticketKey: "BTL-1", cwd: "/r", origin: "butler", gitBranch: "b", firstPrompt: null, lastActivityAt: null, waitingForInput: true,
      replacedBy: null, dismissed: false, createdAt: 0, repoId: 1, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null,
      epicId: null, model: null,
    } as Session;
    const pending: ((v: NeedsYouVerdict | null) => void)[] = [];
    const tracker = new NeedsYouTracker({
      judge: () => new Promise((r) => pending.push(r)),
      sessions: () => [{ id: "h1", cwd: "/r", waiting: true, kind: "waiting", reply: { id: "m2", text: "要我把改动拆成两个 PR 吗？" } }],
      notify: () => undefined,
    });
    const guard = new DeliveryGuard({
      termOf: () => "t1", head: () => head,
      activity: () => ({ sessionId: "h1", kind: "waiting", detail: null, background: false, startedAt: null, lastOutputAt: null, stuck: null, reason: null, action: null, lastOutput: [] }),
      pty: { lastUserInputAt: () => 0, screenNeedsUser: () => false, hasDraft: () => false, autoInputInFlight: () => false },
      needsYou: (id) => deliveryNeedsYou(tracker, id),
      now: () => 1_000_000,
    });
    const s = setup({ guardImpl: guard, recipient: () => ({ ok: true, sessionId: "h1", via: "ticket" }) });
    const r = s.pr();
    // Stop：新回复排进判断，结论还没出。
    tracker.update();
    await s.d.flush();
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.prs.get(r.id)!.deliveredKey).toBeNull();
    // 判断说不需要你：下一次 flush（PrWatcher 的 roundDone）递出去。
    pending[0]({ needsYou: false, reason: "" });
    await new Promise((res) => setTimeout(res, 0));
    await s.d.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });
});

describe("ciRecipient (pickRecipient plus hibernated sessions, workstream M)", () => {
  const head = (id: string, gitBranch: string | null = null, o: Partial<Session> = {}): Session =>
    ({
      id, ticketKey: "BTL-1", repoId: 1, gitBranch, coordinator: false, cwd: "/r", origin: "butler", firstPrompt: null, lastActivityAt: null,
      waitingForInput: true, replacedBy: null, dismissed: false, createdAt: 0, spawnedBy: null, featureId: null, fixesSession: null, epicId: null, model: null,
      ...o,
    }) as Session;
  const pick = (o: { open?: Session[]; asleep?: Session[]; owner?: string | null; ownerTermOpen?: boolean; chain?: Record<string, string>; branch?: string }) =>
    ciRecipient({
      ticketKey: "BTL-1", repoId: 1, branch: o.branch ?? "feat", ticketBranch: "main",
      openHeads: o.open ?? [], hibernatedHeads: o.asleep ?? [],
      ownerSessionId: o.owner ?? null, ownerTermOpen: o.ownerTermOpen ?? false,
      headOf: (id) => {
        const hid = o.chain?.[id] ?? id;
        return [...(o.open ?? []), ...(o.asleep ?? [])].find((h) => h.id === hid) ?? null;
      },
    });

  it("a hibernated owner gets it, ahead of an open session on the same branch", () => {
    expect(pick({ owner: "o", asleep: [head("o", "feat")], open: [head("a", "feat")] })).toEqual({ ok: true, sessionId: "o", via: "owner" });
  });

  it("an owner recorded under an older id in the chain still matches its hibernated head", () => {
    expect(pick({ owner: "o-old", chain: { "o-old": "o" }, asleep: [head("o", "feat")], open: [head("a", "feat")] })).toEqual({ ok: true, sessionId: "o", via: "owner" });
  });

  it("an open owner comes first; a hibernated session on the branch does not take it", () => {
    expect(pick({ owner: "o", ownerTermOpen: true, open: [head("o", "feat")], asleep: [head("z", "feat")] })).toEqual({ ok: true, sessionId: "o", via: "owner" });
  });

  it("open sessions are tried alone first: one open and one hibernated on the same branch goes to the open one, on or off the ticket branch", () => {
    expect(pick({ open: [head("a", "feat")], asleep: [head("z", "feat")] })).toEqual({ ok: true, sessionId: "a", via: "branch" });
    expect(pick({ branch: "main", open: [head("a", "main")], asleep: [head("z", "main")] })).toEqual({ ok: true, sessionId: "a", via: "ticket" });
  });

  it("hibernated sessions join only when the open ones give no single pick", () => {
    expect(pick({ asleep: [head("z", "feat")] })).toEqual({ ok: true, sessionId: "z", via: "branch" });
    expect(pick({ open: [head("a", "other")], asleep: [head("z", "feat")] })).toEqual({ ok: true, sessionId: "z", via: "branch" });
    // 归属者关了（不是休眠）：同一个分支上休眠着的那个顶上。
    expect(pick({ owner: "o", asleep: [head("z", "feat")] })).toEqual({ ok: true, sessionId: "z", via: "branch" });
  });

  it("keeps pickRecipient's reasons when nobody fits", () => {
    expect(pick({})).toEqual({ ok: false, reason: "no_session" });
    expect(pick({ owner: "o", open: [head("a", "other")] })).toEqual({ ok: false, reason: "owner_closed" });
    expect(pick({ asleep: [head("z", "other")] })).toEqual({ ok: false, reason: "unowned", candidates: ["z"], promised: false });
  });

  it("hibernated coordinators and heads of other tickets or repos are not candidates; a head open and hibernated counts once", () => {
    const others = [head("k", "feat", { coordinator: true }), head("x", "feat", { ticketKey: "BTL-2" }), head("y", "feat", { repoId: 2 })];
    expect(pick({ asleep: others })).toEqual({ ok: false, reason: "no_session" });
    expect(pick({ open: [head("a", "feat"), head("a", "feat")], asleep: [head("a", "feat")] })).toEqual({ ok: true, sessionId: "a", via: "branch" });
  });
});

describe("CiDelivery to a hibernated session", () => {
  it("records guard:hibernated while it wakes, delivers once after it is back, and never again for the same result", async () => {
    const s = { asleep: true, term: null as string | null, now: 1 };
    const wake = vi.fn(() => {
      s.asleep = false;
      s.term = "t-new";
    });
    // DeliveryGuard 的样子：没有终端时 wakeIfHibernated 叫醒并返回 hibernated。
    const check = (): ReturnType<DeliveryGuard["check"]> => {
      if (s.term) return { ok: true, termId: s.term, headId: "o" };
      if (s.asleep) wake();
      return { ok: false, block: "hibernated" };
    };
    const t = setup({ guardImpl: { check, recheckAfter: () => () => true } });
    const asleepHead = { id: "o", ticketKey: "BTL-1", repoId: t.repoId, gitBranch: "b", coordinator: false } as Session;
    const d = new CiDelivery({
      prs: t.prs, branches: t.branches, currentBranch: () => "b",
      guard: { check, recheckAfter: () => () => true },
      recipient: (key, rid, branch) =>
        ciRecipient({
          ticketKey: key, repoId: rid, branch, ticketBranch: "b", ownerSessionId: "o", headOf: () => asleepHead, ownerTermOpen: s.term !== null,
          openHeads: s.term ? [asleepHead] : [], hibernatedHeads: s.asleep ? [asleepHead] : [],
        }),
      deliver: t.deliver, now: () => s.now, log: t.log,
    });
    const r = t.pr();

    // 结论到的时候它在休眠：叫醒，先不递，记下原因。
    await d.settled({ kind: "pr", id: r.id });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(t.deliver).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining("not delivered: guard:hibernated"));
    s.now = 1 + CI_UNDELIVERED_MS;
    expect(d.undelivered().map((u) => u.reason)).toEqual(["guard:hibernated"]);

    // 醒来以后的 flush（sessionStopped）：递给新终端，不再挂着。
    await d.flush();
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect((t.deliver.mock.calls[0] as unknown as [string])[0]).toBe("t-new");
    expect(d.undelivered()).toEqual([]);

    // 再 flush、PrWatcher 再报一次同一个结论：都不再递，也不再叫醒。
    await d.flush();
    await d.settled({ kind: "pr", id: r.id });
    expect(t.deliver).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
