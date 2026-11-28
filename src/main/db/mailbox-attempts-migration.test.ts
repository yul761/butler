import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addMissingColumns, checkMigrationOrder, DatabaseBackupError, MigrationOrderError, migrate, NewerDatabaseError, olderBackup, openDatabase, startupErrorText } from "./database";
import { CHECKED_ADD_COLUMNS } from "./migrations";
import { setLang } from "../i18n";
import { addColumns, MIGRATIONS } from "./migrations";
import { SessionMessagesRepo } from "./session-messages-repo";

/** BTL-279 的迁移：session_messages 记试着送了几次、最后一次什么时候、结果是什么（诊断导出、消息列表里看得到）。 */
const M = MIGRATIONS.findIndex((m) => m.includes("session_messages ADD COLUMN attempts"));

const cols = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/**
 * 在内存里跑完 steps、版本设成 uv，再 VACUUM INTO 写成 file（一次写盘）。同一组 steps 的内存库留着重用：
 * 直接在磁盘上跑六十多步迁移，Windows 每步都 fsync，CI 上一个测试要 30 秒以上（35a03fa0 的 Windows CI 超时）。
 */
const templates = new Map<string, DatabaseSync>();
const writeDb = (file: string, steps: readonly string[], uv: number): string => {
  const key = `${uv}\0${steps.join("\0")}`;
  let mem = templates.get(key);
  if (!mem) {
    mem = new DatabaseSync(":memory:");
    for (const s of steps) mem.exec(s);
    mem.exec(`PRAGMA user_version = ${uv}`);
    templates.set(key, mem);
  }
  mem.prepare("VACUUM INTO ?").run(file);
  return file;
};

