import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";
import { SettingsRepo, SETTING_DEFAULTS } from "./settings-repo";

/** BTL-271 的迁移：预审并发数新装默认 2，已经在用的留在以前的 1 个。 */
const M = MIGRATIONS.findIndex((m) => m.includes("'preReviewConcurrency'"));

function before(o: { ticket?: boolean; onboarded?: boolean; saved?: string }): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (let i = 0; i < M; i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version = ${M}`);
  if (o.ticket) db.prepare("INSERT INTO tickets (key, title, status, created_at, repo_path, work_mode, branch) VALUES ('T-1', 'x', 'active', 1, '/r', 'worktree', 'b')").run();
  if (o.onboarded) db.prepare("INSERT INTO settings (key, value) VALUES ('onboardingDone', '1')").run();
  if (o.saved) db.prepare("INSERT INTO settings (key, value) VALUES ('preReviewConcurrency', ?)").run(o.saved);
  return db;
}

const concurrency = (db: DatabaseSync) => new SettingsRepo(db).get("preReviewConcurrency");

describe("pre-review concurrency migration (BTL-271)", () => {
  it("a fresh install gets the new default of 2", () => {
    expect(M).toBeGreaterThan(0);
    expect(SETTING_DEFAULTS.preReviewConcurrency).toBe("2");
    const db = before({});
    migrate(db);
    expect(concurrency(db)).toBe("2");
  });

  it("an install already in use (tickets, or onboarding done) stays at 1; a saved value is kept", () => {
    for (const o of [{ ticket: true }, { onboarded: true }]) {
      const db = before(o);
      migrate(db);
      expect(concurrency(db), JSON.stringify(o)).toBe("1");
    }
    const saved = before({ ticket: true, saved: "4" });
    migrate(saved);
    expect(concurrency(saved)).toBe("4");
  });

  it("is migration 61, right after BTL-274's 60, and upgrades a database at 60 without touching its rows", () => {
    // 合并顺序：#104（BTL-274）占 60，这一条排在它后面。从 main 现在的版本（60）升上来。
    expect(M).toBe(60);
    expect(MIGRATIONS[M - 1]).toContain("CREATE TABLE lesson_merge_proposals");
    const db = before({ ticket: true });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 60 });
    db.prepare(`INSERT INTO pre_reviews (ticket_key, repo_slug, branch, head_sha, trigger, status, verdict, created_at, finished_at)
      VALUES ('T-1', 'o/r', 'b', 'abc', 'evidence', 'done', 'clean', 5, 9)`).run();
    db.prepare(`INSERT INTO lesson_merge_proposals (scope_kind, lesson_ids, text, reason, input_hash, created_at)
      VALUES ('repo', '[1,2]', 't', 'r', 'h', 1)`).run();

    expect(migrate(db)).toBe(61);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    const cols = (db.prepare("PRAGMA table_info(pre_reviews)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("started_at");
    expect(db.prepare("SELECT ticket_key, head_sha, status, verdict, created_at, finished_at, started_at FROM pre_reviews").all())
      .toEqual([{ ticket_key: "T-1", head_sha: "abc", status: "done", verdict: "clean", created_at: 5, finished_at: 9, started_at: null }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'pre_reviews_ticket'").all()).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM lesson_merge_proposals").get()).toEqual({ n: 1 });
    expect(concurrency(db)).toBe("1");
  });
});
