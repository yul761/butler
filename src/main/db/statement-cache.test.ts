import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cacheStatements, prepareUncached, STATEMENT_CACHE_MAX } from "./database";

const make = () => {
  const db = cacheStatements(new DatabaseSync(":memory:"));
  db.exec("CREATE TABLE t (x INTEGER)");
  db.exec("INSERT INTO t VALUES (1), (2), (3)");
  return db;
};

describe("cacheStatements (BTL-265)", () => {
  it("returns the same compiled statement for the same SQL", () => {
    const db = make();
    const a = db.prepare("SELECT x FROM t WHERE x = ?");
    expect(db.prepare("SELECT x FROM t WHERE x = ?")).toBe(a);
    expect(db.prepare("SELECT x FROM t WHERE x > ?")).not.toBe(a);
    expect(a.get(2)).toEqual({ x: 2 });
    expect(db.prepare("SELECT x FROM t WHERE x = ?").get(3)).toEqual({ x: 3 });
  });

  it("an iterate left by break or return does not affect the next use", () => {
    const db = make();
    const first = (): number | null => {
      for (const r of db.prepare("SELECT x FROM t ORDER BY x").iterate() as Iterable<{ x: number }>) if (r.x >= 1) return r.x;
      return null;
    };
    expect(first()).toBe(1);
    expect(db.prepare("SELECT x FROM t ORDER BY x").all()).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
    db.prepare("INSERT INTO t VALUES (?)").run(4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 4 });
  });

  it("keeps working after a schema change", () => {
    const db = make();
    expect(db.prepare("SELECT * FROM t WHERE x = 1").get()).toEqual({ x: 1 });
    db.exec("ALTER TABLE t ADD COLUMN y TEXT DEFAULT 'a'");
    expect(db.prepare("SELECT * FROM t WHERE x = 1").get()).toEqual({ x: 1, y: "a" });
  });

  it("drops the least recently used statement past the limit", () => {
    const db = make();
    const keep = db.prepare("SELECT 0 AS v");
    const old = db.prepare("SELECT -1 AS v");
    for (let i = 1; i < STATEMENT_CACHE_MAX; i++) {
      db.prepare(`SELECT ${i} AS v`);
      if (i % 100 === 0) db.prepare("SELECT 0 AS v");
    }
    expect(db.prepare("SELECT 0 AS v")).toBe(keep);
    expect(db.prepare("SELECT -1 AS v")).not.toBe(old);
  });

  it("statement options bypass the cache", () => {
    const db = make();
    const plain = db.prepare("SELECT x FROM t");
    const withOpts = (db.prepare as (sql: string, o: object) => unknown)("SELECT x FROM t", {});
    expect(withOpts).not.toBe(plain);
    expect(db.prepare("SELECT x FROM t")).toBe(plain);
  });

  it("prepareUncached compiles its own statement, so a nested query of the same SQL does not reset it", () => {
    const db = make();
    const sql = "SELECT x FROM t ORDER BY x";
    const own = prepareUncached(db, sql);
    expect(own).not.toBe(db.prepare(sql));
    expect(prepareUncached(db, sql)).not.toBe(own);
    const seen: number[] = [];
    for (const r of own.iterate() as Iterable<{ x: number }>) {
      seen.push(r.x);
      // 循环体里用缓存的同一条 SQL 读完一遍：外面的不受影响。
      expect(db.prepare(sql).all()).toHaveLength(3);
    }
    expect(seen).toEqual([1, 2, 3]);
    // 没包过的连接也能用。
    expect(prepareUncached(new DatabaseSync(":memory:"), "SELECT 1 AS v").get()).toEqual({ v: 1 });
  });
});