describe("mailbox attempts migration (BTL-279)", () => {
  it("is the one checked migration adding the three columns, and upgrades the database before it without touching its rows", () => {
    // 按内容找到 BTL-279 那一条，不要求它排在最后（第九轮复核建议 2：#111 先合以后 #109 排到 65）。
    expect(M).toBeGreaterThanOrEqual(0);
    expect(MIGRATIONS[M].startsWith(CHECKED_ADD_COLUMNS)).toBe(true);
    expect(MIGRATIONS.filter((m) => /session_messages ADD COLUMN (attempts|last_attempt_at|last_attempt)\b/.test(m))).toEqual([MIGRATIONS[M]]);
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < M; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${M}`);
    db.prepare(`INSERT INTO session_messages (id, kind, from_session, to_session, feature_id, body, status, queued_at, blocked_reason, blocked_since)
      VALUES ('m1', 'instruction', 'coord', 's1', 1, 'do it', 'queued', 5, 'turn', 6)`).run();

    expect(migrate(db, M + 1)).toBe(M + 1);
    expect(cols(db, "session_messages")).toEqual(expect.arrayContaining(["attempts", "last_attempt_at", "last_attempt"]));
    expect(db.prepare("SELECT id, body, status, queued_at, blocked_reason, blocked_since, attempts, last_attempt_at, last_attempt FROM session_messages").all())
      .toEqual([{ id: "m1", body: "do it", status: "queued", queued_at: 5, blocked_reason: "turn", blocked_since: 6, attempts: 0, last_attempt_at: null, last_attempt: null }]);
    // 升级上来的旧行照样能记尝试。
    const repo = new SessionMessagesRepo(db);
    repo.attempted(["m1"], 10, "turn");
    expect(repo.get("m1")).toMatchObject({ attempts: 1, lastAttemptAt: 10, lastAttempt: "turn" });
  });

  it("refuses a database a test build migrated in another order, instead of skipping the migration it never ran (4.3.0 review)", () => {
    // 复核复现：分支版本里前面只有 M-1 条（没有现在排在它前面的那一条），这条排在第 M 个跑过；合并后它排到第 M+1 个。
    // 从版本 M 接着升只会跑这一条，排在第 M 个的那条永远跑不到。
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < M - 1; i++) db.exec(MIGRATIONS[i]);
    db.exec(MIGRATIONS[M]);
    db.exec(`PRAGMA user_version = ${M}`);
    db.prepare(`INSERT INTO session_messages (id, kind, from_session, to_session, feature_id, body, status, queued_at, attempts, last_attempt)
      VALUES ('m1', 'instruction', 'coord', 's1', 1, 'do it', 'queued', 5, 3, 'turn')`).run();
    const tablesBefore = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    let err: unknown;
    try {
      migrate(db);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationOrderError);
    expect((err as MigrationOrderError).found).toBe(M);
    expect((err as Error).message).not.toMatch(/duplicate column/);
    // 一点都没改：版本、表结构、行都和之前一样。
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: M });
    expect(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(tablesBefore);
    expect(db.prepare("SELECT attempts, last_attempt FROM session_messages").get()).toEqual({ attempts: 3, last_attempt: "turn" });
  });

  it("refuses when only some of the columns are already there", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < M; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${M}`);
    db.exec("ALTER TABLE session_messages ADD COLUMN Attempts INTEGER NOT NULL DEFAULT 0");
    expect(() => migrate(db)).toThrow(MigrationOrderError);
    expect(cols(db, "session_messages").filter((c) => /attempt/i.test(c))).toEqual(["Attempts"]);
  });

  it("openDatabase points at the newest backup from before the test build", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipherd-order-"));
    try {
      const file = writeDb(join(dir, "app.db"), [...MIGRATIONS.slice(0, M - 1), MIGRATIONS[M]], M);
      // 装测试版本之前（数据版本 M-3）升级时留的那份；pre-v<M> 是 openDatabase 这次刚备份的、就是这份数据本身。
      writeFileSync(join(dir, `app.db.pre-v${M - 3}`), "");
      expect(() => openDatabase(file)).toThrow(new RegExp(`app\\.db\\.pre-v${M - 3}`));
      expect(existsSync(join(dir, `app.db.pre-v${M}`))).toBe(true);
      expect(() => openDatabase(file)).not.toThrow(new RegExp(`pre-v${M}[^0-9]`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration order: which backup to point at, and when there is none (BTL-279 fourth review)", () => {
  /** 一个被分支版本按另一个顺序升到 M 的 app.db（见上面复核复现）。 */
  const branchDb = (dir: string): string => writeDb(join(dir, "app.db"), [...MIGRATIONS.slice(0, M - 1), MIGRATIONS[M]], M);
  const orderError = (file: string): MigrationOrderError => {
    try {
      openDatabase(file);
    } catch (e) {
      if (e instanceof MigrationOrderError) return e;
      throw e;
    }
    throw new Error("opened");
  };
  const inTemp = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "shipherd-order-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("points at the newest backup older than the data, never at pre-v<current> itself", () => {
    inTemp((dir) => {
      const file = join(dir, "app.db");
      expect(olderBackup(file, 10)).toBeUndefined();
      for (const v of [3, 7, 10, 12]) writeFileSync(join(dir, `app.db.pre-v${v}`), "");
      expect(olderBackup(file, 10)).toBe(join(dir, "app.db.pre-v7"));
      expect(olderBackup(file, 7)).toBe(join(dir, "app.db.pre-v3"));
      expect(olderBackup(file, 3)).toBeUndefined();
    });
  });

  it("openDatabase keeps the pre-test-build backup through pruning and points at it", () => {
    inTemp((dir) => {
      const file = branchDb(dir);
      // 每次备份后只留最新两份：pre-v<M> 和装测试版本之前的那份。
      writeFileSync(join(dir, `app.db.pre-v${M - 5}`), "");
      writeFileSync(join(dir, `app.db.pre-v${M - 2}`), "");
      const e = orderError(file);
      expect(e.backup).toBe(join(dir, `app.db.pre-v${M - 2}`));
      expect(e.message).toContain(`app.db.pre-v${M - 2}`);
      // 再打开一次（用户没换备份就又点开了）：那份照样在、照样指给它。
      expect(orderError(file).backup).toBe(join(dir, `app.db.pre-v${M - 2}`));
    });
  });

  it("with no older backup, names the data folder and says pre-v<current> is only a copy of this data, in both languages", () => {
    inTemp((dir) => {
      const file = branchDb(dir);
      try {
        for (const [locale, words] of [["zh", /数据目录在 .*只是现在这份数据的副本.*装回那个测试版本/], ["en", /data folder is .*only a copy of the current data.*go back to that test build/]] as const) {
          setLang(locale);
          const e = orderError(file);
          expect(e.backup).toBeUndefined();
          expect(e.hint).toEqual({ dir: resolve(dir), copy: `app.db.pre-v${M}`, partial: false });
          expect(e.message).toContain(resolve(dir));
          expect(e.message).toContain(`app.db.pre-v${M}`);
          expect(e.message).toMatch(words);
        }
      } finally {
        setLang("zh");
      }
    });
  });

  it("openDatabase with no copy either (the backup failed and the user chose to go on): the hint has copy null and the message never mentions one (BTL-279 fifth review, D5)", () => {
    inTemp((dir) => {
      const file = branchDb(dir);
      // 临时文件的位置是个目录：VACUUM INTO 之前就删不掉，备份失败，pre-v<M> 没写出来。
      mkdirSync(join(dir, `app.db.pre-v${M}.tmp`));
      const failures: string[] = [];
      let e: unknown;
      try {
        openDatabase(file, { onBackupFailed: (f) => (failures.push(f.backup), true) });
      } catch (x) {
        e = x;
      }
      expect(failures).toEqual([join(dir, `app.db.pre-v${M}`)]);
      expect(existsSync(join(dir, `app.db.pre-v${M}`))).toBe(false);
      expect(e).toBeInstanceOf(MigrationOrderError);
      const order = e as MigrationOrderError;
      expect(order.hint).toEqual({ dir: resolve(dir), copy: null, partial: false });
      expect(order.message).toContain(resolve(dir));
      expect(order.message).not.toMatch(/pre-v|副本/);
      // 英文也一样（第六轮复核建议 2）：只说数据目录，不提副本。
      setLang("en");
      try {
        const en = new MigrationOrderError(order.found, order.index, order.hint);
        expect(en.message).toContain(resolve(dir));
        expect(en.message).toMatch(/data folder is /);
        expect(en.message).not.toMatch(/pre-v|copy of the current data/);
      } finally {
        setLang("zh");
      }
    });
  });

  /** 分支版本把这一步排在第 M-1 步：库停在 M-1，main 的第 M-1、M 步还没跑过（D10 夹具）。 */
  const earlierBranchDb = (dir: string): string => writeDb(join(dir, "app.db"), [...MIGRATIONS.slice(0, M - 2), MIGRATIONS[M]], M - 1);
  const versionOf = (file: string): number => {
    const db = new DatabaseSync(file);
    try {
      return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    } finally {
      db.close();
    }
  };
  const backupsIn = (dir: string): string[] => readdirSync(dir).filter((n) => n.includes(".pre-v")).sort();

  it("data a branch build upgraded with this step earlier: nothing is committed, the message names the data version as it is, and the hint points at the older backup (BTL-279 fifth review D10, sixth review)", () => {
    inTemp((dir) => {
      const file = earlierBranchDb(dir);
      writeFileSync(join(dir, `app.db.pre-v${M - 4}`), "");
      const e = orderError(file);
      // 预检在任何一步提交之前就拦下：found 是现在的数据版本 M-1，不是走到这一步时的 M。
      expect([e.found, e.index]).toEqual([M - 1, M]);
      expect(e.message).toMatch(new RegExp(`(数据版本 ${M - 1}，第 ${M + 1} 步|data version ${M - 1}; the columns step ${M + 1})`));
      expect(e.backup).toBe(join(dir, `app.db.pre-v${M - 4}`));
      expect(versionOf(file)).toBe(M - 1);
      expect(backupsIn(dir)).toEqual([`app.db.pre-v${M - 1}`, `app.db.pre-v${M - 4}`].sort());
    });
  });

  it("opening it a second time keeps the pre-test-build backup and still points at it; the version never moves (BTL-279 sixth review)", () => {
    inTemp((dir) => {
      const file = earlierBranchDb(dir);
      writeFileSync(join(dir, `app.db.pre-v${M - 4}`), "");
      // 再放一份更早的：迁移失败时一份都不裁（不然 KEEP_BACKUPS=2 时这份会被裁掉）。
      writeFileSync(join(dir, `app.db.pre-v${M - 6}`), "");
      for (let n = 0; n < 3; n++) {
        const e = orderError(file);
        expect(e.backup).toBe(join(dir, `app.db.pre-v${M - 4}`));
        expect(versionOf(file)).toBe(M - 1);
        expect(backupsIn(dir)).toEqual([`app.db.pre-v${M - 1}`, `app.db.pre-v${M - 4}`, `app.db.pre-v${M - 6}`].sort());
      }
    });
  });

  it("any other migration failure prunes no backup either (BTL-279 sixth review)", () => {
    inTemp((dir) => {
      // 版本 M、session_messages 却不在：这一步报 no table（不是顺序错），迁移失败。
      const file = writeDb(join(dir, "app.db"), [...MIGRATIONS.slice(0, M), "DROP TABLE session_messages"], M);
      for (const v of [M - 3, M - 5]) writeFileSync(join(dir, `app.db.pre-v${v}`), "");
      expect(() => openDatabase(file)).toThrow(/no table session_messages/);
      expect(backupsIn(dir)).toEqual([`app.db.pre-v${M}`, `app.db.pre-v${M - 3}`, `app.db.pre-v${M - 5}`].sort());
    });
  });

  it("with no older backup in the D10 case, the copy it names is pre-v<the version as it is>, in both languages (BTL-279 sixth review, surviving mutant #18)", () => {
    inTemp((dir) => {
      const file = earlierBranchDb(dir);
      try {
        for (const [locale, words] of [["zh", /只是现在这份数据的副本/], ["en", /only a copy of the current data/]] as const) {
          setLang(locale);
          const e = orderError(file);
          expect(e.found).not.toBe(e.index);
          expect(e.hint).toEqual({ dir: resolve(dir), copy: `app.db.pre-v${M - 1}`, partial: false });
          expect(e.message).toContain(`app.db.pre-v${M - 1}`);
          expect(e.message).toMatch(words);
        }
      } finally {
        setLang("zh");
      }
    });
  });

  it("with no copy either (the user chose to upgrade without a backup), still names the data folder and mentions no copy", () => {
    const e = new MigrationOrderError(M, M, { dir: "/data/shipherd", copy: null });
    expect(e.message).toContain("/data/shipherd");
    expect(e.message).not.toMatch(/pre-v|副本/);
    expect(e.backup).toBeUndefined();
  });

  it("a checked migration line it cannot read throws instead of being skipped", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER)");
    addMissingColumns(db, [CHECKED_ADD_COLUMNS, "ALTER TABLE t ADD COLUMN b TEXT;"].join("\n"), 0);
    expect(cols(db, "t")).toEqual(["a", "b"]);
    // 格式不对的一行排在能跑的一行后面：照样报错（migrate 在事务里跑，前面加的列跟着回滚）。
    ["ALTER TABLE t ADD COLUMN c TEXT", "ALTER TABLE t DROP COLUMN b;", "UPDATE t SET a = 1;", ""].forEach((bad, i) => {
      expect(() => addMissingColumns(db, [CHECKED_ADD_COLUMNS, `ALTER TABLE t ADD COLUMN d${i} TEXT;`, bad].join("\n"), 0), bad).toThrow(/not an addColumns migration line/);
    });
    expect(() => addMissingColumns(db, [CHECKED_ADD_COLUMNS, "ALTER TABLE nope ADD COLUMN d TEXT;"].join("\n"), 0)).toThrow(/no table nope/);
  });
});

