import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { syncDiscovered } from "../sessions/discovery";
import { insertTicket, type LegacyTicket, memDb } from "../test-utils";
import { migrate, NewerDatabaseError } from "./database";
import { MIGRATIONS } from "./migrations";
import { SessionsRepo } from "./sessions-repo";
import { SettingsRepo } from "./settings-repo";
import { TicketsRepo } from "./tickets-repo";

const ticket = (key: string, over: Partial<LegacyTicket> = {}): LegacyTicket => ({
  key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: `feature/${key}`,
  status: "active", statusManual: null, createdAt: 1, archivedAt: null, ...over,
});

describe("migrate", () => {
  it("is idempotent", () => {
    const db = memDb();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(MIGRATIONS.length);
  });
});

describe("TicketsRepo", () => {
  it("inserts, reads, lists without archived, sets manual status", () => {
    const repo = new TicketsRepo(memDb());
    repo.insert(ticket("PROJ-1", { title: "登录页" }));
    repo.insert(ticket("PROJ-2"));
    expect(repo.get("PROJ-1")?.title).toBe("登录页");
    expect(repo.get("NOPE-1")).toBeNull();
    repo.archive("PROJ-2", 5);
    expect(repo.list().map((t) => t.key)).toEqual(["PROJ-1"]);
    expect(repo.list({ includeArchived: true })).toHaveLength(2);
    repo.setStatusManual("PROJ-1", "blocked");
    expect(repo.get("PROJ-1")?.statusManual).toBe("blocked");
    repo.setStatusManual("PROJ-1", null);
    expect(repo.get("PROJ-1")?.statusManual).toBeNull();
  });
});

