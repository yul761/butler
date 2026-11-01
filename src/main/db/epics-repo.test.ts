import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { migrate } from "./database";
import { EpicsRepo } from "./epics-repo";
import { FeaturesRepo } from "./features-repo";
import { MIGRATIONS } from "./migrations";
import { SessionsRepo } from "./sessions-repo";

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("migration 10", () => {
  it("adds epics, epic_repos and the new columns", () => {
    const db = memDb();
    expect(columns(db, "epics")).toEqual(["id", "name", "workspace_dir", "created_at", "archived_at"]);
    expect(columns(db, "epic_repos")).toEqual(["id", "epic_id", "repo_path", "created_at"]);
    expect(columns(db, "features")).toEqual(expect.arrayContaining(["epic_id", "brief", "brief_sent_at"]));
    expect(columns(db, "sessions")).toContain("epic_id");
  });

  it("leaves old features and sessions with null in every new column", () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS.slice(0, 9)) db.exec(sql);
    db.exec("PRAGMA user_version = 9");
    db.prepare(`INSERT INTO features (name, workspace_dir, created_at) VALUES ('old', '/w', 1)`).run();
    db.prepare(`INSERT INTO sessions (id, ticket_key, cwd, origin, created_at) VALUES ('s1', NULL, '/w', 'butler', 1)`).run();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(new FeaturesRepo(db).get(1)).toMatchObject({ epicId: null, brief: null, briefSentAt: null });
    expect(new SessionsRepo(db).get("s1")?.epicId).toBeNull();
  });
});

describe("EpicsRepo", () => {
  it("inserts, lists without archived, finds by workspace", () => {
    const repo = new EpicsRepo(memDb());
    const a = repo.insert({ name: "支付", workspaceDir: "/c/shop-epics/a", createdAt: 1 });
    const b = repo.insert({ name: "b", workspaceDir: "/c/shop-epics/b", createdAt: 2 });
    expect(repo.get(a)).toMatchObject({ name: "支付", archivedAt: null, repos: [] });
    expect(repo.byWorkspace("/c/shop-epics/b/")?.id).toBe(b);
    repo.archive(b, 9);
    expect(repo.list().map((e) => e.id)).toEqual([a]);
    expect(repo.list({ includeArchived: true }).map((e) => e.id).sort()).toEqual([a, b]);
    expect(repo.listArchived().map((e) => e.id)).toEqual([b]);
    expect(repo.byWorkspace("/c/shop-epics/b")).toBeNull();
    repo.unarchive(b);
    expect(repo.get(b)?.archivedAt).toBeNull();
    repo.setName(a, "新名字");
    expect(repo.get(a)?.name).toBe("新名字");
  });

  it("keeps repos in order and refuses the same repo twice", () => {
    const repo = new EpicsRepo(memDb());
    const e = repo.insert({ name: "e", workspaceDir: "/w", createdAt: 1 });
    const r1 = repo.addRepo(e, "/c/shop/frontend", 1);
    repo.addRepo(e, "/c/shop/backend", 2);
    expect(repo.get(e)?.repos.map((r) => r.repoPath)).toEqual(["/c/shop/frontend", "/c/shop/backend"]);
    expect(repo.getRepo(r1)).toEqual({ id: r1, epicId: e, repoPath: "/c/shop/frontend" });
    expect(() => repo.addRepo(e, "/c/shop/frontend", 3)).toThrow();
    repo.removeRepo(r1);
    expect(repo.get(e)?.repos.map((r) => r.repoPath)).toEqual(["/c/shop/backend"]);
  });

  it("lists an epic's features and its epic sessions", () => {
    const db = memDb();
    const epics = new EpicsRepo(db);
    const features = new FeaturesRepo(db);
    const sessions = new SessionsRepo(db);
    const e = epics.insert({ name: "e", workspaceDir: "/e", createdAt: 1 });
    const f1 = features.insert({ name: "f1", workspaceDir: "/f1", createdAt: 1, epicId: e, brief: "做 X" });
    const f2 = features.insert({ name: "f2", workspaceDir: "/f2", createdAt: 2, epicId: e });
    features.insert({ name: "f3", workspaceDir: "/f3", createdAt: 3 });
    features.archive(f2, 5);
    expect(features.listByEpic(e).map((f) => f.id)).toEqual([f1]);
    expect(features.listByEpic(e, { includeArchived: true }).map((f) => f.id)).toEqual([f2, f1]);
    expect(features.get(f1)).toMatchObject({ epicId: e, brief: "做 X", briefSentAt: null });
    features.setBriefSentAt(f1, 7);
    expect(features.get(f1)?.briefSentAt).toBe(7);
    sessions.insertIfAbsent({ id: "es", ticketKey: null, cwd: "/e", origin: "butler", createdAt: 1, epicId: e });
    expect(sessions.listByEpic(e).map((s) => s.id)).toEqual(["es"]);
    expect(sessions.get("es")?.epicId).toBe(e);
  });
});

