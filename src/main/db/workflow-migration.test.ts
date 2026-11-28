// BTL-273：可配的工作流程的迁移排在 BTL-272 的信息流转（65）后面：建表的是 66，栈层的 workflow_draft_at 是 67（只加列）。
// 表在升到这一步之前就已经在了（装过把它排在前面的测试版本），#111 的顺序预检要在动库之前拦下。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MigrationOrderError, migrate } from "./database";
import { CHECKED_ADD_COLUMNS, MIGRATIONS } from "./migrations";

const AT = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE workflow_layers"));
const DRAFT = MIGRATIONS.findIndex((m) => m.includes("workflow_draft_at"));

function before(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  expect(migrate(db, AT)).toBe(AT);
  return db;
}
const cols = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe("workflow migrations (BTL-273)", () => {
  it("are 66 and 67, after BTL-272's 65, and upgrade a database at 65", () => {
    expect(AT).toBe(65);
    expect(MIGRATIONS[AT - 1]).toContain("CREATE TABLE infoflow_turns");
    expect(DRAFT).toBe(66);
    expect(DRAFT).toBe(MIGRATIONS.length - 1);
    expect(MIGRATIONS[DRAFT].startsWith(CHECKED_ADD_COLUMNS)).toBe(true);
    const db = before();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 65 });
    expect(migrate(db)).toBe(67);
    for (const t of ["workflow_layers", "workflow_progress", "workflow_bot_requests", "workflow_notices"]) expect(cols(db, t).length, t).toBeGreaterThan(0);
    expect(cols(db, "stack_layers")).toContain("workflow_draft_at");
  });

  it("refuses to run when workflow_layers is already there, and leaves the database alone (#111's order check)", () => {
    const db = before();
    db.exec("CREATE TABLE workflow_layers (id INTEGER PRIMARY KEY)");
    db.exec(`INSERT INTO workflow_layers (id) VALUES (7)`);
    const schemaBefore = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    let err: unknown;
    try {
      migrate(db);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationOrderError);
    expect((err as MigrationOrderError).what).toBe("table");
    expect((err as MigrationOrderError).index).toBe(AT);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: AT });
    expect(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schemaBefore);
    expect(db.prepare("SELECT id FROM workflow_layers").all()).toEqual([{ id: 7 }]);
    expect(cols(db, "stack_layers")).not.toContain("workflow_draft_at");
  });
});
