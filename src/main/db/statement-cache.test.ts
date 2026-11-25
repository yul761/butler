import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cacheStatements, LARGE_PARAM_BYTES, prepareUncached, STATEMENT_CACHE_MAX } from "./database";

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

  it("a run with a large parameter drops the statement, so the cache does not hold on to the bound value", () => {
    // node:sqlite 跑完不清绑定：留在缓存里的语句会一直拿着最后一次的参数。
    const db = make();
    db.exec("CREATE TABLE b (v)");
    const sql = "INSERT INTO b VALUES (?)";
    const small = db.prepare(sql);
    small.run("x");
    expect(db.prepare(sql)).toBe(small);
    small.run("y".repeat(LARGE_PARAM_BYTES + 1));
    const next = db.prepare(sql);
    expect(next).not.toBe(small);
    next.run(new Uint8Array(LARGE_PARAM_BYTES + 1));
    expect(db.prepare(sql)).not.toBe(next);
    // 命名参数和读也一样；结果照常返回。
    const named = db.prepare("SELECT length(:v) AS n");
    expect(named.get({ v: "z".repeat(LARGE_PARAM_BYTES + 1) })).toEqual({ n: LARGE_PARAM_BYTES + 1 });
    expect(db.prepare("SELECT length(:v) AS n")).not.toBe(named);
    const list = db.prepare("SELECT COUNT(*) AS n FROM json_each(?)");
    expect(list.all(JSON.stringify(Array.from({ length: 2000 }, (_, i) => i)))).toEqual([{ n: 2000 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM json_each(?)")).not.toBe(list);
    expect(db.prepare("SELECT COUNT(*) AS n FROM b").get()).toEqual({ n: 3 });
  });
});
