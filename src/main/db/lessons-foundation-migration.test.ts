import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

/** 工作流 C 的迁移是最后一条：先停在它前面，插 2.1.0 形态的数据，再迁到底。 */
const FOUNDATION = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE admission_batches"));

function at21(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (let i = 0; i < FOUNDATION; i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version = ${FOUNDATION}`);
  db.prepare("INSERT INTO lesson_repos (slug, local_path, created_at) VALUES ('acme/web', '/w', 1)").run();
  const ins = db.prepare("INSERT INTO lessons (repo_slug, text, why, status, hits, last_seen_at, created_at, updated_at) VALUES ('acme/web', ?, 'w', ?, 1, 1, 1, 1)");
  for (const s of ["pending", "confirmed", "disabled", "rejected"]) ins.run(`rule ${s}`, s);
  return db;
}

describe("lessons foundation migration (workstream C)", () => {
  it("is the last migration and exists", () => {
    expect(FOUNDATION).toBeGreaterThan(0);
  });

  it("keeps statuses, marks decided rows manual and leaves pending ones pending", () => {
    const db = at21();
    migrate(db);
    const rows = db.prepare("SELECT status, admission, scope_globs, strength, checkability, merged_into, score, degraded, batch_id FROM lessons ORDER BY id").all() as Record<string, unknown>[];
    expect(rows.map((r) => [r.status, r.admission])).toEqual([
      ["pending", "pending"], ["confirmed", "manual"], ["disabled", "manual"], ["rejected", "manual"],
    ]);
    for (const r of rows) {
      expect(r.scope_globs).toBe("[]");
      expect(r.strength).toBeNull();
      expect(r.checkability).toBeNull();
      expect(r.merged_into).toBeNull();
      expect(r.score).toBeNull();
      expect(r.degraded).toBe(0);
      expect(r.batch_id).toBeNull();
    }
  });

  it("new lessons default to admission pending, and the new columns are checked", () => {
    const db = at21();
    migrate(db);
    const id = Number(db.prepare("INSERT INTO lessons (repo_slug, text, why, status, last_seen_at, created_at, updated_at) VALUES ('acme/web', 'n', 'w', 'pending', 1, 1, 1)").run().lastInsertRowid);
    expect((db.prepare("SELECT admission FROM lessons WHERE id = ?").get(id) as { admission: string }).admission).toBe("pending");
    expect(() => db.prepare("UPDATE lessons SET admission = 'maybe' WHERE id = ?").run(id)).toThrow();
    expect(() => db.prepare("UPDATE lessons SET strength = 'could' WHERE id = ?").run(id)).toThrow();
    expect(() => db.prepare("UPDATE lessons SET checkability = 'x' WHERE id = ?").run(id)).toThrow();
    expect(() => db.prepare("UPDATE lessons SET checkability = 'covered', strength = 'must' WHERE id = ?").run(id)).not.toThrow();
  });

  it("creates the batch, policy, review and calibration tables, but not checks, backtests or baselines", () => {
    const db = at21();
    migrate(db);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    for (const t of ["admission_batches", "admission_batch_items", "admission_policies", "batch_reviews", "score_calibration"]) expect(tables.has(t), t).toBe(true);
    for (const t of ["checks", "check_backtests", "repo_baselines"]) expect(tables.has(t), t).toBe(false);
  });

  it("allows one policy row per layer and drops a product's layer with the product", () => {
    const db = at21();
    migrate(db);
    const pid = Number(db.prepare("INSERT INTO lesson_products (name, created_at) VALUES ('p', 1)").run().lastInsertRowid);
    const ins = db.prepare("INSERT INTO admission_policies (scope_kind, product_id, repo_slug, overrides, updated_at) VALUES (?, ?, ?, '{}', 1)");
    ins.run("global", null, null);
    expect(() => ins.run("global", null, null)).toThrow();
    ins.run("product", pid, null);
    expect(() => ins.run("product", pid, null)).toThrow();
    ins.run("repo", null, "acme/web");
    expect(() => ins.run("repo", null, "acme/web")).toThrow();
    expect(() => ins.run("repo", null, null)).toThrow();
    db.prepare("DELETE FROM lesson_products WHERE id = ?").run(pid);
    expect((db.prepare("SELECT COUNT(*) AS n FROM admission_policies").get() as { n: number }).n).toBe(2);
  });

  it("clears batch and merge references instead of failing when their target goes", () => {
    const db = at21();
    migrate(db);
    const b = Number(db.prepare("INSERT INTO admission_batches (created_at, kind, origin, entity) VALUES (1, 'confirm', 'manual', 'lesson')").run().lastInsertRowid);
    db.prepare("INSERT INTO admission_batch_items (batch_id, entity, entity_id, before, after) VALUES (?, 'lesson', 1, '{}', '{}')").run(b);
    db.prepare("UPDATE lessons SET batch_id = ?, merged_into = 2 WHERE id = 1").run(b);
    db.prepare("DELETE FROM lessons WHERE id = 2").run();
    db.prepare("DELETE FROM admission_batches WHERE id = ?").run(b);
    const r = db.prepare("SELECT batch_id, merged_into FROM lessons WHERE id = 1").get() as { batch_id: number | null; merged_into: number | null };
    expect(r).toEqual({ batch_id: null, merged_into: null });
    expect((db.prepare("SELECT COUNT(*) AS n FROM admission_batch_items").get() as { n: number }).n).toBe(0);
  });
});
