import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { memDb } from "../test-utils";
import type { Db } from "./database";
import { MIGRATIONS } from "./migrations";
import { migrate } from "./database";
import { TicketPrsRepo } from "./ticket-prs-repo";
import { PrStageRepo, type StageEvent } from "./pr-stage-repo";
import { TicketsRepo } from "./tickets-repo";

/** 建 ticket 和仓库，返回 repoId（pr_stage_events 外键指向 ticket_repos）。 */
function addRepo(db: Db, key: string): number {
  const tickets = new TicketsRepo(db);
  tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  return tickets.addRepo({ ticketKey: key, repoPath: "/r", workMode: "branch", worktreePath: null, branch: `b-${key}`, createdAt: 1 });
}

const ev = (o: Partial<Omit<StageEvent, "id">> = {}): Omit<StageEvent, "id"> => ({
  ticketKey: "T-1", repoId: null, prId: null, branch: null, featureId: null, sessionId: null, kind: "skill", at: 1, data: {}, ...o,
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
    expect(repo.forTicket("T-1")).toHaveLength(1);
  });

  it("ticketsWith lists the tickets that have an event of that kind", () => {
    const db = memDb();
    const a = addRepo(db, "T-1");
    const b = addRepo(db, "T-2");
    const repo = new PrStageRepo(db);
    repo.add(ev({ repoId: a, kind: "first_commit" }), "f1");
    repo.add(ev({ ticketKey: "T-2", repoId: b, kind: "push" }), "p2");
    expect([...repo.ticketsWith("first_commit")]).toEqual(["T-1"]);
  });

  it("upperDesign returns the feature's design skill events only", () => {
    const repo = new PrStageRepo(memDb());
    repo.add(ev({ ticketKey: null, featureId: 3, at: 2, data: { name: "a", category: "design" } }), "f");
    repo.add(ev({ ticketKey: null, featureId: 4, at: 1, data: { name: "b", category: "design" } }), "f4");
    repo.add(ev({ ticketKey: null, featureId: 3, at: 3, data: { name: "r", category: "review" } }), "rev");
    repo.add(ev({ ticketKey: null, featureId: 3, kind: "push", at: 3, data: { category: "design" } }), "nonskill");
    repo.add(ev({ ticketKey: "T-1", featureId: 3, at: 3, data: { name: "t", category: "design" } }), "ticketlvl");
    expect(repo.upperDesign(3).map((e) => e.data.name)).toEqual(["a"]);
    expect(repo.upperDesign(4).map((e) => e.data.name)).toEqual(["b"]);
  });

  const mkPr = (db: Db, n: number): number =>
    new TicketPrsRepo(db).link({
      ticketKey: "T-1", url: `https://github.com/a/b/pull/${n}`, slug: "a/b", repoId: null, number: n, headBranch: null, state: "open",
      source: "branch", linkedAt: 1,
    }).pr.id;

  it("add stores pr_id and forTicket returns it", () => {
    const db = memDb();
    addRepo(db, "T-1");
    const pr = mkPr(db, 1);
    const repo = new PrStageRepo(db);
    repo.add(ev({ prId: pr, kind: "push", at: 2, data: { sha: "a" } }), "p");
    repo.add(ev({ at: 1 }), "s");
    repo.add(ev({ ticketKey: "T-2", at: 1 }), "other");
    expect(repo.forTicket("T-1").map((e) => [e.kind, e.prId])).toEqual([["skill", null], ["push", pr]]);
  });

  it("lastCi returns the newest ci event of that PR only", () => {
    const db = memDb();
    addRepo(db, "T-1");
    const a = mkPr(db, 1);
    const b = mkPr(db, 2);
    const repo = new PrStageRepo(db);
    repo.add(ev({ prId: a, kind: "ci", at: 1, data: { result: "failing", sha: "s1" } }), "1");
    repo.add(ev({ prId: a, kind: "ci", at: 2, data: { result: "passing", sha: "s2" } }), "2");
    repo.add(ev({ prId: b, kind: "ci", at: 3, data: { result: "pending", sha: "s3" } }), "3");
    expect(repo.lastCi(a)).toEqual({ sha: "s2", result: "passing" });
    expect(repo.lastCi(b)).toEqual({ sha: "s3", result: "pending" });
    expect(repo.lastCi(999)).toBeNull();
  });

  it("firstSkillAt is the earliest skill event", () => {
    const db = memDb();
    addRepo(db, "T-1");
    const repo = new PrStageRepo(db);
    expect(repo.firstSkillAt()).toBeNull();
    repo.add(ev({ at: 9 }), "a");
    repo.add(ev({ at: 4 }), "b");
    repo.add(ev({ kind: "push", at: 1 }), "c");
    expect(repo.firstSkillAt()).toBe(4);
  });

  it("deleting a ticket_prs row cascades to its events", () => {
    const db = memDb();
    addRepo(db, "T-1");
    const pr = mkPr(db, 1);
    const repo = new PrStageRepo(db);
    repo.add(ev({ prId: pr, kind: "push" }), "p");
    db.prepare(`DELETE FROM ticket_prs WHERE id = ?`).run(pr);
    expect(repo.has("p")).toBe(false);
  });

  it("migrate() from user_version 21 adds the tables and pr_id", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const sql of MIGRATIONS.slice(0, 21)) db.exec(sql);
    db.exec("PRAGMA user_version = 21");
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("pr_stage_events")).toContain("pr_id");
    expect(cols("ticket_prs")).toContain("merged_handled_at");
    expect(cols("branch_watch")).toContain("delivered_key");
  });
});