describe("checking the order before any step commits (BTL-279 sixth review)", () => {
  const base = ["CREATE TABLE t (a INTEGER, x TEXT);", "CREATE TABLE u (a INTEGER);"];
  const at = (n: number, list: readonly string[]): DatabaseSync => {
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < n; i++) db.exec(list[i]);
    db.exec(`PRAGMA user_version = ${n}`);
    return db;
  };

  it("refuses with the data version as it is when a later checked step's column is already there, and commits no earlier step", () => {
    const list = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE u (a INTEGER);", "CREATE TABLE v (a INTEGER);", addColumns("t", ["x TEXT"])];
    const db = at(2, list);
    // 版本 2 本不该有 x：是分支版本加的（直接在库上 ALTER，不是 list 里的步骤建的）。
    db.exec("ALTER TABLE t ADD COLUMN x TEXT");
    let e: unknown;
    try {
      migrate(db, undefined, list);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(MigrationOrderError);
    expect([(e as MigrationOrderError).found, (e as MigrationOrderError).index]).toEqual([2, 3]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'v'").all()).toEqual([]);
  });

  it("does not misreport when an earlier pending step rebuilds the table without that column (like #109 rebuilding session_messages before #111 adds three)", () => {
    const rebuild = "CREATE TABLE t_new (a INTEGER); INSERT INTO t_new (a) SELECT a FROM t; DROP TABLE t; ALTER TABLE t_new RENAME TO t;";
    const list = [...base, rebuild, addColumns("t", ["x TEXT", "y INTEGER"])];
    const db = at(2, list);
    db.exec("INSERT INTO t (a, x) VALUES (1, 'old')");
    expect(migrate(db, undefined, list)).toBe(4);
    expect(cols(db, "t")).toEqual(["a", "x", "y"]);
    expect(db.prepare("SELECT a, x FROM t").all()).toEqual([{ a: 1, x: null }]);
    // 重建的写法换一种（先改名再建）也一样。
    const renameFirst = ["ALTER TABLE t RENAME TO t_old; CREATE TABLE t (a INTEGER); INSERT INTO t SELECT a FROM t_old; DROP TABLE t_old;", addColumns("t", ["x TEXT"])];
    expect(() => checkMigrationOrder(at(2, [...base, ...renameFirst]), [...base, ...renameFirst], 2, 4)).not.toThrow();
  });

  it("does not misreport a table an earlier pending step creates, and leaves unreadable lines to the step itself", () => {
    const list = [...base, "CREATE TABLE w (a INTEGER);", addColumns("w", ["b TEXT"])];
    expect(migrate(at(2, list), undefined, list)).toBe(4);
    const bad = [...base, [CHECKED_ADD_COLUMNS, "UPDATE t SET a = 1;"].join("\n")];
    expect(() => checkMigrationOrder(at(2, bad), bad, 2, 3)).not.toThrow();
    expect(() => migrate(at(2, bad), undefined, bad)).toThrow(/not an addColumns migration line/);
  });

  it("only looks at the steps it is about to run", () => {
    // 第 3 步（下标 2）已经跑过、x 是它加的：从 3 起没有要跑的只加列迁移，不报。
    const list = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE u (a INTEGER);", addColumns("t", ["x TEXT"]), "CREATE TABLE v (a INTEGER);"];
    expect(() => checkMigrationOrder(at(3, list), list, 3, 4)).not.toThrow();
    expect(migrate(at(3, list), undefined, list)).toBe(4);
    // 只从 2 起查到 2（一步不跑）也不报；从 2 起查到 3 才查到它。
    const pre = at(2, base);
    pre.exec("ALTER TABLE t ADD COLUMN y TEXT");
    expect(() => checkMigrationOrder(pre, list, 2, 2)).not.toThrow();
    expect(() => checkMigrationOrder(at(2, base), list, 2, 3)).toThrow(MigrationOrderError);
  });
});

describe("checking the order against the schema version `from` should have (BTL-279 seventh review: simulated, not guessed from DDL)", () => {
  const rebuild = "CREATE TABLE t_new (a INTEGER); INSERT INTO t_new (a) SELECT a FROM t; DROP TABLE t; ALTER TABLE t_new RENAME TO t;";
  /** 复核里的场景，换成合成的列表：0 建 t，1 建 u，2（库没跑过）重建 t（DROP、RENAME TO），3 给 t 加 x、y。 */
  const list = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE u (a INTEGER);", rebuild, addColumns("t", ["x TEXT", "y INTEGER"])];
  const inTemp = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "shipherd-sim-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const schemaOf = (file: string) => {
    const db = new DatabaseSync(file);
    try {
      return { uv: db.prepare("PRAGMA user_version").get(), tables: db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(), rows: db.prepare("SELECT * FROM t").all() };
    } finally {
      db.close();
    }
  };
  const backupsIn = (dir: string): string[] => readdirSync(dir).filter((n) => n.includes(".pre-v")).sort();

  it("a table an earlier pending step rebuilds, with columns version `from` should not have: refuses before any step, changes nothing, prunes no backup (like #109 rebuilding session_messages on a 4.3.0 test database)", () => {
    inTemp((dir) => {
      // 测试版本把加 x、y 排在第 2 步：库停在 2，已经有 x、y，第 3 步（重建）没跑过。
      const file = writeDb(join(dir, "app.db"), [list[0], list[1], "ALTER TABLE t ADD COLUMN x TEXT; ALTER TABLE t ADD COLUMN y INTEGER; INSERT INTO t VALUES (1, 'kept', 7);"], 2);
      for (const v of [1]) writeFileSync(join(dir, `app.db.pre-v${v}`), "");
      const before = schemaOf(file);
      let e: unknown;
      try {
        openDatabase(file, { migrations: list });
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(MigrationOrderError);
      expect([(e as MigrationOrderError).found, (e as MigrationOrderError).index, (e as MigrationOrderError).what]).toEqual([2, 3, "column"]);
      expect((e as MigrationOrderError).backup).toBe(join(dir, "app.db.pre-v1"));
      // 一点没改：重建没跑，x、y 和里面的值都在。
      expect(schemaOf(file)).toEqual(before);
      expect(schemaOf(file).rows).toEqual([{ a: 1, x: "kept", y: 7 }]);
      // 备份一份没删（这次的 pre-v2 加上原来的）。
      expect(backupsIn(dir)).toEqual(["app.db.pre-v1", "app.db.pre-v2"]);
    });
  });

  it("a column that was there at `from`, is dropped by a rebuild and added back, is not misreported", () => {
    // 0 建 t(a, x)，1 建 u；2 重建成只有 a；3 再加 x、y：版本 2 的库本来就有 x，不报。
    const legit = ["CREATE TABLE t (a INTEGER, x TEXT);", "CREATE TABLE u (a INTEGER);", rebuild, addColumns("t", ["x TEXT", "y INTEGER"])];
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i++) db.exec(legit[i]);
    db.exec("PRAGMA user_version = 2; INSERT INTO t VALUES (1, 'old');");
    expect(migrate(db, undefined, legit)).toBe(4);
    expect(cols(db, "t")).toEqual(["a", "x", "y"]);
    expect(db.prepare("SELECT * FROM t").all()).toEqual([{ a: 1, x: null, y: null }]);
  });

  it("a table a pending step creates that is already there, though version `from` should not have it: refuses before any step, with the table wording, and leaves the data as it was (#109 infoflow_turns, #107 workflow_*)", () => {
    inTemp((dir) => {
      const withCreate = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE u (a INTEGER);", "CREATE TABLE v (a INTEGER);", "CREATE TABLE IF NOT EXISTS w (a INTEGER, b TEXT);"];
      const file = writeDb(join(dir, "app.db"), [withCreate[0], withCreate[1], "CREATE TABLE w (a INTEGER, b TEXT); INSERT INTO w VALUES (1, 'branch');"], 2);
      writeFileSync(join(dir, "app.db.pre-v1"), "");
      const before = new DatabaseSync(file);
      const tablesBefore = before.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
      before.close();
      try {
        for (const [locale, words] of [["zh", /第 4 步要建的表已经在了.*没有接着升级/], ["en", /the tables step 4 creates are already there.*did not upgrade any further/]] as const) {
          setLang(locale);
          let e: unknown;
          try {
            openDatabase(file, { migrations: withCreate });
          } catch (x) {
            e = x;
          }
          expect(e).toBeInstanceOf(MigrationOrderError);
          expect([(e as MigrationOrderError).found, (e as MigrationOrderError).index, (e as MigrationOrderError).what]).toEqual([2, 3, "table"]);
          expect((e as Error).message).toMatch(words);
          expect((e as Error).message).not.toMatch(/already exists/);
        }
      } finally {
        setLang("zh");
      }
      const after = new DatabaseSync(file);
      // 第 3 步（建 v）没提交，版本没动，w 里的行还在。
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(after.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(tablesBefore);
      expect(after.prepare("SELECT * FROM w").all()).toEqual([{ a: 1, b: "branch" }]);
      after.close();
      expect(backupsIn(dir)).toEqual(["app.db.pre-v1", "app.db.pre-v2"]);
    });
  });

  it("a table that was there at `from`, dropped and created again by a pending step, is not misreported", () => {
    const list2 = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE w (a INTEGER);", "DROP TABLE w; CREATE TABLE w (a INTEGER, b TEXT);", "ALTER TABLE t RENAME TO t_old; CREATE TABLE t (a INTEGER, c TEXT); DROP TABLE t_old;"];
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i++) db.exec(list2[i]);
    db.exec("PRAGMA user_version = 2");
    expect(migrate(db, undefined, list2)).toBe(4);
    expect(cols(db, "w")).toEqual(["a", "b"]);
  });

  it("a normal upgrade (nothing already there) never builds the simulated schema", () => {
    // 第 0 步在内存库里一跑就报错：要是模拟了，checkMigrationOrder 会抛这个。
    const poison = ["SELECT no_such_function();", "CREATE TABLE t (a INTEGER);", "CREATE TABLE w (a INTEGER);", addColumns("t", ["x TEXT"])];
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER); PRAGMA user_version = 2;");
    expect(() => checkMigrationOrder(db, poison, 2, 4)).not.toThrow();
    // 有可疑的列时才模拟（这时就跑到了那一步）。
    db.exec("ALTER TABLE t ADD COLUMN x TEXT");
    expect(() => checkMigrationOrder(db, poison, 2, 4)).toThrow(/no_such_function/);
  });

  it("the real migrations: upgrading normally from every version never builds the simulated schema (eighth review suggestion 1)", () => {
    const db = new DatabaseSync(":memory:");
    const simulatedAt: number[] = [];
    for (let from = 0; from <= MIGRATIONS.length; from++) {
      checkMigrationOrder(db, MIGRATIONS, from, MIGRATIONS.length, () => simulatedAt.push(from));
      if (from < MIGRATIONS.length) migrate(db, from + 1);
    }
    expect(simulatedAt).toEqual([]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    db.close();
    // 回调本身是通的：v63 的库已经有 attempts（像 4.3.0 测试版本），检查最后一步就会建一次模拟库，然后拦下。
    const branch = new DatabaseSync(":memory:");
    migrate(branch);
    branch.exec(`PRAGMA user_version = ${M}`);
    const sims: number[] = [];
    expect(() => checkMigrationOrder(branch, MIGRATIONS, M, MIGRATIONS.length, () => sims.push(1))).toThrow(MigrationOrderError);
    expect(sims).toEqual([1]);
    branch.close();
  });

  it("an index a pending step creates (no IF NOT EXISTS) that is already there, though version `from` should not have it: refuses before any step with the index wording, in both languages; one there at `from` or created IF NOT EXISTS is fine (eighth review suggestion 2)", () => {
    const withIndex = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE u (a INTEGER);", "CREATE TABLE v (a INTEGER);", "CREATE UNIQUE INDEX t_a ON t (a);"];
    try {
      for (const [locale, words] of [["zh", /第 4 步要建的索引已经在了.*没有接着升级/], ["en", /the indexes step 4 creates are already there.*did not upgrade any further/]] as const) {
        setLang(locale);
        const db = new DatabaseSync(":memory:");
        db.exec("CREATE TABLE t (a INTEGER); CREATE TABLE u (a INTEGER); CREATE UNIQUE INDEX t_a ON t (a); PRAGMA user_version = 2;");
        let e: unknown;
        try {
          migrate(db, undefined, withIndex);
        } catch (x) {
          e = x;
        }
        expect(e).toBeInstanceOf(MigrationOrderError);
        expect([(e as MigrationOrderError).found, (e as MigrationOrderError).index, (e as MigrationOrderError).what]).toEqual([2, 3, "index"]);
        expect((e as Error).message).toMatch(words);
        // 第 3 步（建 v）没提交。
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
        expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'v'").get()).toBeUndefined();
        db.close();
      }
    } finally {
      setLang("zh");
    }
    // 只有版本 from 之前的步骤建过这个名字才放过：待跑的前一步也建它，不算。
    const pendingToo = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE u (a INTEGER);", "CREATE INDEX t_a ON t (a); DROP INDEX t_a;", "CREATE INDEX t_a ON t (a);"];
    const db1 = new DatabaseSync(":memory:");
    db1.exec("CREATE TABLE t (a INTEGER); CREATE TABLE u (a INTEGER); CREATE INDEX t_a ON t (a); PRAGMA user_version = 2;");
    expect(() => migrate(db1, undefined, pendingToo)).toThrow(MigrationOrderError);
    expect(db1.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    // 版本 2 本来就有这个索引：重建表把它删了再建回来（像 v57 的 memory_samples_at），不报，也不模拟。名字不分大小写。
    const legit = ["CREATE TABLE t (a INTEGER); CREATE INDEX T_a ON t (a);", "CREATE TABLE u (a INTEGER);", "CREATE TABLE t_new (a INTEGER); DROP TABLE t; ALTER TABLE t_new RENAME TO t;", "CREATE INDEX t_A ON t (a);"];
    const ok = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i++) ok.exec(legit[i]);
    ok.exec("PRAGMA user_version = 2");
    const okSims: number[] = [];
    checkMigrationOrder(ok, legit, 2, 4, () => okSims.push(1));
    expect(okSims).toEqual([]);
    expect(migrate(ok, undefined, legit)).toBe(4);
  });

  it("an index created IF NOT EXISTS is checked too, or that step would do nothing and the steps before it would be skipped silently (ninth review suggestion 1, controller's call)", () => {
    // 分支版本在 v3 跑了 CREATE INDEX IF NOT EXISTS x；这里 v3 是别的迁移 Y（建 y），这条排在 v4。
    const ine = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE u (a INTEGER);", "CREATE TABLE y (a INTEGER);", "CREATE INDEX IF NOT EXISTS x ON t (a);"];
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER); CREATE TABLE u (a INTEGER); CREATE INDEX x ON t (a); PRAGMA user_version = 2;");
    let e: unknown;
    try {
      migrate(db, undefined, ine);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(MigrationOrderError);
    expect([(e as MigrationOrderError).index, (e as MigrationOrderError).what]).toEqual([3, "index"]);
    // Y 没跑也没提交。
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'y'").get()).toBeUndefined();
    db.close();
    // from 之前用 IF NOT EXISTS 建过的名字照样算建过（surviving mutant M7）：重建表带走再建回来，不模拟。
    const legit = ["CREATE TABLE t (a INTEGER); CREATE INDEX IF NOT EXISTS x ON t (a);", "CREATE TABLE u (a INTEGER);", "CREATE TABLE t_new (a INTEGER); DROP TABLE t; ALTER TABLE t_new RENAME TO t;", "CREATE INDEX IF NOT EXISTS x ON t (a);"];
    const ok = new DatabaseSync(":memory:");
    for (let i = 0; i < 2; i++) ok.exec(legit[i]);
    ok.exec("PRAGMA user_version = 2");
    const sims: number[] = [];
    checkMigrationOrder(ok, legit, 2, 4, () => sims.push(1));
    expect(sims).toEqual([]);
    expect(migrate(ok, undefined, legit)).toBe(4);
    ok.close();
  });

  it("index names in quotes or brackets, and lower-case create index, are read too (surviving mutants M3, M4)", () => {
    for (const create of ['CREATE INDEX "x" ON t (a);', "CREATE INDEX `x` ON t (a);", "CREATE INDEX [x] ON t (a);", "create unique index x on t (a);", "create index if not exists x on t (a);"]) {
      const list = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE u (a INTEGER);", "CREATE TABLE y (a INTEGER);", create];
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE t (a INTEGER); CREATE TABLE u (a INTEGER); CREATE INDEX x ON t (a); PRAGMA user_version = 2;");
      expect(() => migrate(db, undefined, list), create).toThrow(MigrationOrderError);
      expect(db.prepare("PRAGMA user_version").get(), create).toEqual({ user_version: 2 });
      db.close();
    }
  });

  it("a table created before `from`, dropped, and created again by a branch build is still checked: tables get no \"created before\" pass (surviving mutant M9)", () => {
    // 0 建 w，1 删 w；分支版本把建 w 排在第 2 步跑过了，这里第 2 步是 Y（建 y），第 3 步才建 w。
    const list = ["CREATE TABLE t (a INTEGER); CREATE TABLE w (a INTEGER);", "DROP TABLE w;", "CREATE TABLE y (a INTEGER);", "CREATE TABLE IF NOT EXISTS w (a INTEGER, b TEXT);"];
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER); CREATE TABLE w (a INTEGER, b TEXT); PRAGMA user_version = 2;");
    let e: unknown;
    try {
      migrate(db, undefined, list);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(MigrationOrderError);
    expect([(e as MigrationOrderError).index, (e as MigrationOrderError).what]).toEqual([3, "table"]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'y'").get()).toBeUndefined();
    db.close();
  });

  it("only checks up to the target (surviving mutant M11): a column a later step adds being there already does not stop migrate(db, target)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(list[0]);
    db.exec(list[1]);
    db.exec("ALTER TABLE t ADD COLUMN x TEXT; PRAGMA user_version = 2;");
    expect(migrate(db, 2, list)).toBe(2);
    expect(() => migrate(db, 4, list)).toThrow(MigrationOrderError);
  });

  it("when a later step is what finds it (some steps already committed), the copy it names is the data from before this upgrade, not a copy of the data as it is now (seventh review suggestion 1, surviving mutant M16)", () => {
    inTemp((dir) => {
      // 列表自己就重复加了 x（版本 2 本来就有）：预检放过，走到第 4 步自己的检查才拦下，第 3 步已经提交。
      const odd = ["CREATE TABLE t (a INTEGER);", addColumns("t", ["x TEXT"]), "CREATE TABLE v (a INTEGER);", addColumns("t", ["x TEXT"])];
      const file = join(dir, "app.db");
      try {
        for (const [locale, words, not] of [
          ["zh", /app\.db\.pre-v2 是这次升级前的数据/, /只是现在这份数据的副本/],
          ["en", /app\.db\.pre-v2 in it is the data from before this upgrade/, /only a copy of the current data/],
        ] as const) {
          setLang(locale);
          // 每种语言都从头来：上一次已经把第 3 步提交了、还留了 pre-v2。
          for (const f of ["app.db", "app.db-wal", "app.db-shm", "app.db.pre-v2"]) rmSync(join(dir, f), { force: true });
          writeDb(file, odd.slice(0, 2), 2);
          let e: unknown;
          try {
            openDatabase(file, { migrations: odd });
          } catch (x) {
            e = x;
          }
          expect(e).toBeInstanceOf(MigrationOrderError);
          const order = e as MigrationOrderError;
          expect([order.found, order.index]).toEqual([3, 3]);
          expect(order.hint).toEqual({ dir: resolve(dir), copy: "app.db.pre-v2", partial: true });
          expect(order.message).toMatch(words);
          expect(order.message).not.toMatch(not);
          expect(order.message).toMatch(locale === "zh" ? /数据版本 3，第 4 步/ : /data version 3; the columns step 4/);
        }
      } finally {
        setLang("zh");
      }
    });
  });

  it("the first sentence says it did not upgrade any further, in both languages (surviving mutant M17)", () => {
    try {
      setLang("zh");
      expect(new MigrationOrderError(5, 6).message).toMatch(/所以没有接着升级。$/);
      setLang("en");
      expect(new MigrationOrderError(5, 6).message).toMatch(/so Shipherd did not upgrade any further\.$/);
    } finally {
      setLang("zh");
    }
  });

  it("a failed backup the user chose to go on past: the upgrade succeeds and no old backup is pruned (surviving mutant M12)", () => {
    inTemp((dir) => {
      const plain = ["CREATE TABLE t (a INTEGER);", "CREATE TABLE u (a INTEGER);", "CREATE TABLE v (a INTEGER);", "CREATE TABLE w (a INTEGER);", "CREATE TABLE x (a INTEGER);"];
      const file = writeDb(join(dir, "app.db"), plain.slice(0, 4), 4);
      // 三份旧的，比 KEEP_BACKUPS（2）多：要是裁了，pre-v1 就没了。
      for (const v of [1, 2, 3]) writeFileSync(join(dir, `app.db.pre-v${v}`), "");
      // 这一份的临时文件位置是个目录：备份失败。
      mkdirSync(join(dir, "app.db.pre-v4.tmp"));
      const db = openDatabase(file, { migrations: plain, onBackupFailed: () => true });
      db.close();
      expect(versionOfFile(file)).toBe(5);
      // 一份都没裁：备份没成功，这次不裁。
      expect(backupsIn(dir).filter((n) => !n.endsWith(".tmp"))).toEqual(["app.db.pre-v1", "app.db.pre-v2", "app.db.pre-v3"]);
    });
  });
});

