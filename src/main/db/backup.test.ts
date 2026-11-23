import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { describeBackupError, KEEP_BACKUPS } from "./backup";
import { DatabaseBackupError, NewerDatabaseError, openDatabase } from "./database";
import { MIGRATIONS } from "./migrations";

const LATEST = MIGRATIONS.length;

/** 一个停在 version 的库（真实地跑到那一步的迁移），带一张探针表，看备份里的数据对不对。 */
function dbAt(dir: string, version: number, name = "app.db"): string {
  const file = join(dir, name);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  for (let i = 0; i < Math.min(version, LATEST); i++) db.exec(MIGRATIONS[i]);
  db.exec(`PRAGMA user_version = ${version}`);
  db.exec("CREATE TABLE probe (v TEXT); INSERT INTO probe VALUES ('kept')");
  db.close();
  return file;
}

const versionOf = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

const backups = (dir: string): string[] => readdirSync(dir).filter((n) => n.includes(".pre-v")).sort();

describe("openDatabase: backup before migrating (BTL-262)", () => {
  it("backs up app.db.pre-v<old version> with the old data, then migrates app.db to the latest", () => {
    const dir = tempDir("shipherd-backup-");
    const file = dbAt(dir, LATEST - 1);
    const logs: string[] = [];
    openDatabase(file, { log: (m) => logs.push(m) }).close();
    expect(backups(dir)).toEqual([`app.db.pre-v${LATEST - 1}`]);
    const backup = join(dir, `app.db.pre-v${LATEST - 1}`);
    expect(versionOf(backup)).toBe(LATEST - 1);
    expect(versionOf(file)).toBe(LATEST);
    const b = new DatabaseSync(backup, { readOnly: true });
    expect(b.prepare("SELECT v FROM probe").get()).toEqual({ v: "kept" });
    b.close();
    if (process.platform !== "win32") expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(logs.some((l) => l.includes(`backed up version ${LATEST - 1}`))).toBe(true);
  });

  it("a new database (version 0), one already at the latest version, and :memory: are not backed up", () => {
    const dir = tempDir("shipherd-backup-");
    openDatabase(join(dir, "app.db")).close();
    expect(backups(dir)).toEqual([]);
    openDatabase(join(dir, "app.db")).close();
    expect(backups(dir)).toEqual([]);
    openDatabase(":memory:").close();
  });

  it(`keeps only the latest ${KEEP_BACKUPS} backups by version, and leaves other files alone`, () => {
    const dir = tempDir("shipherd-backup-");
    const file = dbAt(dir, LATEST - 1);
    const mine = ["app.db.pre-v3", "app.db.pre-v12", "app.db.pre-v9", "app.db.pre-v4.tmp"];
    const theirs = ["app.db.pre-vx", "other.db.pre-v1", "app.db.pre-v2.keep", "app.db.pre-v2.tmp.keep", "my app.db.pre-v1", "app.db.pre-v.tmp"];
    for (const n of [...mine, ...theirs]) writeFileSync(join(dir, n), "");
    openDatabase(file).close();
    // 留下版本最大的两份；中断留下的 .tmp 删掉；不是自己命名的文件原样留着。
    expect(backups(dir)).toEqual(["app.db.pre-v12", `app.db.pre-v${LATEST - 1}`, ...theirs].sort());
  });

  it("an existing backup of the same version is replaced, and no temporary file is left", () => {
    const dir = tempDir("shipherd-backup-");
    const file = dbAt(dir, LATEST - 1);
    writeFileSync(join(dir, `app.db.pre-v${LATEST - 1}`), "stale");
    openDatabase(file).close();
    expect(versionOf(join(dir, `app.db.pre-v${LATEST - 1}`))).toBe(LATEST - 1);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("works in a folder whose path has spaces and a quote", () => {
    const dir = join(tempDir("shipherd-backup-"), "it's my data");
    mkdirSync(dir);
    const file = dbAt(dir, LATEST - 1);
    openDatabase(file).close();
    expect(versionOf(join(dir, `app.db.pre-v${LATEST - 1}`))).toBe(LATEST - 1);
  });

  describe("when the backup fails", () => {
    /** 临时文件的位置被一个目录占着：VACUUM INTO 写不进去（两个平台都一样）。 */
    const blocked = (): { dir: string; file: string } => {
      const dir = tempDir("shipherd-backup-");
      const file = dbAt(dir, LATEST - 1);
      mkdirSync(join(dir, `app.db.pre-v${LATEST - 1}.tmp`));
      writeFileSync(join(dir, `app.db.pre-v${LATEST - 1}.tmp`, "x"), "");
      return { dir, file };
    };

    it("without anyone to ask, does not migrate and says why", () => {
      const { file } = blocked();
      let err: unknown;
      try {
        openDatabase(file);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DatabaseBackupError);
      expect((err as DatabaseBackupError).declined).toBe(false);
      expect((err as Error).message).toContain(`app.db.pre-v${LATEST - 1}`);
      // 没有迁移；库已经关掉，可以再打开。
      expect(versionOf(file)).toBe(LATEST - 1);
    });

    it("asks; quitting leaves the data untouched", () => {
      const { file } = blocked();
      const asked: unknown[] = [];
      expect(() => openDatabase(file, { onBackupFailed: (f) => (asked.push(f), false) })).toThrow(DatabaseBackupError);
      expect(asked).toEqual([expect.objectContaining({ backup: `${file}.pre-v${LATEST - 1}`, diskFull: false })]);
      try {
        openDatabase(file, { onBackupFailed: () => false });
      } catch (e) {
        expect((e as DatabaseBackupError).declined).toBe(true);
      }
      expect(versionOf(file)).toBe(LATEST - 1);
    });

    it("asks; continuing migrates without a backup and logs it", () => {
      const { dir, file } = blocked();
      const logs: string[] = [];
      openDatabase(file, { log: (m) => logs.push(m), onBackupFailed: () => true }).close();
      expect(versionOf(file)).toBe(LATEST);
      expect(existsSync(join(dir, `app.db.pre-v${LATEST - 1}`))).toBe(false);
      expect(logs.some((l) => l.includes("failed"))).toBe(true);
      expect(logs.some((l) => l.includes("without a backup"))).toBe(true);
    });
  });

  it("recognises a full disk (SQLITE_FULL, ENOSPC)", () => {
    expect(describeBackupError(Object.assign(new Error("database or disk is full"), { errcode: 13, errstr: "database or disk is full" }))).toEqual({ reason: "database or disk is full", diskFull: true });
    expect(describeBackupError(Object.assign(new Error("no space"), { code: "ENOSPC" }))).toEqual({ reason: "ENOSPC", diskFull: true });
    expect(describeBackupError(Object.assign(new Error("denied"), { code: "EACCES" })).diskFull).toBe(false);
  });

  it("a database from a newer Shipherd points at the backup this version can open", () => {
    const dir = tempDir("shipherd-backup-");
    const file = dbAt(dir, LATEST + 1);
    writeFileSync(join(dir, `app.db.pre-v${LATEST}`), "");
    let err: unknown;
    try {
      openDatabase(file);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NewerDatabaseError);
    expect((err as NewerDatabaseError).backup).toBe(`${file}.pre-v${LATEST}`);
    expect((err as Error).message).toContain(`app.db.pre-v${LATEST}`);
  });
});
