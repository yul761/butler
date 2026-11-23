import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeMigrate, backupPath, type OnBackupFailed } from "./backup";
import { MIGRATIONS } from "./migrations";
import { M } from "../strings";

export type Db = DatabaseSync;
export { DatabaseBackupError } from "./backup";

export interface OpenDatabaseOptions {
  log?: (msg: string) => void;
  /** 迁移前的备份失败了怎么办（见 backup.ts 的 OnBackupFailed）：不给就不迁移、抛 DatabaseBackupError。 */
  onBackupFailed?: OnBackupFailed;
}

const userVersion = (db: Db): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

/**
 * 打开数据库并迁移到最新版本。要迁移时（数据版本在 1 和最新之间），先备份一份 app.db.pre-v<当前版本>（BTL-262）；
 * 新建的空库（版本 0）和内存库不备份。
 */
export function openDatabase(file: string, o: OpenDatabaseOptions = {}): Db {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const current = userVersion(db);
    if (current > MIGRATIONS.length) {
      const backup = backupPath(file, MIGRATIONS.length);
      throw new NewerDatabaseError(current, MIGRATIONS.length, file !== ":memory:" && existsSync(backup) ? backup : undefined);
    }
    if (current > 0 && current < MIGRATIONS.length && file !== ":memory:") {
      backupBeforeMigrate(db, file, current, { log: o.log, onBackupFailed: o.onBackupFailed, failedMessage: (f) => M().databaseBackupFailed(f.backup, f.reason, f.diskFull) });
    }
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** 数据库比这个版本的 Shipherd 新（装回了旧版本）：不能在不认识的表结构上运行。有这个版本能认的迁移前备份时，告诉用户它在哪。 */
export class NewerDatabaseError extends Error {
  constructor(readonly found: number, readonly known: number, readonly backup?: string) {
    super(M().newerDatabase(found, known) + (backup ? ` ${M().newerDatabaseBackup(backup)}` : ""));
  }
}

export function migrate(db: Db): number {
  const current = userVersion(db);
  if (current > MIGRATIONS.length) throw new NewerDatabaseError(current, MIGRATIONS.length);
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return MIGRATIONS.length;
}

let savepointSeq = 0;

/**
 * 同步事务：fn 抛错时整体回滚。fn 里不能有 await。
 * 可重入：已经在事务里就用 SAVEPOINT，内层抛错只回滚内层的写入（外层 catch 后继续也不会提交内层的残留），
 * 然后继续抛出。最外层负责 COMMIT / ROLLBACK。
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const sp = `sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      return result;
    } catch (e) {
      if (db.isTransaction) {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
      }
      throw e;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    // SQLite 可能已经自动回滚（如 SQLITE_FULL）；此时再 ROLLBACK 会抛错并盖掉原始错误。
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