const versionOfFile = (file: string): number => {
  const db = new DatabaseSync(file);
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

describe("startupErrorText (the startup failure dialog)", () => {
  it("gives the user's own sentence for data errors, and the stack for anything else", () => {
    const order = new MigrationOrderError(64, 64, { dir: "/d", copy: null });
    expect(startupErrorText(order)).toBe(order.message);
    expect(startupErrorText(order)).not.toMatch(/\n\s+at /);
    const newer = new NewerDatabaseError(70, 64);
    expect(startupErrorText(newer)).toBe(newer.message);
    const backup = Object.create(DatabaseBackupError.prototype) as DatabaseBackupError;
    Object.defineProperty(backup, "message", { value: "备份失败" });
    expect(startupErrorText(backup)).toBe("备份失败");
    const other = new Error("boom");
    expect(startupErrorText(other)).toBe(other.stack);
    expect(startupErrorText("plain")).toBe("plain");
  });
});

describe("addColumns", () => {
  it("writes plain SQL that also runs as is", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a INTEGER)");
    db.exec(addColumns("t", ["b TEXT", "c INTEGER NOT NULL DEFAULT 0"]));
    expect(cols(db, "t")).toEqual(["a", "b", "c"]);
  });

  it("refuses what it cannot run column by column", () => {
    expect(() => addColumns("t; DROP TABLE x", ["b TEXT"])).toThrow(/bad/);
    expect(() => addColumns("t", [])).toThrow(/bad/);
    expect(() => addColumns("t", ["b TEXT; DROP TABLE x"])).toThrow(/bad/);
    expect(() => addColumns("t", ["b"])).toThrow(/bad/);
  });
});
