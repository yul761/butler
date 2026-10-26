import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { insertTicket, memDb } from "../test-utils";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";
import { FeaturesRepo } from "./features-repo";
import { SessionsRepo } from "./sessions-repo";
import { TicketsRepo } from "./tickets-repo";

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("migration 6", () => {
  it("adds features, feature_repos and the new columns", () => {
    const db = memDb();
    expect(columns(db, "features")).toEqual(["id", "name", "workspace_dir", "created_at", "archived_at"]);
    expect(columns(db, "feature_repos")).toEqual(["id", "feature_id", "repo_path", "created_at"]);
    expect(columns(db, "tickets")).toContain("feature_id");
    expect(columns(db, "sessions")).toContain("feature_id");
    expect(columns(db, "ticket_repos")).toEqual(expect.arrayContaining(["worktree_removed_at", "cleanup_blocked"]));
  });

  it("leaves tickets from version 5 outside any feature", () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS.slice(0, 5)) db.exec(sql);
    db.exec("PRAGMA user_version = 5");
    db.prepare(
      `INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, created_at) VALUES ('OLD-1', NULL, '', 'branch', NULL, '', 'active', 1)`,
    ).run();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(new TicketsRepo(db).get("OLD-1")?.featureId).toBeNull();
  });
});

describe("FeaturesRepo", () => {
  it("inserts, lists without archived, finds by workspace", () => {
    const repo = new FeaturesRepo(memDb());
    const a = repo.insert({ name: "结账改版", workspaceDir: "/c/shop-features/a", createdAt: 1 });
    const b = repo.insert({ name: "b", workspaceDir: "/c/shop-features/b", createdAt: 2 });
    expect(repo.get(a)?.name).toBe("结账改版");
    expect(repo.byWorkspace("/c/shop-features/b/")?.id).toBe(b);
    repo.archive(b, 9);
    expect(repo.list().map((f) => f.id)).toEqual([a]);
    expect(repo.listArchived().map((f) => f.id)).toEqual([b]);
    expect(repo.byWorkspace("/c/shop-features/b")).toBeNull();
    repo.unarchive(b);
    expect(repo.get(b)?.archivedAt).toBeNull();
    repo.setName(a, "新名字");
    expect(repo.get(a)?.name).toBe("新名字");
  });

  it("keeps repos in order and refuses the same repo twice", () => {
    const repo = new FeaturesRepo(memDb());
    const f = repo.insert({ name: "f", workspaceDir: "/w", createdAt: 1 });
    const r1 = repo.addRepo(f, "/c/shop/frontend", 1);
    repo.addRepo(f, "/c/shop/backend", 2);
    expect(repo.get(f)?.repos.map((r) => r.repoPath)).toEqual(["/c/shop/frontend", "/c/shop/backend"]);
    expect(() => repo.addRepo(f, "/c/shop/frontend", 3)).toThrow();
    repo.removeRepo(r1);
    expect(repo.get(f)?.repos.map((r) => r.repoPath)).toEqual(["/c/shop/backend"]);
  });
});

describe("tickets and sessions in a feature", () => {
  it("lists a feature's tickets", () => {
    const db = memDb();
    const features = new FeaturesRepo(db);
    const tickets = new TicketsRepo(db);
    const f = features.insert({ name: "f", workspaceDir: "/w", createdAt: 1 });
    tickets.insert({ key: "DMS-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null, featureId: f });
    tickets.insert({ key: "DMS-2", title: null, status: "active", statusManual: null, createdAt: 2, archivedAt: 5, featureId: f });
    tickets.insert({ key: "OTHER-1", title: null, status: "active", statusManual: null, createdAt: 3, archivedAt: null, featureId: null });
    expect(tickets.listByFeature(f).map((t) => t.key)).toEqual(["DMS-1"]);
    expect(tickets.listByFeature(f, { includeArchived: true }).map((t) => t.key).sort()).toEqual(["DMS-1", "DMS-2"]);
    expect(tickets.get("DMS-1")?.featureId).toBe(f);
  });

  it("marks a worktree removed and clears it when the repo changes", () => {
    const tickets = new TicketsRepo(memDb());
    insertTicket(tickets, {
      key: "DMS-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null, featureId: null,
      repoPath: "/r", workMode: "worktree", worktreePath: "/w/r-dms-1", branch: "b",
    });
    const id = tickets.listRepos("DMS-1")[0].id;
    expect(tickets.getRepo(id)).toMatchObject({ worktreeRemovedAt: null, cleanupBlocked: null });
    tickets.markWorktreeRemoved(id, 5);
    tickets.setCleanupBlocked(id, "有改动");
    expect(tickets.getRepo(id)).toMatchObject({ worktreeRemovedAt: 5, cleanupBlocked: "有改动" });
    tickets.updateRepo({ id, workMode: "worktree", worktreePath: "/w/r-dms-1", branch: "b2" });
    expect(tickets.getRepo(id)?.worktreeRemovedAt).toBeNull();
  });

  it("keeps feature sessions out of unclaimed and follows them across /clear", () => {
    const db = memDb();
    const f = new FeaturesRepo(db).insert({ name: "f", workspaceDir: "/w", createdAt: 1 });
    const sessions = new SessionsRepo(db);
    sessions.insertIfAbsent({ id: "s1", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 10, lastActivityAt: 10, featureId: f, coordinator: true });
    sessions.insertIfAbsent({ id: "s2", ticketKey: null, cwd: "/x", origin: "discovered", createdAt: 10, lastActivityAt: 10 });
    expect(sessions.listUnclaimed(0).map((s) => s.id)).toEqual(["s2"]);
    expect(sessions.listByFeature(f).map((s) => s.id)).toEqual(["s1"]);

    sessions.insertIfAbsent({ id: "s3", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 11 });
    sessions.setReplacedBy("s1", "s3");
    expect(sessions.get("s3")).toMatchObject({ featureId: f, coordinator: true });

    sessions.setFeature("s2", f);
    expect(sessions.get("s2")?.featureId).toBe(f);
  });
});
