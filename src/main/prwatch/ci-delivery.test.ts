import { describe, expect, it, vi } from "vitest";
import { BranchWatchRepo } from "../db/branch-watch-repo";
import { TicketPrsRepo, type TicketPrPatch } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { DeliveryGuard } from "../sessions/delivery-guard";
import { deliveryNeedsYou, NeedsYouTracker, type NeedsYouVerdict } from "../sessions/needs-you";
import { memDb } from "../test-utils";
import type { Session } from "../../shared/types";
import { CiDelivery, deliveryKey, type CiDeliveryDeps } from "./ci-delivery";

type Deliver = (term: string, text: string, recheck: () => boolean) => Promise<"sent" | "exited" | "timeout" | "blocked">;

function setup(opts: { session?: string | null; guard?: ReturnType<DeliveryGuard["check"]>; deliver?: Deliver; guardImpl?: CiDeliveryDeps["guard"]; sessionFor?: CiDeliveryDeps["sessionFor"] } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  for (const key of ["BTL-1", "BTL-2"]) tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "BTL-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", createdAt: 1 });
  const otherRepo = tickets.addRepo({ ticketKey: "BTL-2", repoPath: "/r2", workMode: "branch", worktreePath: null, branch: "b2", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const branches = new BranchWatchRepo(db);
  const state = { guard: opts.guard ?? ({ ok: true, termId: "t1", headId: "h1" } as ReturnType<DeliveryGuard["check"]>), session: opts.session === undefined ? "h1" : opts.session, recheck: true };
  const deliver = vi.fn(opts.deliver ?? (async () => "sent" as const));
  const log = vi.fn();
  const d = new CiDelivery({
    prs, branches,
    currentBranch: (id) => tickets.getRepo(id)?.branch ?? null,
    guard: opts.guardImpl ?? { check: () => state.guard, recheckAfter: () => () => state.recheck },
    sessionFor: opts.sessionFor ?? (() => state.session),
    deliver, now: () => 1, log,
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

  it("delivers a PR row's CI only when head_branch is the repo's current branch", async () => {
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
    const s = setup({ sessionFor: (key, repoId) => (seen.push([key, repoId]), `h-${key}`) });
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
    const s = setup({ guardImpl: guard, sessionFor: () => "h1" });
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
