import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import type { Db } from "./database";
import { PrStageRepo } from "./pr-stage-repo";
import { linkedOpen, PR_READ_GIVE_UP, PR_READ_RETRY_MS, prGivenUp, TicketPrsRepo, type NewPrLink } from "./ticket-prs-repo";
import { TicketsRepo } from "./tickets-repo";

function setup(): { db: Db; prs: TicketPrsRepo; tickets: TicketsRepo; repoId: number } {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  for (const key of ["T-1", "T-2"]) tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "feat", createdAt: 1 });
  return { db, prs: new TicketPrsRepo(db), tickets, repoId };
}

const link = (o: Partial<NewPrLink> = {}): NewPrLink => ({
  ticketKey: "T-1", url: "https://github.com/a/b/pull/1", slug: "a/b", repoId: null, number: 1, headBranch: null, state: "open",
  source: "branch", linkedAt: 10, ...o,
});

describe("TicketPrsRepo", () => {
  it("new rows start with empty ws-b fields; update writes and reads them back", () => {
    const { db, prs } = setup();
    const p = prs.link(link()).pr;
    expect(p).toMatchObject({
      baseBranch: null, isDraft: false, title: null, author: null, labels: [], reviewRequests: [], reviewers: [], mergeable: null, mergeState: null, statusChangedAt: null,
    });
    prs.update(p.id, {
      baseBranch: "main", isDraft: true, title: "[ui] x", author: "me", labels: ["a", "b"], reviewRequests: [{ kind: "team", name: "core" }],
      reviewers: [{ login: "alice", state: "approved", at: 3, bot: false }], mergeable: "conflicting", mergeState: "dirty", statusChangedAt: 42,
    });
    expect(prs.get(p.id)).toMatchObject({
      baseBranch: "main", isDraft: true, title: "[ui] x", author: "me", labels: ["a", "b"], reviewRequests: [{ kind: "team", name: "core" }],
      reviewers: [{ login: "alice", state: "approved", at: 3, bot: false }], mergeable: "conflicting", mergeState: "dirty", statusChangedAt: 42,
    });
    // 坏的 JSON 不让整行读不出来。
    db.prepare(`UPDATE ticket_prs SET labels = 'nope', reviewers = '{"x":1}' WHERE id = ?`).run(p.id);
    expect(prs.get(p.id)).toMatchObject({ labels: [], reviewers: [] });
  });

  it("link fills nulls on a second link but keeps the read state", () => {
    const { prs, repoId } = setup();
    expect(repoId).toBeGreaterThan(0);
    const first = prs.link(link({ state: "merged" }));
    expect(first.created).toBe(true);
    prs.update(first.pr.id, { checkedAt: 5 });
    const second = prs.link(link({ repoId, headBranch: "feat", mergedAt: 7, state: "open" }));
    expect(second.created).toBe(false);
    expect(second.pr).toMatchObject({ id: first.pr.id, repoId, headBranch: "feat", mergedAt: 7, state: "merged" });
  });

  it("link on a never-read row takes the newer reported state", () => {
    const { prs } = setup();
    prs.link(link({ state: "open" }));
    expect(prs.link(link({ state: "merged" })).pr.state).toBe("merged");
  });

  it("the same url under two tickets is two rows; byUrl returns both", () => {
    const { prs } = setup();
    prs.link(link());
    prs.link(link({ ticketKey: "T-2" }));
    expect(prs.byUrl("https://github.com/a/b/pull/1").map((p) => p.ticketKey)).toEqual(["T-1", "T-2"]);
  });

  it("normalises urls with prUrlKey inside the repo", () => {
    const { prs } = setup();
    const a = prs.link(link({ url: "https://github.com/A/B/pull/3/", number: 3 }));
    const b = prs.link(link({ url: "https://github.com/a/b/pull/3", number: 3 }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.pr.id).toBe(a.pr.id);
    expect(prs.byTicket("T-1")).toHaveLength(1);
    expect(prs.byUrl("https://github.com/A/B/pull/3/")).toHaveLength(1);
    expect(prs.byUrl("https://github.com/a/b/pull/3")).toHaveLength(1);
  });

  it("byTicket is newest first", () => {
    const { prs } = setup();
    prs.link(link({ openedAt: 100 }));
    prs.link(link({ url: "https://github.com/a/b/pull/2", number: 2, openedAt: 200 }));
    prs.link(link({ url: "https://github.com/a/b/pull/3", number: 3, linkedAt: 150 }));
    expect(prs.byTicket("T-1").map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it("needingRead lists open rows and never-read terminal rows only", () => {
    const { prs } = setup();
    const open = prs.link(link({ url: "u/1", number: 1 })).pr;
    const readOpen = prs.link(link({ url: "u/2", number: 2 })).pr;
    const neverRead = prs.link(link({ url: "u/3", number: 3, state: "merged" })).pr;
    const doneMerged = prs.link(link({ url: "u/4", number: 4, state: "merged" })).pr;
    const doneClosed = prs.link(link({ url: "u/5", number: 5, state: "closed" })).pr;
    for (const p of [readOpen, doneMerged, doneClosed]) prs.update(p.id, { checkedAt: 9 });
    expect(prs.needingRead().map((p) => p.id)).toEqual([open.id, readOpen.id, neverRead.id]);
  });

  it("noteReadFailure gives up only after 10 failures that span 24 h; then parks the row for 24 h; a successful read resets all three", () => {
    const { prs } = setup();
    const p = prs.link(link()).pr;
    expect(prs.get(p.id)).toMatchObject({ readFailures: 0, readRetryAt: null, readFailingSince: null });
    // 一小时里失败十几次（gh 短暂离线）：不放弃。
    for (let i = 0; i < PR_READ_GIVE_UP + 2; i++) expect(prs.noteReadFailure(p.id, 100 + i * 60_000).gaveUp).toBe(false);
    expect(prs.get(p.id)).toMatchObject({ readFailures: PR_READ_GIVE_UP + 2, readRetryAt: null, readFailingSince: 100, readError: true });
    expect(prGivenUp(prs.get(p.id)!)).toBe(false);
    // 从第一次失败起满 24 小时还在失败：放弃，停一天。
    const at = 100 + PR_READ_RETRY_MS;
    expect(prs.noteReadFailure(p.id, at)).toEqual({ failures: PR_READ_GIVE_UP + 3, gaveUp: true });
    expect(prs.get(p.id)).toMatchObject({ readRetryAt: at + PR_READ_RETRY_MS, readFailingSince: 100 });
    expect(prGivenUp(prs.get(p.id)!)).toBe(true);
    // needingRead 不过滤：停着的由调用方决定（强制读要能读到）。
    expect(prs.needingRead().map((x) => x.id)).toEqual([p.id]);
    // 过了一天再失败：再停一天，不再算“刚放弃”。
    expect(prs.noteReadFailure(p.id, at + PR_READ_RETRY_MS).gaveUp).toBe(false);
    expect(prs.get(p.id)).toMatchObject({ readRetryAt: at + 2 * PR_READ_RETRY_MS });
    prs.update(p.id, { readError: false, readFailures: 0, readRetryAt: null, readFailingSince: null, checkedAt: 300 });
    expect(prs.get(p.id)).toMatchObject({ readFailures: 0, readRetryAt: null, readFailingSince: null });
  });

  it("noteReadFailure with count: false only flags read_error (an outage round)", () => {
    const { prs } = setup();
    const p = prs.link(link()).pr;
    prs.update(p.id, { checkedAt: 5 });
    expect(prs.noteReadFailure(p.id, 50, { count: false })).toEqual({ failures: 0, gaveUp: false });
    expect(prs.get(p.id)).toMatchObject({ readError: true, checkedAt: 50, readFailures: 0, readFailingSince: null, readRetryAt: null });
  });

  it("noteReadFailure keeps checked_at at 0 on a never-read row and stamps it on a read row", () => {
    const { prs } = setup();
    const unread = prs.link(link({ url: "u/1", number: 1 })).pr;
    const read = prs.link(link({ url: "u/2", number: 2 })).pr;
    prs.update(read.id, { checkedAt: 5 });
    prs.noteReadFailure(unread.id, 50);
    prs.noteReadFailure(read.id, 50);
    expect(prs.get(unread.id)).toMatchObject({ checkedAt: 0, readError: true, readFailures: 1 });
    expect(prs.get(read.id)).toMatchObject({ checkedAt: 50, readError: true, readFailures: 1 });
  });

  it("linkedOpen: a read open PR counts; never-read and given-up ones do not", () => {
    const row = { state: "open" as const, checkedAt: 5, readRetryAt: null };
    expect(linkedOpen([row])).toBe(true);
    expect(linkedOpen([{ ...row, checkedAt: 0 }])).toBe(false);
    expect(linkedOpen([{ ...row, readRetryAt: 9 }])).toBe(false);
    expect(linkedOpen([{ ...row, state: "merged" }])).toBe(false);
  });

  it("pendingMerged (read rows only), setMergedHandled, setDelivered and update round-trip", () => {
    const { prs } = setup();
    const p = prs.link(link({ state: "merged" })).pr;
    // 还没读过的不算：读到合并时间之前不知道是不是早就合并了。
    expect(prs.pendingMerged()).toEqual([]);
    prs.update(p.id, { checkedAt: 9 });
    expect(prs.pendingMerged().map((x) => x.id)).toEqual([p.id]);
    prs.setMergedHandled(p.id, 50);
    prs.setDelivered(p.id, "sha:failing");
    prs.update(p.id, { ci: "failing", readError: true, failed: [], review: "approved", headSha: "abc" });
    expect(prs.pendingMerged()).toEqual([]);
    expect(prs.get(p.id)).toMatchObject({ mergedHandledAt: 50, deliveredKey: "sha:failing", ci: "failing", readError: true, review: "approved", headSha: "abc" });
    expect(prs.slugs()).toEqual(["a/b"]);
  });

  it("pruneStale removes non-merged branch/backfill rows of an old head branch and keeps merged and handoff rows", () => {
    const { prs, repoId } = setup();
    const mk = (n: number, o: Partial<NewPrLink>) => prs.link(link({ url: `u/${n}`, number: n, repoId, headBranch: "old", ...o })).pr;
    const stale = mk(1, {});
    const staleBackfill = mk(2, { source: "backfill" });
    const merged = mk(3, { state: "merged" });
    const handoff = mk(4, { source: "handoff" });
    const current = mk(5, { headBranch: "feat" });
    expect(prs.pruneStale(repoId, "feat")).toBe(2);
    expect(prs.get(stale.id)).toBeNull();
    expect(prs.get(staleBackfill.id)).toBeNull();
    for (const p of [merged, handoff, current]) expect(prs.get(p.id)).not.toBeNull();
  });

  it("pruneStale keeps a closed PR of an old head branch, and with it its stage events", () => {
    const { db, prs, repoId } = setup();
    const stages = new PrStageRepo(db);
    const closed = prs.link(link({ url: "u/1", number: 1, repoId, headBranch: "old", state: "closed" })).pr;
    stages.add(
      { ticketKey: "T-1", repoId, prId: closed.id, branch: "old", featureId: null, epicId: null, sessionId: null, kind: "closed", at: 5, data: { number: 1 } },
      "closed:1",
    );
    expect(prs.pruneStale(repoId, "feat")).toBe(0);
    expect(prs.get(closed.id)).not.toBeNull();
    expect(stages.forTicket("T-1").map((e) => e.kind)).toEqual(["closed"]);
  });

  it("deleting the ticket repo sets repo_id to null", () => {
    const { db, prs, repoId } = setup();
    db.exec("PRAGMA foreign_keys = ON");
    const p = prs.link(link({ repoId })).pr;
    db.prepare(`DELETE FROM ticket_repos WHERE id = ?`).run(repoId);
    expect(prs.get(p.id)?.repoId).toBeNull();
  });
});
