import { describe, expect, it, vi } from "vitest";
import { BranchWatchRepo } from "../db/branch-watch-repo";
import { TicketPrsRepo, type TicketPrPatch } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { fakeMailbox } from "../mailbox/fake-mailbox";
import { memDb } from "../test-utils";
import type { Session } from "../../shared/types";
import { CI_UNDELIVERED_MS, CiDelivery, ciRecipient, ciRef, deliveryKey, pickRecipient, type CiDeliveryDeps, type RecipientCandidate } from "./ci-delivery";

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { session?: string | null; recipient?: CiDeliveryDeps["recipient"]; triage?: CiDeliveryDeps["triage"] } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  for (const key of ["BTL-1", "BTL-2"]) tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "BTL-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", createdAt: 1 });
  const otherRepo = tickets.addRepo({ ticketKey: "BTL-2", repoPath: "/r2", workMode: "branch", worktreePath: null, branch: "b2", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const branches = new BranchWatchRepo(db);
  const state = {
    /** 假信箱现在送不送得到（目标在忙、关着时为 false：留着排队）。 */
    canDeliver: true,
    /** 开着的 session（ticket 仓库的 head）；session: null 时一个都没有。 */
    open: (opts.session === null ? [] : [{ id: opts.session ?? "h1", gitBranch: null, coordinator: false }]) as RecipientCandidate[],
    /** 记下的分支归属：`${ticket}:${repoId}:${branch}` → head id。 */
    owners: new Map<string, string>(),
    closed: new Set<string>(),
    now: 1,
  };
  /** 送到了的：[收件 session, 正文]。 */
  const deliver = vi.fn<(to: string, body: string) => void>();
  const mailbox = fakeMailbox({ canDeliver: () => state.canDeliver, deliver, now: () => state.now });
  const log = vi.fn();
  const d = new CiDelivery({
    prs, branches,
    currentBranch: (id) => tickets.getRepo(id)?.branch ?? null,
    mailbox,
    recipient: opts.recipient ?? ((key, rid, branch) => {
      const owner = state.owners.get(`${key}:${rid}:${branch}`) ?? null;
      return pickRecipient({ owner, ownerOpen: owner !== null && !state.closed.has(owner), open: state.open, ticketBranch: tickets.getRepo(rid)?.branch ?? null, branch });
    }),
    now: () => state.now, log, triage: opts.triage,
  });
  /** 一个读过的 PR 行。 */
  const pr = (o: TicketPrPatch & { ticketKey?: string; repoId?: number | null; number?: number } = {}) => {
    const { ticketKey = "BTL-1", repoId: rid = repoId, number = 7, ...patch } = o;
    const { pr: row } = prs.link({ ticketKey, url: `https://github.com/o/r/pull/${number}`, slug: "o/r", repoId: rid, number, headBranch: "b", state: "open", source: "branch", linkedAt: 1 });
    prs.update(row.id, { ci: "failing", headSha: "abcdef1234567", checkedAt: 1, ...patch });
    return prs.get(row.id)!;
  };
  /** settled / flush 以后假信箱在微任务里送：等它送完。 */
  const settled = async (item: Parameters<CiDelivery["settled"]>[0]) => {
    await d.settled(item);
    await flushPromises();
  };
  const flush = async () => {
    await d.flush();
    await flushPromises();
  };
  return { db, tickets, prs, branches, repoId, otherRepo, state, deliver, mailbox, log, d, pr, settled, flush };
}

describe("CiDelivery", () => {
  it("delivers a failure with the failed checks and log tails", async () => {
    const s = setup();
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const r = s.pr({ failed: [{ name: "test", state: "failing", runId: 1, log: lines }, { name: "lint", state: "failing", runId: 1 }] });
    await s.settled({ kind: "pr", id: r.id });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    const [term, text] = s.deliver.mock.calls[0] as unknown as [string, string];
    expect(term).toBe("h1");
    expect(text).toContain("PR #7");
    expect(text).toContain("abcdef1");
    expect(text).not.toContain("abcdef12");
    expect(text).toMatch(/test(、|, )lint/);
    expect(text).toContain("line99");
    expect(text).toContain("line40");
    expect(text).not.toContain("line39\n");
    expect(s.prs.get(r.id)!.deliveredKey).toBe("abcdef1234567:failing");
  });

  it("records the recipient session and the time on a delivered PR row", async () => {
    const s = setup({ session: "h9" });
    s.state.now = 77;
    const r = s.pr();
    await s.settled({ kind: "pr", id: r.id });
    expect(s.prs.get(r.id)).toMatchObject({ deliveredKey: "abcdef1234567:failing", deliveredTo: "h9", deliveredAt: 77 });
  });

  it("without an owner, delivers a PR row's CI only when head_branch is the repo's current branch", async () => {
    const s = setup();
    const r = s.pr({ ci: "passing" });
    // ticket 换了分支：旧分支 PR 的 CI 不递给现在的 session。
    s.tickets.updateRepo({ id: s.repoId, workMode: "branch", worktreePath: null, branch: "other" });
    await s.settled({ kind: "pr", id: r.id });
    await s.flush();
    expect(s.deliver).not.toHaveBeenCalled();
    s.tickets.updateRepo({ id: s.repoId, workMode: "branch", worktreePath: null, branch: "b" });
    await s.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.prs.get(r.id)!.deliveredKey).toBe(deliveryKey(r));
  });

  it("does not deliver for a PR that is not one of the ticket's repos, or that is no longer open", async () => {
    const s = setup();
    const slugOnly = s.pr({ repoId: null, number: 8 });
    const merged = s.pr({ number: 9, state: "merged" });
    await s.settled({ kind: "pr", id: slugOnly.id });
    await s.settled({ kind: "pr", id: merged.id });
    await s.flush();
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("delivers the same PR to each ticket that links it, through that ticket's own session", async () => {
    const seen: [string, number][] = [];
    const s = setup({ recipient: (key, repoId) => (seen.push([key, repoId]), { ok: true, sessionId: `h-${key}`, via: "ticket" }) });
    const a = s.pr({ ci: "passing" });
    const b = s.pr({ ci: "passing", ticketKey: "BTL-2", repoId: s.otherRepo });
    s.tickets.updateRepo({ id: s.otherRepo, workMode: "branch", worktreePath: null, branch: "b" });
    await s.flush();
    expect(seen).toEqual([["BTL-1", s.repoId], ["BTL-2", s.otherRepo]]);
    expect(s.deliver).toHaveBeenCalledTimes(2);
    expect([s.prs.get(a.id)!.deliveredKey, s.prs.get(b.id)!.deliveredKey]).toEqual(["abcdef1234567:passing", "abcdef1234567:passing"]);
  });

  it("branch rows deliver with ciWhereBranch", async () => {
    const s = setup();
    s.branches.upsert({ repoId: s.repoId, ticketKey: "BTL-1", branch: "b", ci: "passing", headSha: "abcdef1234567", failed: [], readError: false, checkedAt: 1 });
    await s.settled({ kind: "branch", repoId: s.repoId });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    const text = (s.deliver.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain("b");
    expect(text).not.toContain("PR #");
    expect(s.branches.get(s.repoId)!.deliveredKey).toBe("abcdef1234567:passing");
    // 分支行是旧分支的：不递。
    s.branches.upsert({ repoId: s.otherRepo, ticketKey: "BTL-2", branch: "old", ci: "failing", headSha: "f1", failed: [], readError: false, checkedAt: 1 });
    await s.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("a log containing a fence cannot break out", async () => {
    const s = setup();
    const r = s.pr({ failed: [{ name: "t", state: "failing", runId: 1, log: "a\n```\nb" }] });
    await s.settled({ kind: "pr", id: r.id });
    expect((s.deliver.mock.calls[0] as unknown as [string, string])[1]).toContain("````\na\n```\nb\n````");
  });

  it("moves a queued result to the session that owns the branch now when its first recipient went away", async () => {
    const s = setup();
    s.state.canDeliver = false;
    const r = s.pr();
    await s.settled({ kind: "pr", id: r.id });
    expect(s.mailbox.queued.get(`ci:pr:${r.id}`)?.toSession).toBe("h1");
    // h1 关了，同一个分支上开了 h2：排着的结论改投 h2，不留给 h1 等它重开。
    s.state.open = [{ id: "h2", gitBranch: null, coordinator: false }];
    await s.flush();
    expect(s.mailbox.queued.get(`ci:pr:${r.id}`)?.toSession).toBe("h2");
    s.state.canDeliver = true;
    s.mailbox.deliverQueued();
    await flushPromises();
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.deliver.mock.calls[0][0]).toBe("h2");
  });

  it("keeps it queued while the session cannot take it, marks it once it arrives, and does not queue it twice", async () => {
    const s = setup();
    s.state.canDeliver = false;
    const r = s.pr();
    await s.settled({ kind: "pr", id: r.id });
    await s.flush();
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.prs.get(r.id)!.deliveredKey).toBeNull();
    expect([...s.mailbox.queued.keys()]).toEqual([ciRef({ kind: "pr", id: r.id })]);
    expect(s.mailbox.queued.get(ciRef({ kind: "pr", id: r.id }))!.kind).toBe("ci");
    // 排着的时候点重发：已经排着，就算交出去了。
    expect(await s.d.resend({ kind: "pr", id: r.id })).toBe("sent");
    expect(s.mailbox.queued.size).toBe(1);
    s.state.canDeliver = true;
    s.mailbox.deliverQueued();
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.prs.get(r.id)!.deliveredKey).toBe(deliveryKey(r));
  });

  it("withdraws a queued result once CI runs again or the PR is merged; a new commit replaces it", async () => {
    const s = setup();
    s.state.canDeliver = false;
    const r = s.pr();
    const ref = ciRef({ kind: "pr", id: r.id });
    await s.settled({ kind: "pr", id: r.id });
    s.prs.update(r.id, { headSha: "fedcba9876543", ci: "passing" });
    await s.flush();
    expect(s.mailbox.queued.get(ref)!.body).toContain("fedcba9");
    expect((s.mailbox.queued.get(ref)!.meta as { key: string }).key).toBe("fedcba9876543:passing");
    s.prs.update(r.id, { ci: "pending" });
    await s.flush();
    expect(s.mailbox.queued.has(ref)).toBe(false);
    s.prs.update(r.id, { ci: "failing" });
    await s.flush();
    expect(s.mailbox.queued.has(ref)).toBe(true);
    s.prs.update(r.id, { state: "merged" });
    await s.flush();
    expect(s.mailbox.queued.has(ref)).toBe(false);
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("does not deliver twice for the same key", async () => {
    const s = setup();
    const r = s.pr();
    await s.settled({ kind: "pr", id: r.id });
    await s.settled({ kind: "pr", id: r.id });
    await s.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the repo has no open session", async () => {
    const s = setup({ session: null });
    const r = s.pr();
    await s.settled({ kind: "pr", id: r.id });
    await s.flush();
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.prs.get(r.id)!.deliveredKey).toBeNull();
  });

  it("skips pending rows in flush", async () => {
    const s = setup();
    s.pr();
    s.pr({ number: 8, ci: "pending" });
    await s.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });
});

describe("CiDelivery picks the session the PR belongs to (workstream W)", () => {
  it("delivers a PR opened from a worktree branch to the session that pushed it", async () => {
    const s = setup();
    // 子 session 在自己的 worktree 里开 feat/ws-a，ticket 仓库的分支还是 b。
    const r = s.pr({ ci: "passing", headBranch: "feat/ws-a" });
    s.state.owners.set(`BTL-1:${s.repoId}:feat/ws-a`, "h1");
    await s.settled({ kind: "pr", id: r.id });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.prs.get(r.id)!.deliveredKey).toBe(deliveryKey(r));
  });

  it("with several sessions on one repo, each gets only the PR on its own branch", async () => {
    const s = setup();
    s.state.open = [{ id: "hc", gitBranch: "b", coordinator: false }, { id: "ha", gitBranch: "b", coordinator: false }, { id: "hb", gitBranch: "b", coordinator: false }];
    const a = s.pr({ number: 1, ci: "passing", headBranch: "feat/a" });
    const b = s.pr({ number: 2, ci: "failing", headBranch: "feat/b" });
    s.state.owners.set(`BTL-1:${s.repoId}:feat/a`, "ha");
    s.state.owners.set(`BTL-1:${s.repoId}:feat/b`, "hb");
    await s.flush();
    const sent = s.deliver.mock.calls.map((c) => [c[0], (c[1] as string).match(/PR #(\d+)/)?.[1]]);
    expect(sent.sort()).toEqual([["ha", "1"], ["hb", "2"]]);
    expect([s.prs.get(a.id)!.deliveredKey, s.prs.get(b.id)!.deliveredKey]).toEqual([deliveryKey(a), deliveryKey(b)]);
  });

  it("does not hand an owned PR's result to a session on another branch when the owner's terminal is closed", async () => {
    const s = setup();
    s.state.open = [{ id: "h2", gitBranch: "feat/other", coordinator: false }];
    const r = s.pr({ ci: "passing", headBranch: "b" });
    s.state.owners.set(`BTL-1:${s.repoId}:b`, "h1");
    s.state.closed.add("h1");
    await s.settled({ kind: "pr", id: r.id });
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith(expect.stringMatching(/BTL-1#7 .*not delivered: owner_closed/));
  });

  it("hands it to the new session on the same branch when the session that pushed it has closed", async () => {
    const s = setup();
    s.state.open = [{ id: "h2", gitBranch: "b", coordinator: false }];
    const r = s.pr({ ci: "passing", headBranch: "b" });
    s.state.owners.set(`BTL-1:${s.repoId}:b`, "h1");
    s.state.closed.add("h1");
    await s.settled({ kind: "pr", id: r.id });
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("an unidentified PR off the ticket branch is only logged, never a Now notice (nobody was promised it)", async () => {
    const s = setup();
    s.state.open = [{ id: "h2", gitBranch: "feat/x", coordinator: false }, { id: "h3", gitBranch: "feat/y", coordinator: false }];
    const r = s.pr({ ci: "passing", headBranch: "feat/related" });
    await s.settled({ kind: "pr", id: r.id });
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith(expect.stringMatching(/not delivered: unowned/));
    s.state.now = CI_UNDELIVERED_MS + 10;
    expect(s.d.undelivered()).toEqual([]);
  });

  it("logs every reason it does not deliver, once per reason", async () => {
    const s = setup();
    s.state.open = [];
    const r = s.pr();
    await s.settled({ kind: "pr", id: r.id });
    await s.flush();
    await s.flush();
    const lines = () => s.log.mock.calls.map((c) => c[0] as string).filter((m) => m.startsWith("ci delivery") && m.includes("not delivered"));
    expect(lines()).toEqual([expect.stringMatching(/BTL-1#7 \(abcdef1:failing\) not delivered: no_session/)]);
    // 没有 sha、PR 不在 ticket 仓库、别的分支：都记一笔。
    s.pr({ number: 8, headSha: null });
    s.pr({ number: 9, repoId: null });
    s.pr({ number: 10, headBranch: "feat/x" });
    await s.flush();
    for (const [n, reason] of [[8, "no_sha"], [9, "no_repo"], [10, "no_session"]] as const) {
      expect(lines().some((m) => m.includes(`BTL-1#${n} `) && m.endsWith(`not delivered: ${reason}`))).toBe(true);
    }
    // 两个开着的 session、PR 不在 ticket 分支上、没有归属：认不出是谁的。
    s.state.open = [{ id: "h1", gitBranch: "b", coordinator: false }, { id: "h2", gitBranch: "b", coordinator: false }];
    await s.flush();
    expect(lines().some((m) => m.includes("BTL-1#10 ") && m.endsWith("not delivered: unowned"))).toBe(true);
  });

  it("lists results nobody could be found for on the ticket branch after 30 minutes, and resends them on request", async () => {
    const s = setup();
    // ticket 分支上两个 session 都没记分支：认不出是谁的，本来有人等着（promised）。
    s.state.open = [{ id: "h1", gitBranch: null, coordinator: false }, { id: "h2", gitBranch: null, coordinator: false }];
    const r = s.pr();
    await s.settled({ kind: "pr", id: r.id });
    expect(s.d.undelivered()).toEqual([]);
    s.state.now = 1 + CI_UNDELIVERED_MS;
    await s.flush();
    expect(s.d.undelivered()).toEqual([
      expect.objectContaining({ item: { kind: "pr", id: r.id }, ticketKey: "BTL-1", number: 7, branch: "b", reason: "unowned", since: 1, sessionId: null }),
    ]);
    // 归属的终端关了：没人在等，不提醒。
    const owned = s.pr({ number: 8, headBranch: "feat/o" });
    s.state.owners.set(`BTL-1:${s.repoId}:feat/o`, "hx");
    s.state.closed.add("hx");
    await s.flush();
    s.state.now += CI_UNDELIVERED_MS;
    await s.flush();
    expect(s.d.undelivered().map((u) => u.number)).toEqual([7]);
    s.state.open = [{ id: "h1", gitBranch: "b", coordinator: false }];
    expect(await s.d.resend({ kind: "pr", id: r.id })).toBe("sent");
    await flushPromises();
    expect(s.d.undelivered()).toEqual([]);
    expect(await s.d.resend({ kind: "pr", id: r.id })).toBe("delivered");
    expect(await s.d.resend({ kind: "pr", id: owned.id })).toBe("owner_closed");
  });

  it("a new commit restarts the undelivered clock", async () => {
    const s = setup();
    s.state.open = [{ id: "h1", gitBranch: null, coordinator: false }, { id: "h2", gitBranch: null, coordinator: false }];
    const r = s.pr();
    await s.settled({ kind: "pr", id: r.id });
    s.state.now = CI_UNDELIVERED_MS;
    s.prs.update(r.id, { headSha: "fedcba9876543" });
    await s.flush();
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

describe("ciRecipient (pickRecipient plus hibernated sessions, workstream M)", () => {
  const head = (id: string, gitBranch: string | null = null, o: Partial<Session> = {}): Session =>
    ({
      id, ticketKey: "BTL-1", repoId: 1, gitBranch, coordinator: false, cwd: "/r", origin: "butler", firstPrompt: null, lastActivityAt: null,
      waitingForInput: true, replacedBy: null, dismissed: false, createdAt: 0, spawnedBy: null, featureId: null, fixesSession: null, model: null,
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
  it("queues it for the hibernated owner (the mailbox wakes it), delivers once, and never again for the same result", async () => {
    const t = setup({
      recipient: (key, rid, branch) => {
        const asleepHead = { id: "o", ticketKey: "BTL-1", repoId: t.repoId, gitBranch: "b", coordinator: false } as Session;
        return ciRecipient({ ticketKey: key, repoId: rid, branch, ticketBranch: "b", ownerSessionId: "o", headOf: () => asleepHead, ownerTermOpen: false, openHeads: [], hibernatedHeads: [asleepHead] });
      },
    });
    t.state.canDeliver = false;
    const r = t.pr();
    await t.settled({ kind: "pr", id: r.id });
    expect(t.mailbox.queued.get(ciRef({ kind: "pr", id: r.id }))!.toSession).toBe("o");
    t.state.now = 1 + CI_UNDELIVERED_MS;
    expect(t.d.undelivered()).toEqual([]);
    // 醒来停下：信箱送进去。
    t.state.canDeliver = true;
    t.mailbox.deliverQueued();
    expect(t.deliver).toHaveBeenCalledTimes(1);
    await t.flush();
    await t.settled({ kind: "pr", id: r.id });
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });
});

describe("CiDelivery with CI triage (workstream I)", () => {
  it("holds while triage works, without counting it as undelivered", async () => {
    const decide = vi.fn((): import("../loop/ci-triage").TriageDecision => ({ action: "hold", reason: "triage" }));
    const s = setup({ triage: { decide } });
    const r = s.pr({ failed: [{ name: "test", state: "failing", runId: 1 }] });
    expect(await s.d.resend({ kind: "pr", id: r.id })).toBe("triage");
    s.state.now = CI_UNDELIVERED_MS * 2;
    await s.flush();
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.d.undelivered()).toEqual([]);
    expect(decide).toHaveBeenCalledWith({ kind: "pr", id: r.id }, expect.objectContaining({ ci: "failing", headSha: "abcdef1234567" }));
  });

  it("appends the note and tells triage once it arrives", async () => {
    const onSent = vi.fn();
    const s = setup({ triage: { decide: () => ({ action: "deliver", note: "可能是 flaky：重跑了 2 次", onSent }) } });
    const r = s.pr({ failed: [{ name: "test", state: "failing", runId: 1 }] });
    await s.settled({ kind: "pr", id: r.id });
    const text = s.deliver.mock.calls[0][1] as string;
    expect(text).toMatch(/push[\s\S]*可能是 flaky：重跑了 2 次$/);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("does not tell triage while it is still queued or after it was withdrawn, and delivers anyway when triage throws", async () => {
    const onSent = vi.fn();
    const s = setup({ triage: { decide: () => ({ action: "deliver", note: null, onSent }) } });
    s.state.canDeliver = false;
    const r = s.pr();
    await s.settled({ kind: "pr", id: r.id });
    expect(onSent).not.toHaveBeenCalled();
    s.prs.update(r.id, { ci: "pending" });
    await s.flush();
    s.state.canDeliver = true;
    s.mailbox.deliverQueued();
    expect(onSent).not.toHaveBeenCalled();
    const t = setup({ triage: { decide: () => { throw new Error("boom"); } } });
    const q = t.pr();
    await t.settled({ kind: "pr", id: q.id });
    expect(t.deliver).toHaveBeenCalledTimes(1);
  });
});
