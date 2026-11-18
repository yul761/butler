import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
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
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1, lessonRunId: id });
    repo.insertIfAbsent({ id: "b", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 2 });
    repo.setReplacedBy("a", "b", "clear");
    expect(repo.get("b")?.lessonRunId).toBe(id);
    expect(repo.forLessonRun(id)?.id).toBe("b");
  });

  it("lesson_run_id survives /resume", () => {
    const { repo, run } = setup();
    const id = run();
    repo.insertIfAbsent({ id: "a", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1, lessonRunId: id });
    repo.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 2 });
    repo.setReplacedBy("a", "c", "resume");
    expect(repo.get("c")?.lessonRunId).toBe(id);
    // 已经属于别的运行的不改。
    const other = run();
    repo.insertIfAbsent({ id: "d", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 3, lessonRunId: other });
    repo.setReplacedBy("c", "d", "resume");
    expect(repo.get("d")?.lessonRunId).toBe(other);
  });

  it("forLessonRun returns the newest head, hidden ones too", () => {
    const { repo, run } = setup();
    const id = run();
    expect(repo.forLessonRun(id)).toBeNull();
    repo.insertIfAbsent({ id: "old", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1, lessonRunId: id });
    repo.insertIfAbsent({ id: "new", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 5, lessonRunId: id });
    repo.dismiss("new");
    expect(repo.forLessonRun(id)?.id).toBe("new");
    expect(repo.forLessonRun(id + 1)).toBeNull();
  });

  it("listLessonSessions lists only lesson heads", () => {
    const { repo, run } = setup();
    const id = run();
    repo.insertIfAbsent({ id: "plain", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1 });
    repo.insertIfAbsent({ id: "butler", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1, butler: true });
    repo.insertIfAbsent({ id: "l1", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1, lessonRunId: id });
    repo.insertIfAbsent({ id: "l1b", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 2 });
    repo.setReplacedBy("l1", "l1b", "clear");
    repo.insertIfAbsent({ id: "l2", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 3, lessonRunId: id });
    repo.insertIfAbsent({ id: "hidden", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 4, lessonRunId: id });
    repo.dismiss("hidden");
    expect(repo.listLessonSessions().map((s) => s.id)).toEqual(["l2", "l1b"]);
    expect(repo.get("plain")?.lessonRunId).toBeNull();
  });

  it("listUnclaimed skips lesson sessions", () => {
    const { repo, run } = setup();
    const id = run();
    repo.insertIfAbsent({ id: "loose", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 10 });
    repo.insertIfAbsent({ id: "lesson", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 10, lessonRunId: id });
    expect(repo.listUnclaimed(0).map((s) => s.id)).toEqual(["loose"]);
  });
});

describe("SessionsRepo.firstButlerCreatedAt (ws-h baseline cutoff)", () => {
  it("is the earliest Butler session, lesson sessions and discovered ones excluded", () => {
    const { repo, run } = setup();
    expect(repo.firstButlerCreatedAt()).toBeNull();
    repo.insertIfAbsent({ id: "l", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 5, lessonRunId: run() });
    repo.insertIfAbsent({ id: "d", ticketKey: null, cwd: "/w", origin: "discovered", createdAt: 7 });
    expect(repo.firstButlerCreatedAt()).toBeNull();
    repo.insertIfAbsent({ id: "b2", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 20 });
    repo.insertIfAbsent({ id: "b1", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 10 });
    expect(repo.firstButlerCreatedAt()).toBe(10);
  });
});

describe("SessionsRepo hibernation (WS-M B)", () => {
  const row = (repo: SessionsRepo, id: string, at = 1) => repo.insertIfAbsent({ id, ticketKey: null, cwd: "/w", origin: "butler", createdAt: at });

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
