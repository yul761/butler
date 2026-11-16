import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import type { Db } from "./database";
import { TicketPrsRepo, type NewPrLink } from "./ticket-prs-repo";
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

  it("pendingMerged, setMergedHandled, setDelivered and update round-trip", () => {
    const { prs } = setup();
    const p = prs.link(link({ state: "merged" })).pr;
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

  it("deleting the ticket repo sets repo_id to null", () => {
    const { db, prs, repoId } = setup();
    db.exec("PRAGMA foreign_keys = ON");
    const p = prs.link(link({ repoId })).pr;
    db.prepare(`DELETE FROM ticket_repos WHERE id = ?`).run(repoId);
    expect(prs.get(p.id)?.repoId).toBeNull();
  });
});
