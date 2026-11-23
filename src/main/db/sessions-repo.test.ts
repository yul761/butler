import { describe, expect, it, vi } from "vitest";
import { insertTicket, memDb } from "../test-utils";
import { TicketsRepo } from "./tickets-repo";
import { SessionsRepo } from "./sessions-repo";

/** 一个复盘运行（sessions.lesson_run_id 有外键）。 */
function setup() {
  const db = memDb();
  db.prepare(`INSERT INTO lesson_repos (slug, local_path, created_at) VALUES ('acme/app', '/r/app', 1)`).run();
  const run = () => Number(db.prepare(`INSERT INTO lesson_runs (repo_slug, pr_number, origin, status, started_at) VALUES ('acme/app', 1, 'merged', 'done', 1)`).run().lastInsertRowid);
  return { db, repo: new SessionsRepo(db), run };
}

describe("SessionsRepo lesson sessions (lessons visibility task 7)", () => {
  it("lesson_run_id survives /clear", () => {
    const { repo, run } = setup();
    const id = run();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1, lessonRunId: id });
    repo.insertIfAbsent({ id: "b", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 2 });
    repo.setReplacedBy("a", "b", "clear");
    expect(repo.get("b")?.lessonRunId).toBe(id);
    expect(repo.forLessonRun(id)?.id).toBe("b");
  });

  it("lesson_run_id survives /resume", () => {
    const { repo, run } = setup();
    const id = run();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1, lessonRunId: id });
    repo.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 2 });
    repo.setReplacedBy("a", "c", "resume");
    expect(repo.get("c")?.lessonRunId).toBe(id);
    // 已经属于别的运行的不改。
    const other = run();
    repo.insertIfAbsent({ id: "d", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 3, lessonRunId: other });
    repo.setReplacedBy("c", "d", "resume");
    expect(repo.get("d")?.lessonRunId).toBe(other);
  });

  it("forLessonRun returns the newest head, hidden ones too", () => {
    const { repo, run } = setup();
    const id = run();
    expect(repo.forLessonRun(id)).toBeNull();
    repo.insertIfAbsent({ id: "old", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1, lessonRunId: id });
    repo.insertIfAbsent({ id: "new", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 5, lessonRunId: id });
    repo.dismiss("new");
    expect(repo.forLessonRun(id)?.id).toBe("new");
    expect(repo.forLessonRun(id + 1)).toBeNull();
  });

  it("listLessonSessions lists only lesson heads", () => {
    const { repo, run } = setup();
    const id = run();
    repo.insertIfAbsent({ id: "plain", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1 });
    repo.insertIfAbsent({ id: "shipherd", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1, shipherd: true });
    repo.insertIfAbsent({ id: "l1", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 1, lessonRunId: id });
    repo.insertIfAbsent({ id: "l1b", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 2 });
    repo.setReplacedBy("l1", "l1b", "clear");
    repo.insertIfAbsent({ id: "l2", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 3, lessonRunId: id });
    repo.insertIfAbsent({ id: "hidden", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 4, lessonRunId: id });
    repo.dismiss("hidden");
    expect(repo.listLessonSessions().map((s) => s.id)).toEqual(["l2", "l1b"]);
    expect(repo.get("plain")?.lessonRunId).toBeNull();
  });

  it("listUnclaimed skips lesson sessions", () => {
    const { repo, run } = setup();
    const id = run();
    repo.insertIfAbsent({ id: "loose", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 10 });
    repo.insertIfAbsent({ id: "lesson", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 10, lessonRunId: id });
    expect(repo.listUnclaimed(0).map((s) => s.id)).toEqual(["loose"]);
  });
});

describe("SessionsRepo.firstShipherdCreatedAt (ws-h baseline cutoff)", () => {
  it("is the earliest Shipherd session, lesson sessions and discovered ones excluded", () => {
    const { repo, run } = setup();
    expect(repo.firstShipherdCreatedAt()).toBeNull();
    repo.insertIfAbsent({ id: "l", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 5, lessonRunId: run() });
    repo.insertIfAbsent({ id: "d", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 7 });
    expect(repo.firstShipherdCreatedAt()).toBeNull();
    repo.insertIfAbsent({ id: "b2", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 20 });
    repo.insertIfAbsent({ id: "b1", ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: 10 });
    expect(repo.firstShipherdCreatedAt()).toBe(10);
  });
});

