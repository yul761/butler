import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

/** 工作流 F 的迁移：先停在它前面，插一条检查，再迁到底。 */
const F = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE check_backtests"));

describe("backtest migration (workstream F)", () => {
  it("adds the backtest, bypass, score, lifecycle and threshold tables over existing checks", () => {
    expect(F).toBeGreaterThan(0);
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < F; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${F}`);
    db.prepare("INSERT INTO checks (key, scope_kind, repo_slug, type, severity, mode, created_at, updated_at) VALUES ('k', 'repo', 'acme/web', 'forbidden_pattern', 'block', 'shadow', 1, 1)").run();
    migrate(db);
    const id = (db.prepare("SELECT id FROM checks WHERE key = 'k'").get() as { id: number }).id;
    db.prepare("INSERT INTO check_scores (check_id, score, scored_at) VALUES (?, 0.8, 2)").run(id);
    db.prepare("INSERT INTO check_lifecycle (check_id, needs_review, updated_at) VALUES (?, 1, 2)").run(id);
    db.prepare("INSERT INTO check_bypasses (check_id, check_key, how, at, ingest_key) VALUES (?, 'k', 'no_verify', 2, 'x')").run(id);
    expect(() => db.prepare("INSERT INTO check_bypasses (check_key, how, at, ingest_key) VALUES ('k', 'other', 2, 'y')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO check_backtests (def_hash, repo_slug, status, created_at) VALUES ('h', 'acme/web', 'nope', 1)").run()).toThrow();
    db.prepare("DELETE FROM checks WHERE id = ?").run(id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_scores").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_lifecycle").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT check_id FROM check_bypasses").get()).toEqual({ check_id: null });
  });
});
