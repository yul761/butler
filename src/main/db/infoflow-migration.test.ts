// BTL-272：信息流转的迁移重建了 session_messages（kind 的 CHECK 加 fact）。重建前表里有的每一列（包括别的 ticket 先合进来的列，
// 比如 BTL-269 的 blocked_reason / blocked_since / stuck_receipt_at）、每一行的值，重建后都要还在；索引也要在。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";

const AT = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE infoflow_turns"));

function before(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // 前面的重建（BTL-270 的 tickets）要在外键关着时跑，migrate 也是这么做的。
  db.exec("PRAGMA foreign_keys = OFF;");
  for (const m of MIGRATIONS.slice(0, AT)) db.exec(m);
  db.exec(`PRAGMA user_version = ${AT}`);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

type Col = { name: string; type: string; notnull: number };
const cols = (db: DatabaseSync, t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as unknown as Col[];
const indexes = (db: DatabaseSync, t: string) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`).all(t) as { name: string }[]).map((r) => r.name);

describe("info flow migration (BTL-272)", () => {
  it("is in the list and adds the fact kind", () => {
    expect(AT).toBeGreaterThan(0);
    expect(MIGRATIONS[AT]).toContain("'fact'");
  });

  it("is migration 64, after BTL-270's 63, and upgrades a database at 63", () => {
    // 迁移按数组追加：BTL-270 的 tickets 重建是 63，信息流转排在它后面（user_version 64）。
    expect(AT).toBe(63);
    expect(MIGRATIONS[AT - 1]).toContain("closed_source");
    const db = before();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 63 });
    db.exec(`INSERT INTO session_messages (id, kind, from_session, to_session, body, queued_at, blocked_reason, blocked_since, stuck_receipt_at)
      VALUES ('m1', 'report', 'a', 'b', 'hi', 1, 'turn', 5, 7)`);
    expect(migrate(db)).toBe(64);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 64 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // BTL-269 的三列连值一起留着。
    expect(db.prepare("SELECT blocked_reason, blocked_since, stuck_receipt_at FROM session_messages WHERE id = 'm1'").get())
      .toEqual({ blocked_reason: "turn", blocked_since: 5, stuck_receipt_at: 7 });
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
    for (const name of beforeIdx) expect(indexes(db, "session_messages")).toContain(name);
    db.exec(`INSERT INTO session_messages (id, kind, from_session, to_session, body, queued_at) VALUES ('m2', 'fact', 'a', 'b', 'x', 2)`);
  });
});