describe("SessionsRepo hibernation (WS-M B)", () => {
  const row = (repo: SessionsRepo, id: string, at = 1) => repo.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: at });

  it("marks, lists and clears a hibernated head", () => {
    const { repo } = setup();
    row(repo, "a");
    row(repo, "b");
    repo.setHibernated("a", 100, "ci", 2048.4);
    expect(repo.get("a")).toMatchObject({ hibernatedAt: 100, hibernateReason: "ci", memKb: 2048, memAt: 100 });
    expect(repo.listHibernated().map((s) => s.id)).toEqual(["a"]);
    repo.clearHibernated("a");
    expect(repo.get("a")).toMatchObject({ hibernatedAt: null, hibernateReason: null, memKb: 2048 });
    expect(repo.listHibernated()).toEqual([]);
  });

  it("keeps the last memory reading when hibernating without one", () => {
    const { repo } = setup();
    row(repo, "a");
    repo.setMemory("a", 900, 50);
    repo.setHibernated("a", 100, "idle", null);
    expect(repo.get("a")).toMatchObject({ memKb: 900, memAt: 50, hibernatedAt: 100 });
  });

  it("does not list a replaced id as hibernated", () => {
    const { repo } = setup();
    row(repo, "a");
    row(repo, "b", 2);
    repo.setHibernated("a", 100, "idle", null);
    repo.setReplacedBy("a", "b", "clear");
    expect(repo.listHibernated()).toEqual([]);
  });

  it("records and clears a wake error", () => {
    const { repo } = setup();
    row(repo, "a");
    repo.setWakeError("a", "no SessionStart", 7);
    expect(repo.get("a")).toMatchObject({ wakeError: "no SessionStart", wakeErrorAt: 7 });
    repo.setWakeError("a", null, 9);
    expect(repo.get("a")).toMatchObject({ wakeError: null, wakeErrorAt: null });
  });

  it("pinned follows /clear and /resume to the new head", () => {
    const { repo } = setup();
    row(repo, "a");
    row(repo, "b", 2);
    row(repo, "c", 3);
    repo.setPinned("a", true);
    expect(repo.get("a")?.pinned).toBe(true);
    repo.setReplacedBy("a", "b", "clear");
    expect(repo.get("b")?.pinned).toBe(true);
    repo.setReplacedBy("b", "c", "resume");
    expect(repo.get("c")?.pinned).toBe(true);
    repo.setPinned("c", false);
    expect(repo.get("c")?.pinned).toBe(false);
  });
});

describe("SessionsRepo.rootsOf", () => {
  it("maps a batch of ids to their chain roots; unknown ids map to themselves", () => {
    const { repo } = setup();
    for (const [id, at] of [["a", 1], ["b", 2], ["c", 3], ["x", 4]] as const) repo.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: at });
    repo.setReplacedBy("a", "b", "clear");
    repo.setReplacedBy("b", "c", "resume");
    expect(repo.rootsOf(["c", "b", "x", "nope"])).toEqual(new Map([["c", "a"], ["b", "a"], ["x", "x"], ["nope", "nope"]]));
    for (const id of ["a", "b", "c", "x"]) expect(repo.rootsOf([id]).get(id)).toBe(repo.rootOf(id));
  });

  it("returns an empty map for no ids without querying", () => {
    const { repo, db } = setup();
    const spy = vi.spyOn(db, "prepare");
    expect(repo.rootsOf([])).toEqual(new Map());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("SessionsRepo.rootOf (workstream L)", () => {
  it("finds the oldest id of a chain from any id on it", () => {
    const { repo } = setup();
    for (const [id, at] of [["a", 1], ["b", 2], ["c", 3]] as const) repo.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: at });
    repo.setReplacedBy("a", "b", "clear");
    repo.setReplacedBy("b", "c", "resume");
    expect(repo.rootOf("a")).toBe("a");
    expect(repo.rootOf("b")).toBe("a");
    expect(repo.rootOf("c")).toBe("a");
    expect(repo.rootOf("nope")).toBeNull();
  });

  it("returns instead of looping forever when replaced_by forms a cycle", () => {
    const { repo, db } = setup();
    for (const [id, at] of [["a", 1], ["b", 2]] as const) repo.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: at });
    db.prepare(`UPDATE sessions SET replaced_by = 'b' WHERE id = 'a'`).run();
    db.prepare(`UPDATE sessions SET replaced_by = 'a' WHERE id = 'b'`).run();
    expect(["a", "b"]).toContain(repo.rootOf("a"));
  });
});

describe("SessionsRepo.listConvTargets (UI redesign layer 4)", () => {
  it("picks heads that Shipherd opened or that belong somewhere, active since the cutoff", () => {
    const { db, repo, run } = setup();
    const feature = Number(db.prepare(`INSERT INTO features (name, workspace_dir, created_at) VALUES ('f', '/w', 1)`).run().lastInsertRowid);
    for (const k of ["PROJ-1", "PROJ-2", "PROJ-3"]) db.prepare(`INSERT INTO tickets (key, repo_path, work_mode, branch, created_at) VALUES (?, '/r', 'branch', 'b', 1)`).run(k);
    const add = (id: string, extra: Partial<Parameters<SessionsRepo["insertIfAbsent"]>[0]> = {}) =>
      repo.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 100, lastActivityAt: 100, ...extra });
    add("shipherd-origin", { origin: "shipherd" });
    add("ticket", { ticketKey: "PROJ-1" });
    add("feature", { featureId: feature });
    add("controller", { shipherd: true });
    add("stray");
    repo.recordHeadless("headless", "/w", 100);
    add("lesson", { origin: "shipherd", lessonRunId: run() });
    add("old-segment", { ticketKey: "PROJ-2" });
    add("new-segment", { ticketKey: "PROJ-2" });
    repo.setReplacedBy("old-segment", "new-segment");
    add("stale", { ticketKey: "PROJ-3", createdAt: 10, lastActivityAt: 10 });
    expect(repo.listConvTargets(50).map((s) => s.id).sort()).toEqual(["controller", "feature", "new-segment", "shipherd-origin", "ticket"]);
  });
});

