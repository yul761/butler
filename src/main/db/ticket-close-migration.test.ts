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

  it("is migration 63, right after BTL-269's 62, and upgrades a database at 62", () => {
    // 合并顺序：#104 占 60，#103 占 61，#108（BTL-269）占 62，这一条排在它们后面。
    expect(C).toBe(62);
    expect(MIGRATIONS[C - 1]).toContain("blocked_reason");
    const db = before();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 62 });
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
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

  // 审查第 5 项：原来的 14 列逐列、逐行都抄过来，列的类型、NOT NULL、默认值、主键都不变；别的表除了加列的两张，一点都不变。
  it("copies all 14 old columns row by row with their definitions, and leaves the other tables untouched", () => {
    const db = before();
    const info = (table: string) => db.prepare(`SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`).all(table);
    const fks = (table: string) => db.prepare(`SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq`).all(table);
    const oldInfo = info("tickets");
    expect(oldInfo).toHaveLength(14);
    const oldFks = fks("tickets");
    db.prepare("INSERT INTO features (id, name, workspace_dir, created_at) VALUES (4, 'f', '/w', 1)").run();
    const blockId = Number(db.prepare("INSERT INTO blocks (feature_id, name, position, created_at) VALUES (4, 'b', 0, 1)").run().lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, status_manual, created_at, archived_at, status_changed_at, status_manual_at, feature_id, block_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("T-1", "one", "/r", "worktree", "/wt", "feature/T-1", "blocked", "in_review", 5, null, 6, 7, 4, blockId);
    ins.run("T-2", null, "", "branch", null, "", "done", null, 8, 9, null, null, null, null);
    ins.run("T-3", "三", "/r2", "branch", null, "main", "merged_pending_followup", "done", 10, null, 11, 12, 4, null);
    const rows = db.prepare("SELECT * FROM tickets ORDER BY key").all();
    const others = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('tickets', 'followups', 'ticket_prs') ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    const snapshot = () => others.map((t) => ({ t, info: info(t), fks: fks(t) }));
    const master = () => db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT IN ('tickets', 'followups', 'ticket_prs') ORDER BY type, name`).all();
    const followupsBefore = info("followups");
    const prsBefore = info("ticket_prs");
    const was = { snap: snapshot(), master: master() };

    // 只升到这一条：后面的迁移（BTL-279 给 session_messages 加列、BTL-272 重建 session_messages 和建 infoflow 表）改别的表是它们自己的事。
    expect(migrate(db, C + 1)).toBe(C + 1);

    const after = info("tickets");
    expect(after.slice(0, 14)).toEqual(oldInfo);
    expect(after.slice(14).map((c) => (c as { name: string }).name)).toEqual(["closed_at", "closed_reason", "closed_source"]);
    expect(fks("tickets")).toEqual(oldFks);
    const cols = oldInfo.map((c) => (c as { name: string }).name);
    const kept = (db.prepare("SELECT * FROM tickets ORDER BY key").all() as Record<string, unknown>[]).map((r) => {
      expect([r.closed_at, r.closed_reason, r.closed_source]).toEqual([null, null, null]);
      return Object.fromEntries(cols.map((c) => [c, r[c]]));
    });
    expect(kept).toEqual(rows);
    expect(snapshot()).toEqual(was.snap);
    expect(master()).toEqual(was.master);
    // 加列的两张：原来的列不变，只在最后加。
    expect(info("followups").slice(0, followupsBefore.length)).toEqual(followupsBefore);
    expect(info("ticket_prs").slice(0, prsBefore.length)).toEqual(prsBefore);
    expect(info("ticket_prs").slice(prsBefore.length)).toEqual([expect.objectContaining({ name: "shipherd_closed_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 })]);
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
