import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addMissingColumns, DatabaseBackupError, MigrationOrderError, migrate, NewerDatabaseError, olderBackup, openDatabase, startupErrorText } from "./database";
import { CHECKED_ADD_COLUMNS } from "./migrations";
import { setLang } from "../i18n";
import { addColumns, MIGRATIONS } from "./migrations";
import { SessionMessagesRepo } from "./session-messages-repo";

/** BTL-279 的迁移：session_messages 记试着送了几次、最后一次什么时候、结果是什么（诊断导出、消息列表里看得到）。 */
const M = MIGRATIONS.findIndex((m) => m.includes("session_messages ADD COLUMN attempts"));

const cols = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("mailbox attempts migration (BTL-279)", () => {
  it("is the last migration and upgrades the database before it without touching its rows", () => {
    // 4.3.0 的迁移顺序：BTL-279 排在最后，rebase 时挪到数组末尾。
    expect(M).toBe(MIGRATIONS.length - 1);
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let i = 0; i < M; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${M}`);
    db.prepare(`INSERT INTO session_messages (id, kind, from_session, to_session, feature_id, body, status, queued_at, blocked_reason, blocked_since)
      VALUES ('m1', 'instruction', 'coord', 's1', 1, 'do it', 'queued', 5, 'turn', 6)`).run();

    expect(migrate(db)).toBe(MIGRATIONS.length);
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
      const file = join(dir, "app.db");
      const db = new DatabaseSync(file);
      for (let i = 0; i < M - 1; i++) db.exec(MIGRATIONS[i]);
      db.exec(MIGRATIONS[M]);
      db.exec(`PRAGMA user_version = ${M}`);
      db.close();
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
  const branchDb = (dir: string): string => {
    const file = join(dir, "app.db");
    const db = new DatabaseSync(file);
    for (let i = 0; i < M - 1; i++) db.exec(MIGRATIONS[i]);
    db.exec(MIGRATIONS[M]);
    db.exec(`PRAGMA user_version = ${M}`);
    db.close();
    return file;
  };
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
          expect(e.hint).toEqual({ dir: resolve(dir), copy: `app.db.pre-v${M}` });
          expect(e.message).toContain(resolve(dir));
          expect(e.message).toContain(`app.db.pre-v${M}`);
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