/** 以前的 epic session（BTL-246 去掉了 epic 层）：新代码不写 epic_id，老行只能直接改表做出来。 */
function legacyEpicSession(db: ReturnType<typeof memDb>, repo: SessionsRepo, id: string, at = 100) {
  const epic = Number(db.prepare(`INSERT INTO epics (name, workspace_dir, created_at) VALUES (?, '/e', 1)`).run(`e-${id}`).lastInsertRowid);
  repo.insertIfAbsent({ id, ticketKey: null, cwd: "/e", origin: "shipherd", createdAt: at, lastActivityAt: at });
  db.prepare(`UPDATE sessions SET epic_id = ? WHERE id = ?`).run(epic, id);
}

describe("SessionsRepo keeps the old epic sessions out (BTL-246)", () => {
  it("does not list them as unclaimed, as conversation targets or as hibernated", () => {
    const { db, repo } = setup();
    legacyEpicSession(db, repo, "epic");
    repo.insertIfAbsent({ id: "loose", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 100, lastActivityAt: 100 });
    repo.setHibernated("epic", 100, "idle", null);
    expect(repo.listUnclaimed(0).map((s) => s.id)).toEqual(["loose"]);
    expect(repo.listConvTargets(0).map((s) => s.id)).toEqual([]);
    expect(repo.listHibernated()).toEqual([]);
  });

  it("keeps a new segment after /clear out too, and never makes it a coordinator or a feature's session", () => {
    const { db, repo } = setup();
    const feature = Number(db.prepare(`INSERT INTO features (name, workspace_dir, created_at) VALUES ('f', '/w', 1)`).run().lastInsertRowid);
    legacyEpicSession(db, repo, "old");
    repo.insertIfAbsent({ id: "new", ticketKey: null, cwd: "/e", origin: "discovered", createdAt: 200, lastActivityAt: 200, featureId: feature, coordinator: true });
    repo.setReplacedBy("old", "new", "clear");
    expect(repo.get("new")).toMatchObject({ coordinator: false, featureId: null });
    expect(repo.listUnclaimed(0)).toEqual([]);
    expect(repo.listConvTargets(0)).toEqual([]);
  });

  it("leaves the other sessions' segments without an epic", () => {
    const { db, repo } = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 1 });
    repo.insertIfAbsent({ id: "b", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 2 });
    repo.setReplacedBy("a", "b", "clear");
    expect(db.prepare(`SELECT epic_id FROM sessions WHERE id = 'b'`).get()).toEqual({ epic_id: null });
    expect(repo.listUnclaimed(0).map((s) => s.id)).toEqual(["b"]);
  });
});

describe("SessionsRepo.listByTickets (BTL-242)", () => {
  it("matches listByTicket for each key in one query", () => {
    const { db, repo } = setup();
    const tickets = new TicketsRepo(db);
    for (const key of ["T-1", "T-2", "T-3"]) {
      insertTicket(tickets, { key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: `feature/${key}`, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
    }
    const add = (id: string, ticketKey: string | null, at: number) => repo.insertIfAbsent({ id, ticketKey, cwd: "/w", origin: "shipherd", createdAt: at });
    add("a", "T-1", 1);
    add("b", "T-1", 3);
    add("c", "T-2", 2);
    add("d", null, 4);
    const spy = vi.spyOn(db, "prepare");
    const got = repo.listByTickets(["T-1", "T-2", "T-3"]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    for (const key of ["T-1", "T-2"]) expect(got.get(key)).toEqual(repo.listByTicket(key));
    expect(got.has("T-3")).toBe(false);
    expect(got.get("T-1")?.map((x) => x.id)).toEqual(["b", "a"]);
    expect(repo.listByTickets([])).toEqual(new Map());
  });
});

describe("SessionsRepo resume bookkeeping (BTL-256)", () => {
  const add = (repo: SessionsRepo, id: string, at = 1) => repo.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "shipherd", createdAt: at });

  it("records and clears that the user ended a session", () => {
    const { repo } = setup();
    add(repo, "a");
    expect(repo.get("a")?.userEndedAt).toBeNull();
    repo.setUserEnded("a", 5);
    expect(repo.get("a")?.userEndedAt).toBe(5);
    repo.setUserEnded("a", null);
    expect(repo.get("a")?.userEndedAt).toBeNull();
  });

  it("takeTermOpen returns the terminals still marked open and clears them", () => {
    const { repo } = setup();
    add(repo, "a");
    add(repo, "b", 2);
    add(repo, "c", 3);
    repo.markTermOpen("b", 20);
    repo.markTermOpen("a", 10);
    repo.markTermOpen("c", 30);
    repo.clearTermOpen("c");
    expect(repo.takeTermOpen()).toEqual(["a", "b"]);
    expect(repo.takeTermOpen()).toEqual([]);
  });
});