describe("SessionsRepo", () => {
  const setup = () => {
    const db = memDb();
    insertTicket(new TicketsRepo(db), ticket("PROJ-1"));
    return new SessionsRepo(db);
  };

  it("recordHeadless hides Butler's own headless sessions from unclaimed, even after a disk scan", () => {
    const repo = setup();
    repo.recordHeadless("h1", "/w", 100);
    expect(repo.get("h1")).toMatchObject({ dismissed: true, ticketKey: null });
    syncDiscovered([{ id: "h1", cwd: "/w", gitBranch: "main", firstPrompt: "x", lastActivityAt: 100 }], repo, 100);
    expect(repo.listUnclaimed(0)).toEqual([]);
  });

  it("recordHeadless never dismisses a pre-existing session", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "real", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 1 });
    repo.recordHeadless("real", "/w", 100);
    expect(repo.get("real")).toMatchObject({ dismissed: false, ticketKey: "PROJ-1", cwd: "/x" });
  });

  it("insertIfAbsent only inserts once", () => {
    const repo = setup();
    expect(repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/x", origin: "discovered", createdAt: 1 })).toBe(true);
    expect(repo.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/y", origin: "butler", createdAt: 2 })).toBe(false);
    expect(repo.get("a")).toMatchObject({ ticketKey: null, cwd: "/x", origin: "discovered", waitingForInput: false, dismissed: false });
  });

  it("fillDetails keeps existing values and only moves lastActivityAt forward", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "", origin: "discovered", gitBranch: "main", lastActivityAt: 10, createdAt: 1 });
    repo.fillDetails("a", { cwd: "/x", gitBranch: "other", firstPrompt: "hi", lastActivityAt: 5 });
    expect(repo.get("a")).toMatchObject({ cwd: "/x", gitBranch: "main", firstPrompt: "hi", lastActivityAt: 10 });
    repo.fillDetails("a", { lastActivityAt: 20 });
    expect(repo.get("a")?.lastActivityAt).toBe(20);
    repo.fillDetails("a", { lastActivityAt: null });
    expect(repo.get("a")?.lastActivityAt).toBe(20);
  });

  it("head follows replacedBy and survives cycles", () => {
    const repo = setup();
    for (const id of ["a", "b", "c"]) repo.insertIfAbsent({ id, ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 1 });
    repo.setReplacedBy("a", "b");
    repo.setReplacedBy("b", "c");
    expect(repo.head("a")?.id).toBe("c");
    expect(repo.head("missing")).toBeNull();
    repo.setReplacedBy("c", "a");
    expect(repo.head("a")).not.toBeNull();
  });

  it("setOrigin and delete (clearing pointers to the deleted row)", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/x", origin: "discovered", createdAt: 1 });
    repo.insertIfAbsent({ id: "b", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 2 });
    repo.setOrigin("a", "butler");
    expect(repo.get("a")?.origin).toBe("butler");
    repo.setReplacedBy("a", "b");
    repo.delete("b");
    expect(repo.get("b")).toBeNull();
    expect(repo.get("a")?.replacedBy).toBeNull();
  });

  it("deleting the tail of a chain keeps the head pointing at the middle row", () => {
    const repo = setup();
    for (const id of ["a", "b", "c"]) repo.insertIfAbsent({ id, ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 1 });
    repo.setReplacedBy("a", "b");
    repo.setReplacedBy("b", "c");
    repo.delete("c");
    expect(repo.head("a")?.id).toBe("b");
    expect(repo.get("b")?.replacedBy).toBeNull();
  });

  it("remembers deleted ids until they are inserted again", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/x", origin: "butler", createdAt: 1 });
    repo.delete("a");
    expect(repo.wasForgotten("a")).toBe(true);
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/x", origin: "butler", createdAt: 2 });
    expect(repo.wasForgotten("a")).toBe(false);
  });

  it("listUnclaimed excludes claimed, dismissed, replaced and old sessions", () => {
    const repo = setup();
    const add = (id: string, at: number, ticketKey: string | null = null) =>
      repo.insertIfAbsent({ id, ticketKey, cwd: "/x", origin: "discovered", lastActivityAt: at, createdAt: at });
    add("fresh", 100);
    add("old", 1);
    add("claimed", 100, "PROJ-1");
    add("dismissed", 100);
    repo.dismiss("dismissed");
    add("replaced", 100);
    repo.setReplacedBy("replaced", "fresh");
    expect(repo.listUnclaimed(50).map((s) => s.id)).toEqual(["fresh"]);
  });

  it("setWaiting sets the flag and bumps activity; listByTicket orders by recency", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", lastActivityAt: 1, createdAt: 1 });
    repo.insertIfAbsent({ id: "b", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", lastActivityAt: 2, createdAt: 1 });
    repo.setWaiting("a", true, 9);
    expect(repo.get("a")).toMatchObject({ waitingForInput: true, lastActivityAt: 9 });
    expect(repo.listByTicket("PROJ-1").map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("SettingsRepo", () => {
  it("returns defaults and stores overrides", () => {
    const repo = new SettingsRepo(memDb());
    expect(repo.get("branchTemplate")).toBe("feature/{key}");
    repo.set("branchTemplate", "yc/{key}");
    expect(repo.get("branchTemplate")).toBe("yc/{key}");
  });
});

describe("migration 5 (several repos per ticket)", () => {
  it("moves each ticket's repo into ticket_repos and files its sessions under it", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (const m of MIGRATIONS.slice(0, 4)) db.exec(m);
    db.exec("PRAGMA user_version = 4");
    db.exec(`INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, created_at)
             VALUES ('OLD-1', 't', '/code/web', 'worktree', '/code/web-worktrees/OLD-1', 'feature/OLD-1', 5)`);
    db.exec(`INSERT INTO sessions (id, ticket_key, cwd, origin, created_at) VALUES ('s1', 'OLD-1', '/code/web-worktrees/OLD-1', 'butler', 6)`);
    db.exec(`INSERT INTO sessions (id, ticket_key, cwd, origin, created_at) VALUES ('s2', NULL, '/elsewhere', 'discovered', 6)`);
    expect(migrate(db)).toBe(MIGRATIONS.length);

    const tickets = new TicketsRepo(db);
    const [repo] = tickets.get("OLD-1")!.repos;
    expect(repo).toMatchObject({ ticketKey: "OLD-1", repoPath: "/code/web", workMode: "worktree", worktreePath: "/code/web-worktrees/OLD-1", branch: "feature/OLD-1", createdAt: 5 });
    const sessions = new SessionsRepo(db);
    expect(sessions.get("s1")).toMatchObject({ repoId: repo.id, coordinator: false, spawnedBy: null });
    expect(sessions.get("s2")?.repoId).toBeNull();
    db.close();
  });
});

describe("TicketsRepo repos and session placement", () => {
  it("adds, updates and removes repos; removing one keeps its sessions without a repo", () => {
    const db = memDb();
    const tickets = new TicketsRepo(db);
    const sessions = new SessionsRepo(db);
    const id = tickets.insert({ key: "M-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null }, {
      ticketKey: "M-1", repoPath: "/web", workMode: "branch", worktreePath: null, branch: "b", createdAt: 1,
    })!;
    const api = tickets.addRepo({ ticketKey: "M-1", repoPath: "/api", workMode: "worktree", worktreePath: "/api-wt/M-1", branch: "b", createdAt: 2 });
    expect(tickets.get("M-1")!.repos.map((r) => r.repoPath)).toEqual(["/web", "/api"]);
    expect(() => tickets.addRepo({ ticketKey: "M-1", repoPath: "/api", workMode: "branch", worktreePath: null, branch: "b", createdAt: 3 })).toThrow();
    tickets.updateRepo({ id, workMode: "worktree", worktreePath: "/web-wt/M-1", branch: "c" });
    expect(tickets.getRepo(id)).toMatchObject({ workMode: "worktree", worktreePath: "/web-wt/M-1", branch: "c" });

    sessions.insertIfAbsent({ id: "s", ticketKey: "M-1", cwd: "/api-wt/M-1", origin: "butler", createdAt: 1, repoId: api });
    tickets.removeRepo(api);
    expect(tickets.get("M-1")!.repos.map((r) => r.id)).toEqual([id]);
    expect(sessions.get("s")).toMatchObject({ ticketKey: "M-1", repoId: null });
  });

  it("a /clear successor keeps its predecessor's repo, coordinator role and spawner", () => {
    const db = memDb();
    const tickets = new TicketsRepo(db);
    const sessions = new SessionsRepo(db);
    const repoId = tickets.insert({ key: "M-2", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null }, {
      ticketKey: "M-2", repoPath: "/web", workMode: "branch", worktreePath: null, branch: "b", createdAt: 1,
    })!;
    sessions.insertIfAbsent({ id: "a", ticketKey: "M-2", cwd: "/web", origin: "butler", createdAt: 1, repoId, spawnedBy: "boss" });
    sessions.insertIfAbsent({ id: "b", ticketKey: "M-2", cwd: "/web", origin: "butler", createdAt: 2 });
    sessions.setReplacedBy("a", "b");
    expect(sessions.get("b")).toMatchObject({ repoId, coordinator: false, spawnedBy: "boss" });
    sessions.insertIfAbsent({ id: "c", ticketKey: "M-2", cwd: "/ws", origin: "butler", createdAt: 1, coordinator: true });
    sessions.insertIfAbsent({ id: "d", ticketKey: "M-2", cwd: "/ws", origin: "butler", createdAt: 2 });
    sessions.setReplacedBy("c", "d");
    expect(sessions.get("d")).toMatchObject({ coordinator: true, repoId: null });
  });
});

describe("opening data from a newer Butler", () => {
  it("refuses a database whose version is newer than this build knows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(NewerDatabaseError);
    expect(() => migrate(db)).toThrow(/更新版本的 Butler/);
    db.close();
  });
});
