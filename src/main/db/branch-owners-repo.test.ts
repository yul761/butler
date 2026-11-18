import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { BranchOwnersRepo } from "./branch-owners-repo";
import { TicketPrsRepo } from "./ticket-prs-repo";
import { TicketsRepo } from "./tickets-repo";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "main-work", createdAt: 1 });
  return { db, tickets, repoId, owners: new BranchOwnersRepo(db), prs: new TicketPrsRepo(db) };
}

describe("BranchOwnersRepo", () => {
  it("keeps the newest owner of a branch", () => {
    const s = setup();
    s.owners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/a", sessionId: "s1", dir: "/wt/a", at: 10 });
    s.owners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/b", sessionId: "s2", dir: "/wt/b", at: 11 });
    expect(s.owners.get("T-1", s.repoId, "feat/a")).toMatchObject({ sessionId: "s1", dir: "/wt/a", at: 10 });
    s.owners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/a", sessionId: "s3", dir: "/wt/a2", at: 12 });
    expect(s.owners.get("T-1", s.repoId, "feat/a")).toMatchObject({ sessionId: "s3", dir: "/wt/a2", at: 12 });
    expect(s.owners.get("T-1", s.repoId, "nope")).toBeNull();
    expect(s.owners.since(11).map((o) => o.branch).sort()).toEqual(["feat/a", "feat/b"]);
    expect(s.owners.since(12).map((o) => o.branch)).toEqual(["feat/a"]);
  });

  it("is removed with the ticket repo", () => {
    const s = setup();
    s.owners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/a", sessionId: "s1", dir: "/wt/a", at: 10 });
    s.db.prepare("DELETE FROM ticket_repos WHERE id = ?").run(s.repoId);
    expect(s.owners.since(0)).toEqual([]);
  });

  it("pruneStale keeps open PR rows on a branch a session owns", () => {
    const s = setup();
    const link = (n: number, branch: string) =>
      s.prs.link({ ticketKey: "T-1", url: `https://github.com/o/r/pull/${n}`, slug: "o/r", repoId: s.repoId, number: n, headBranch: branch, state: "open", source: "branch", linkedAt: 1 });
    link(1, "feat/owned");
    link(2, "feat/stale");
    s.owners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/owned", sessionId: "s1", dir: "/wt", at: 1 });
    expect(s.prs.pruneStale(s.repoId, "main-work")).toBe(1);
    expect(s.prs.byTicket("T-1").map((p) => p.number)).toEqual([1]);
  });
});
