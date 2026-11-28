// BTL-272：信息流转的迁移重建了 session_messages（kind 的 CHECK 加 fact）。重建前表里有的每一列（包括别的 ticket 先合进来的列，
// 比如 BTL-269 的 blocked_reason / blocked_since / stuck_receipt_at、BTL-279 的 attempts / last_attempt_at / last_attempt）、每一行的值，
// 重建后都要还在；索引也要在。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MigrationOrderError, migrate } from "./database";
import { MIGRATIONS } from "./migrations";

const AT = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE infoflow_turns"));

/** 升到信息流转的前一个版本（migrate 带目标版本：外键、BTL-279 的 addColumns 都按真实升级的做法来）。 */
function before(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  expect(migrate(db, AT)).toBe(AT);
  return db;
}

type Col = { name: string; type: string; notnull: number };
const cols = (db: DatabaseSync, t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as unknown as Col[];
/** 表上的索引：名字和建索引的整句 SQL（UNIQUE、WHERE 条件、列都在里面；rebase 段复核建议 3：只比名字看不出丢了 UNIQUE）。 */
const indexes = (db: DatabaseSync, t: string) =>
  (db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`).all(t) as {
    name: string;
    sql: string | null;
  }[]).map((r) => [r.name, r.sql]);

describe("info flow migration (BTL-272)", () => {
  it("is in the list and adds the fact kind", () => {
    expect(AT).toBeGreaterThan(0);
    expect(MIGRATIONS[AT]).toContain("'fact'");
  });

  it("is migration 65, after BTL-279's 64, and upgrades a database at 64", () => {
    // 迁移按数组追加：BTL-270 的 tickets 重建是 63，BTL-279 给 session_messages 加三列是 64，信息流转排在最后（user_version 65）。
    expect(AT).toBe(64);
    expect(AT).toBe(MIGRATIONS.length - 1);
    expect(MIGRATIONS[AT - 2]).toContain("closed_source");
    expect(MIGRATIONS[AT - 1]).toContain("last_attempt_at");
    const db = before();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 64 });
    db.exec(`INSERT INTO session_messages (id, kind, from_session, to_session, body, queued_at, blocked_reason, blocked_since, stuck_receipt_at)
      VALUES ('m1', 'report', 'a', 'b', 'hi', 1, 'turn', 5, 7)`);
    expect(migrate(db)).toBe(65);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 65 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // BTL-269 的三列连值一起留着。
    expect(db.prepare("SELECT blocked_reason, blocked_since, stuck_receipt_at FROM session_messages WHERE id = 'm1'").get())
      .toEqual({ blocked_reason: "turn", blocked_since: 5, stuck_receipt_at: 7 });
  });

  it("keeps BTL-279's attempts, last_attempt_at and last_attempt, values and declarations, word for word", () => {
    const db = before();
    db.exec(`INSERT INTO session_messages (id, kind, from_session, to_session, body, queued_at, attempts, last_attempt_at, last_attempt)
      VALUES ('m1', 'instruction', 'a', 'b', 'hi', 1, 4, 1234567, 'hibernated'), ('m2', 'report', 'a', 'b', 'yo', 2, 0, NULL, NULL)`);
    const decl = () => cols(db, "session_messages").filter((c) => /attempt/.test(c.name));
    const declBefore = decl();
    expect(declBefore.map((c) => c.name)).toEqual(["attempts", "last_attempt_at", "last_attempt"]);
    const dflt = () => db.prepare("SELECT name, dflt_value FROM pragma_table_info('session_messages') WHERE name LIKE '%attempt%' ORDER BY cid").all();
    const dfltBefore = dflt();

    expect(migrate(db)).toBe(65);

    expect(decl()).toEqual(declBefore);
    expect(dflt()).toEqual(dfltBefore);
    expect(db.prepare("SELECT id, attempts, last_attempt_at, last_attempt FROM session_messages ORDER BY id").all()).toEqual([
      { id: "m1", attempts: 4, last_attempt_at: 1234567, last_attempt: "hibernated" },
      { id: "m2", attempts: 0, last_attempt_at: null, last_attempt: null },
    ]);
    // 不写 attempts 的新行照样是默认值 0。
    db.exec(`INSERT INTO session_messages (id, kind, from_session, to_session, body, queued_at) VALUES ('m3', 'fact', 'a', 'b', 'x', 3)`);
    expect(db.prepare("SELECT attempts FROM session_messages WHERE id = 'm3'").get()).toEqual({ attempts: 0 });
  });

  it("refuses to run when infoflow_turns is already there, and leaves the database alone (#111's order check)", () => {
    const db = before();
    db.exec("CREATE TABLE infoflow_turns (turn_id INTEGER PRIMARY KEY)");
    db.exec(`INSERT INTO session_messages (id, kind, from_session, to_session, body, queued_at) VALUES ('m1', 'report', 'a', 'b', 'hi', 1)`);
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
    expect(db.prepare("SELECT id, kind FROM session_messages").all()).toEqual([{ id: "m1", kind: "report" }]);
  });

  it("keeps every column of session_messages, with its values, and its indexes", () => {
    const db = before();
    db.exec(`INSERT INTO session_messages (id, kind, from_session, to_session, body, queued_at) VALUES ('m1', 'report', 'a', 'b', 'hi', 1)`);
    // 每一列都填上一个值（有 CHECK 填不进的保持原样）：重建后逐列核对，不管将来别的迁移又加了哪些列。
    const sample = (c: Col, i: number): string | number => (/INT/i.test(c.type) ? 1000 + i : /REAL/i.test(c.type) ? i + 0.5 : `v-${c.name}`);
    const known: Record<string, string | number> = { status: "delivered", via: "hook", kind: "report", meta: '{"a":1}' };
    const beforeCols = cols(db, "session_messages");
    beforeCols.forEach((c, i) => {
      if (c.name === "id") return;
      try {
        db.prepare(`UPDATE session_messages SET ${c.name} = ? WHERE id = 'm1'`).run(known[c.name] ?? sample(c, i));
      } catch {
        /* 这一列有 CHECK：保持插入时的值 */
      }
    });
    const row = db.prepare(`SELECT * FROM session_messages WHERE id = 'm1'`).get() as Record<string, unknown>;
    const beforeIdx = indexes(db, "session_messages");

    expect(migrate(db)).toBe(MIGRATIONS.length);

    const afterNames = cols(db, "session_messages").map((c) => c.name);
    for (const c of beforeCols) expect(afterNames).toContain(c.name);
    const after = db.prepare(`SELECT * FROM session_messages WHERE id = 'm1'`).get() as Record<string, unknown>;
    for (const c of beforeCols) expect([c.name, after[c.name]]).toEqual([c.name, row[c.name]]);
    expect(beforeIdx.map(([name]) => name)).toEqual(["session_messages_queued_at", "session_messages_queued_ref", "session_messages_status"]);
    expect(indexes(db, "session_messages")).toEqual(beforeIdx);
    db.exec(`INSERT INTO session_messages (id, kind, from_session, to_session, body, queued_at) VALUES ('m2', 'fact', 'a', 'b', 'x', 2)`);
  });
});
