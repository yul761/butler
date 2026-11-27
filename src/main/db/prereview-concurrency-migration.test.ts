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
});
