import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { syncDiscovered } from "../sessions/discovery";
import { insertTicket, type LegacyTicket, memDb } from "../test-utils";
import { migrate, NewerDatabaseError } from "./database";
import { FeaturesRepo } from "./features-repo";
import { MergeGateRepo } from "./merge-gate-repo";
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

  it("stores the model of a new session", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/x", origin: "butler", createdAt: 1, model: "sonnet" });
    repo.insertIfAbsent({ id: "b", ticketKey: null, cwd: "/x", origin: "butler", createdAt: 1 });
    expect(repo.get("a")?.model).toBe("sonnet");
    expect(repo.get("b")?.model).toBeNull();
  });

  it("copies the model to the session that replaces it, without overwriting one the new row already has", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/x", origin: "butler", createdAt: 1, model: "opus" });
    repo.insertIfAbsent({ id: "b", ticketKey: null, cwd: "/x", origin: "butler", createdAt: 2 });
    repo.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/x", origin: "butler", createdAt: 3, model: "sonnet" });
    repo.setReplacedBy("a", "b", "clear");
    repo.setReplacedBy("b", "c", "clear");
    expect(repo.get("b")?.model).toBe("opus");
    expect(repo.get("c")?.model).toBe("sonnet");
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

describe("migration 7: language (design 2026-10-26 i18n)", () => {
  const upTo6 = () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS.slice(0, 6)) db.exec(sql);
    db.exec("PRAGMA user_version = 6");
    return db;
  };

  it("keeps Chinese for an install that already has tickets or finished the wizard", () => {
    const withTicket = upTo6();
    withTicket.prepare(`INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, created_at) VALUES ('A-1', NULL, '', 'branch', NULL, '', 'active', 1)`).run();
    migrate(withTicket);
    expect(new SettingsRepo(withTicket).get("language")).toBe("zh");

    const onboarded = upTo6();
    onboarded.prepare(`INSERT INTO settings (key, value) VALUES ('onboardingDone', '1')`).run();
    migrate(onboarded);
    expect(new SettingsRepo(onboarded).get("language")).toBe("zh");
  });

  it("leaves a fresh install on auto", () => {
    expect(new SettingsRepo(memDb()).get("language")).toBe("auto");
  });
});

