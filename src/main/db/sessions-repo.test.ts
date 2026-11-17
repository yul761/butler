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
