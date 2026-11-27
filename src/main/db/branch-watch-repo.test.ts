import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { BranchWatchRepo, type BranchWatchRow } from "./branch-watch-repo";
import { TicketsRepo } from "./tickets-repo";

describe("BranchWatchRepo", () => {
  it("upsert with a new branch clears delivered_key; the same branch keeps it", () => {
    const db = memDb();
    const tickets = new TicketsRepo(db);
    tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
    const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "a", createdAt: 1 });
    const repo = new BranchWatchRepo(db);
    const row: Omit<BranchWatchRow, "deliveredKey"> = {
      repoId, ticketKey: "T-1", branch: "a", ci: "failing", headSha: "s1", failed: [], readError: false, checkedAt: 5,
    };
    repo.upsert(row);
    repo.setDelivered(repoId, "s1:failing");
    repo.upsert({ ...row, checkedAt: 6 });
    expect(repo.get(repoId)).toMatchObject({ deliveredKey: "s1:failing", checkedAt: 6 });
    repo.upsert({ ...row, branch: "b" });
    expect(repo.get(repoId)).toMatchObject({ branch: "b", deliveredKey: null });
    expect(repo.all()).toHaveLength(1);
  });
});

describe("BranchWatchRepo.byTickets (BTL-275)", () => {
  it("is byTicket() for several tickets in one query", () => {
    const db = memDb();
    const tickets = new TicketsRepo(db);
    for (const key of ["T-1", "T-2"]) tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
    const add = (ticketKey: string, path: string) => tickets.addRepo({ ticketKey, repoPath: path, workMode: "branch", worktreePath: null, branch: "a", createdAt: 1 });
    const [r1, r2, r3] = [add("T-1", "/r1"), add("T-1", "/r2"), add("T-2", "/r3")];
    const repo = new BranchWatchRepo(db);
    for (const [repoId, ticketKey] of [[r2, "T-1"], [r1, "T-1"], [r3, "T-2"]] as const)
      repo.upsert({ repoId, ticketKey, branch: "a", ci: "passing", headSha: "s", failed: [], readError: false, checkedAt: 1 });
    const many = repo.byTickets(["T-1", "T-2", "T-9"]);
    expect(many.get("T-1")).toEqual(repo.byTicket("T-1"));
    expect(many.get("T-1")!.map((b) => b.repoId)).toEqual([r1, r2]);
    expect(many.get("T-2")).toEqual(repo.byTicket("T-2"));
    expect(many.get("T-9")).toBeUndefined();
    expect(repo.byTickets([]).size).toBe(0);
  });
});