describe("migration 9: fix sessions", () => {
  const upTo8 = () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS.slice(0, 8)) db.exec(sql);
    db.exec("PRAGMA user_version = 8");
    return db;
  };

  it("gives existing sessions no fixesSession", () => {
    const db = upTo8();
    db.prepare(`INSERT INTO sessions (id, ticket_key, cwd, origin, created_at) VALUES ('old', NULL, '/w', 'butler', 1)`).run();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(new SessionsRepo(db).get("old")?.fixesSession).toBeNull();
  });

  it("stores fixesSession on insert and defaults it to null", () => {
    const repo = new SessionsRepo(memDb());
    repo.insertIfAbsent({ id: "fix", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1, fixesSession: "stuck-1" });
    repo.insertIfAbsent({ id: "plain", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1 });
    expect(repo.get("fix")?.fixesSession).toBe("stuck-1");
    expect(repo.get("plain")?.fixesSession).toBeNull();
  });

  const featureDb = () => {
    const db = memDb();
    const featureId = new FeaturesRepo(db).insert({ name: "f", workspaceDir: "/ws", createdAt: 1 });
    return { repo: new SessionsRepo(db), featureId };
  };

  it("hands fixesSession on to the session that replaces a fix session, which stays a non-coordinator", () => {
    const { repo, featureId } = featureDb();
    repo.insertIfAbsent({ id: "fix", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, fixesSession: "stuck-1" });
    repo.insertIfAbsent({ id: "fix-2", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 2 });
    repo.setReplacedBy("fix", "fix-2");
    expect(repo.head("fix")).toMatchObject({ id: "fix-2", featureId, coordinator: false, fixesSession: "stuck-1" });
  });

  it("does not leave a coordinator mark on a fix session's new head that a disk scan recorded first", () => {
    const { repo, featureId } = featureDb();
    repo.insertIfAbsent({ id: "fix", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, fixesSession: "stuck-1" });
    syncDiscovered([{ id: "fix-2", cwd: "/ws", gitBranch: null, firstPrompt: null, lastActivityAt: 2 }], repo, 2, () => featureId);
    expect(repo.get("fix-2")).toMatchObject({ coordinator: true, fixesSession: null });
    repo.setReplacedBy("fix", "fix-2");
    expect(repo.get("fix-2")).toMatchObject({ coordinator: false, fixesSession: "stuck-1" });
  });

  it("leaves an existing session its own role when /resume picks it", () => {
    const { repo, featureId } = featureDb();
    repo.insertIfAbsent({ id: "fix", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, fixesSession: "stuck-1" });
    repo.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, coordinator: true });
    repo.setReplacedBy("fix", "c", "resume");
    expect(repo.get("fix")?.replacedBy).toBe("c");
    expect(repo.get("c")).toMatchObject({ coordinator: true, fixesSession: null, featureId });
  });

  it("does not hand a feature or a role to an existing session on /resume, but still its opener", () => {
    const { repo, featureId } = featureDb();
    repo.insertIfAbsent({ id: "fix", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, spawnedBy: "boss", fixesSession: "stuck-1" });
    repo.insertIfAbsent({ id: "loose", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 1 });
    repo.setReplacedBy("fix", "loose", "resume");
    expect(repo.get("loose")).toMatchObject({ coordinator: false, fixesSession: null, featureId: null, spawnedBy: "boss" });
  });

  it("still carries the coordinator mark across /clear for a real coordinator", () => {
    const { repo, featureId } = featureDb();
    repo.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, coordinator: true });
    repo.insertIfAbsent({ id: "c-2", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 2 });
    repo.setReplacedBy("c", "c-2");
    expect(repo.get("c-2")).toMatchObject({ coordinator: true, featureId, fixesSession: null });
  });

  it("lists a feature's fix sessions with its sessions, but not among its coordinators", () => {
    const { repo, featureId } = featureDb();
    repo.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, coordinator: true });
    repo.insertIfAbsent({ id: "fix", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 2, featureId, fixesSession: "stuck-1" });
    expect(repo.listByFeature(featureId).map((s) => s.id)).toEqual(["fix", "c"]);
    expect(repo.listFeatureCoordinators(featureId).map((s) => s.id)).toEqual(["c"]);
  });
});

