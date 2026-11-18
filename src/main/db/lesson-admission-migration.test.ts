import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

/** 工作流 D 的迁移：先停在它前面，插几条老数据，再迁到底。 */
const D = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE lesson_judgments"));

function before(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (let i = 0; i < D; i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version = ${D}`);
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES ('acme/web', '/w', 1)").run();
  const ins = db.prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at) VALUES ('acme/web', ?, 'w', ?, 1, 1, 1, ?)");
  ins.run("p", "pending", 5);
  ins.run("c", "confirmed", 7);
  db.prepare("INSERT INTO lesson_sources (lesson_id, pr_number, url, at) VALUES (1, 3, 'https://github.com/acme/web/pull/3#r1', 1)").run();
  return db;
}

describe("lesson admission migration (workstream D)", () => {
  it("exists", () => {
    expect(D).toBeGreaterThan(0);
  });

  it("keeps old rows, adds empty source details and stamps confirmed_at on confirmed rows", () => {
    const db = before();
    migrate(db);
    const rows = db.prepare("SELECT status, confirmed_at, enriched_at, principle_id, shelved_note FROM lessons ORDER BY id").all() as Record<string, unknown>[];
    expect(rows).toEqual([
      { status: "pending", confirmed_at: null, enriched_at: null, principle_id: null, shelved_note: null },
      { status: "confirmed", confirmed_at: 7, enriched_at: null, principle_id: null, shelved_note: null },
    ]);
    const src = db.prepare("SELECT reviewer, path, line, excerpt FROM lesson_sources").get() as Record<string, unknown>;
    expect(src).toEqual({ reviewer: null, path: null, line: null, excerpt: null });
  });

  it("old calibration samples count as overrides; the wizard tables check their states", () => {
    const db = before();
    migrate(db);
    db.prepare("INSERT INTO score_calibration (lesson_id, entity_id, auto_verdict, human_verdict, at) VALUES (1, 1, 'admit', 'reject', 1)").run();
    expect((db.prepare("SELECT source FROM score_calibration").get() as { source: string }).source).toBe("override");
    expect(() => db.prepare("INSERT INTO lesson_wizard_runs (scope_kind, state, created_at, updated_at) VALUES ('all', 'maybe', 1, 1)").run()).toThrow();
    const run = Number(db.prepare("INSERT INTO lesson_wizard_runs (scope_kind, state, created_at, updated_at) VALUES ('all', 'extracting', 1, 1)").run().lastInsertRowid);
    db.prepare("INSERT INTO lesson_wizard_items (run_id, kind, key, status) VALUES (?, 'clarity', '1', 'queued')").run(run);
    expect(() => db.prepare("INSERT INTO lesson_wizard_items (run_id, kind, key, status) VALUES (?, 'clarity', '2', 'odd')").run(run)).toThrow();
  });
});
