import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

/** BTL-270 的迁移：tickets 表重建（CHECK 加 closed / needs_decision），followups 加记录忽略原因的列。 */
const C = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE tickets_new"));

function before(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (let i = 0; i < C; i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version = ${C}`);
  return db;
}

const columns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).all(table) as { name: string }[]).map((r) => r.name);

describe("ticket close migration (BTL-270)", () => {
  it("exists", () => {
    expect(C).toBeGreaterThan(0);
  });

  it("rebuilds tickets keeping every column and row, and the tables pointing at it keep their rows", () => {
    const db = before();
    const old = columns(db, "tickets");
    db.prepare("INSERT INTO features (id, name, workspace_dir, created_at) VALUES (4, 'f', '/w', 1)").run();
    db.prepare(
      `INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, status_manual, created_at, archived_at, status_changed_at, status_manual_at, feature_id)
       VALUES ('T-1', 'one', '/r', 'worktree', '/wt', 'feature/T-1', 'blocked', 'in_review', 5, NULL, 6, 7, 4)`,
    ).run();
    db.prepare(`INSERT INTO sessions (id, ticket_key, cwd, origin, created_at) VALUES ('s1', 'T-1', '/wt', 'butler', 1)`).run();
    db.prepare(
      `INSERT INTO followups (id, ticket_key, kind, description, trigger, status, source, created_at) VALUES ('f1', 'T-1', 'doc', 'docs', 'none', 'open', 'session', 1)`,
    ).run();

    migrate(db);

    expect(columns(db, "tickets")).toEqual([...old, "closed_at", "closed_reason", "closed_source"]);
    expect(db.prepare("SELECT key, title, status, status_manual, status_changed_at, status_manual_at, feature_id FROM tickets").all()).toEqual([
      { key: "T-1", title: "one", status: "blocked", status_manual: "in_review", status_changed_at: 6, status_manual_at: 7, feature_id: 4 },
    ]);
    expect((db.prepare("SELECT count(*) AS n FROM sessions WHERE ticket_key = 'T-1'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT count(*) AS n FROM followups WHERE ticket_key = 'T-1'").get() as { n: number }).n).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // 外键还开着，而且还指向 tickets（不是改名前的 tickets_new）。
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(() => db.prepare(`INSERT INTO followups (id, ticket_key, kind, description, trigger, status, source, created_at) VALUES ('f2', 'NOPE', 'doc', 'x', 'none', 'open', 'session', 1)`).run()).toThrow();
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tickets'").get() as { sql: string }).sql;
    expect(sql).not.toContain("tickets_new");
  });

  it("accepts the new statuses and rejects unknown ones", () => {
    const db = before();
    migrate(db);
    const ins = (key: string, status: string, manual: string | null) =>
      db.prepare(`INSERT INTO tickets (key, repo_path, work_mode, branch, status, status_manual, created_at) VALUES (?, '', 'branch', '', ?, ?, 1)`).run(key, status, manual);
    ins("A", "needs_decision", "closed");
    expect(() => ins("B", "nope", null)).toThrow();
    expect(() => ins("C", "active", "nope")).toThrow();
    expect(() => db.prepare(`UPDATE tickets SET closed_source = 'nobody' WHERE key = 'A'`).run()).toThrow();
    db.prepare(`UPDATE tickets SET closed_source = 'coordinator', closed_reason = 'r', closed_at = 1 WHERE key = 'A'`).run();
  });

  it("adds the followup resolution columns", () => {
    const db = before();
    migrate(db);
    expect(columns(db, "followups")).toEqual(expect.arrayContaining(["resolved_reason", "resolved_source", "ignored_by_close", "prior_status", "prior_snoozed_until"]));
  });

  it("still migrates a database that already had a dangling row, and turns foreign keys back on", () => {
    const db = before();
    // 外键关着时写进来、指向不存在的 ticket 的行：事先就有的违规不算这条迁移造成的。
    db.exec("PRAGMA foreign_keys = OFF;");
    db.prepare(`INSERT INTO followups (id, ticket_key, kind, description, trigger, status, source, created_at) VALUES ('orphan', 'GONE', 'doc', 'x', 'none', 'open', 'session', 1)`).run();
    db.exec("PRAGMA foreign_keys = ON;");
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });
});