describe("hidden-session cleanup (BTL-190 item 8)", () => {
  /** 升级之前（上一个版本）的数据库。 */
  const previous = () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS.slice(0, MIGRATIONS.length - 1)) db.exec(sql);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
    return db;
  };
  const add = (repo: SessionsRepo, id: string, o: { lastActivityAt?: number; createdAt?: number } = {}) =>
    repo.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "butler", createdAt: o.createdAt ?? 1, lastActivityAt: o.lastActivityAt ?? null });

  it("upgrades an existing database: sessions already hidden count from the upgrade, not from the epoch", () => {
    const db = previous();
    db.prepare(`INSERT INTO sessions (id, ticket_key, cwd, origin, created_at, dismissed) VALUES ('old-hidden', NULL, '/w', 'butler', 1, 1)`).run();
    db.prepare(`INSERT INTO sessions (id, ticket_key, cwd, origin, created_at, dismissed) VALUES ('old-shown', NULL, '/w', 'butler', 1, 0)`).run();
    const before = Date.now();
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const at = (id: string) => (db.prepare(`SELECT dismissed_at FROM sessions WHERE id = ?`).get(id) as { dismissed_at: number | null }).dismissed_at;
    // 秒级精度：不早于升级前的那一秒。
    expect(at("old-hidden")).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(at("old-hidden")).toBeLessThanOrEqual(Date.now());
    expect(at("old-shown")).toBeNull();
    const repo = new SessionsRepo(db);
    // 刚升级：不是删除的候选（14 天以前隐藏的才是）。
    expect(repo.listHiddenBefore(before - 1000).map((s) => s.id)).toEqual([]);
    expect(repo.listHiddenBefore(Date.now() + 1000).map((s) => s.id)).toEqual(["old-hidden"]);
    // 旧行照常读出来。
    expect(repo.get("old-hidden")).toMatchObject({ dismissed: true });
  });

  it("dismiss records when, keeps the first time on a repeat, and undismiss clears it", () => {
    const db = memDb();
    const repo = new SessionsRepo(db);
    add(repo, "s1");
    const at = () => (db.prepare(`SELECT dismissed_at FROM sessions WHERE id = 's1'`).get() as { dismissed_at: number | null }).dismissed_at;
    repo.dismiss("s1", 100);
    expect(at()).toBe(100);
    repo.dismiss("s1", 200);
    expect(at()).toBe(100);
    repo.undismiss("s1");
    expect(at()).toBeNull();
    repo.dismiss("s1", 300);
    expect(at()).toBe(300);
  });

  it("lists hidden heads hidden and last active before the cutoff", () => {
    const repo = new SessionsRepo(memDb());
    add(repo, "old", { lastActivityAt: 50 });
    repo.dismiss("old", 100);
    // 隐藏得早，但之后还有活动（比如在 Butler 外面 --resume 过）：不删。
    add(repo, "active-later", { lastActivityAt: 5_000 });
    repo.dismiss("active-later", 100);
    add(repo, "recent", { lastActivityAt: 50 });
    repo.dismiss("recent", 5_000);
    add(repo, "shown", { lastActivityAt: 50 });
    // 被 /clear 替换过的旧段不算（按 head 删整条链）。
    add(repo, "seg-a", { lastActivityAt: 50 });
    add(repo, "seg-b", { lastActivityAt: 60 });
    repo.setReplacedBy("seg-a", "seg-b", "clear");
    repo.dismiss("seg-a", 100);
    repo.dismiss("seg-b", 100);
    expect(repo.listHiddenBefore(1_000).map((s) => s.id)).toEqual(["old", "seg-b"]);
  });

  it("deletes a whole chain so an older segment does not come back, with its pending merge waiters", () => {
    const db = memDb();
    const repo = new SessionsRepo(db);
    const gate = new MergeGateRepo(db);
    for (const id of ["a", "b", "c", "other"]) add(repo, id);
    repo.setReplacedBy("a", "b", "clear");
    repo.setReplacedBy("b", "c", "clear");
    repo.dismiss("c", 1);
    const hold = gate.addHold({ repoPath: "/r", branch: "x", target: "main", kind: "pr", prUrl: null, sessionId: "z", ticketKey: null, createdAt: 1 });
    gate.addWaiter({ holdId: hold, sessionId: "a", ticketKey: null, branch: "a", createdAt: 1 });
    gate.addWaiter({ holdId: hold, sessionId: "c", ticketKey: null, branch: "c", createdAt: 1 });
    gate.addWaiter({ holdId: hold, sessionId: "other", ticketKey: null, branch: "o", createdAt: 1 });
    gate.addWaiter({ holdId: hold, sessionId: "b", ticketKey: null, branch: "b", createdAt: 1 });
    const notified = gate.waitersOf(hold).find((w) => w.sessionId === "b")!.id;
    gate.markNotified(notified, 2);

    expect(repo.chainOf("c").sort()).toEqual(["a", "b", "c"]);
    expect(repo.deleteChain("c").sort()).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      expect(repo.get(id)).toBeNull();
      expect(repo.wasForgotten(id)).toBe(true);
    }
    expect(repo.get("other")).not.toBeNull();
    // 没通知到的等待者跟着删；通知过的是历史，留着；别的 session 的不动。
    expect(gate.waitersOf(hold).map((w) => w.sessionId).sort()).toEqual(["b", "other"]);
    expect(repo.deleteChain("nope")).toEqual([]);
  });
});
