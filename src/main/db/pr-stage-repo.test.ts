import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import type { Db } from "./database";
import { PrStageRepo, type StageEvent } from "./pr-stage-repo";
import { TicketsRepo } from "./tickets-repo";

/** 建 ticket 和仓库，返回 repoId（pr_stage_events 外键指向 ticket_repos）。 */
function addRepo(db: Db, key: string): number {
  const tickets = new TicketsRepo(db);
  tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  return tickets.addRepo({ ticketKey: key, repoPath: "/r", workMode: "branch", worktreePath: null, branch: `b-${key}`, createdAt: 1 });
}

const ev = (o: Partial<Omit<StageEvent, "id">> = {}): Omit<StageEvent, "id"> => ({
  ticketKey: "T-1", repoId: null, branch: null, featureId: null, epicId: null, sessionId: null, kind: "skill", at: 1, data: {}, ...o,
});

describe("PrStageRepo", () => {
  it("add ignores a duplicate dedupeKey", () => {
    const db = memDb();
    const id = addRepo(db, "T-1");
    const repo = new PrStageRepo(db);
    expect(repo.add(ev({ repoId: id, branch: "feat", kind: "push", data: { sha: "a" } }), "k1")).toBe(true);
    expect(repo.add(ev({ repoId: id, branch: "feat", kind: "push", data: { sha: "a" } }), "k1")).toBe(false);
    expect(repo.has("k1")).toBe(true);
    expect(repo.has("nope")).toBe(false);
    expect(repo.forRepo("T-1", id, "feat")).toHaveLength(1);
  });

  it("forRepo filters by ticket, repo and branch", () => {
    const db = memDb();
    const id = addRepo(db, "T-1");
    addRepo(db, "T-2");
    const other = new TicketsRepo(db).addRepo({ ticketKey: "T-1", repoPath: "/r2", workMode: "branch", worktreePath: null, branch: "b2", createdAt: 1 });
    const repo = new PrStageRepo(db);
    repo.add(ev({ repoId: id, branch: "feat", kind: "ci", at: 3, data: { result: "passing", sha: "a" } }), "ci");
    repo.add(ev({ repoId: null, kind: "skill", at: 2, data: { name: "x", category: "design" } }), "sk");
    repo.add(ev({ repoId: id, branch: "old", kind: "push", at: 1 }), "old");
    repo.add(ev({ ticketKey: "T-2", repoId: null, at: 1 }), "other");
    repo.add(ev({ repoId: other, branch: "feat", kind: "push", at: 1 }), "other-repo");
    const got = repo.forRepo("T-1", id, "feat");
    expect(got.map((e) => e.kind)).toEqual(["skill", "ci"]);
    expect(got[1]).toMatchObject({ repoId: id, branch: "feat", data: { result: "passing", sha: "a" } });
  });

  it("upperDesign returns feature and epic skill events only", () => {
    const repo = new PrStageRepo(memDb());
    repo.add(ev({ ticketKey: null, featureId: 3, at: 2, data: { name: "a", category: "design" } }), "f");
    repo.add(ev({ ticketKey: null, epicId: 9, at: 1, data: { name: "b", category: "design" } }), "e9");
    repo.add(ev({ ticketKey: null, epicId: 8, at: 1, data: { name: "c", category: "design" } }), "e8");
    repo.add(ev({ ticketKey: null, featureId: 3, at: 3, data: { name: "r", category: "review" } }), "rev");
    repo.add(ev({ ticketKey: null, featureId: 3, kind: "push", at: 3, data: { category: "design" } }), "nonskill");
    repo.add(ev({ ticketKey: "T-1", featureId: 3, at: 3, data: { name: "t", category: "design" } }), "ticketlvl");
    expect(repo.upperDesign(3, 9).map((e) => e.data.name)).toEqual(["b", "a"]);
    expect(repo.upperDesign(3, null).map((e) => e.data.name)).toEqual(["a"]);
  });
});
