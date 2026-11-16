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