describe("epic sessions", () => {
  const epicDb = () => {
    const db = memDb();
    const epicId = new EpicsRepo(db).insert({ name: "e", workspaceDir: "/e", createdAt: 1 });
    const featureId = new FeaturesRepo(db).insert({ name: "f", workspaceDir: "/f", createdAt: 1 });
    return { repo: new SessionsRepo(db), epicId, featureId };
  };

  it("carries epicId to the session that replaces it after /clear", () => {
    const { repo, epicId } = epicDb();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/e", origin: "butler", createdAt: 1, epicId });
    repo.insertIfAbsent({ id: "a-2", ticketKey: null, cwd: "/e", origin: "butler", createdAt: 2 });
    repo.setReplacedBy("a", "a-2");
    expect(repo.head("a")).toMatchObject({ id: "a-2", epicId });
  });

  it("leaves an existing session its own epic when /resume picks it", () => {
    const { repo, epicId } = epicDb();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/e", origin: "butler", createdAt: 1, epicId });
    repo.insertIfAbsent({ id: "loose", ticketKey: null, cwd: "/e", origin: "butler", createdAt: 2 });
    repo.setReplacedBy("a", "loose", "resume");
    expect(repo.get("loose")?.epicId).toBeNull();
  });

  it("clears the epic of a row that turned out not to be an epic session", () => {
    const { repo, epicId } = epicDb();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/e", origin: "butler", createdAt: 1, epicId });
    repo.setEpic("a", null);
    expect(repo.get("a")?.epicId).toBeNull();
    expect(repo.listByEpic(epicId)).toEqual([]);
  });

  it("makes an epic session's new head epic-only, whatever a disk scan recorded first", () => {
    const { repo, epicId, featureId } = epicDb();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/e", origin: "butler", createdAt: 1, epicId });
    repo.insertIfAbsent({ id: "a-2", ticketKey: null, cwd: "/f", origin: "discovered", createdAt: 2, featureId, coordinator: true });
    repo.setReplacedBy("a", "a-2");
    expect(repo.get("a-2")).toMatchObject({ epicId, featureId: null, coordinator: false });
    expect(repo.listFeatureCoordinators(featureId)).toEqual([]);
  });

  it("makes a feature coordinator's new head feature-only, whatever a disk scan recorded first", () => {
    const { repo, epicId, featureId } = epicDb();
    repo.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/f", origin: "butler", createdAt: 1, featureId, coordinator: true });
    repo.insertIfAbsent({ id: "c-2", ticketKey: null, cwd: "/e", origin: "discovered", createdAt: 2, epicId });
    repo.setReplacedBy("c", "c-2");
    expect(repo.get("c-2")).toMatchObject({ epicId: null, featureId, coordinator: true });
    expect(repo.listByEpic(epicId)).toEqual([]);
  });

  it("does not offer an epic session as unclaimed", () => {
    const { repo, epicId } = epicDb();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/e", origin: "butler", createdAt: 5, epicId });
    repo.insertIfAbsent({ id: "b", ticketKey: null, cwd: "/x", origin: "butler", createdAt: 5 });
    expect(repo.listUnclaimed(0).map((s) => s.id)).toEqual(["b"]);
  });
});
