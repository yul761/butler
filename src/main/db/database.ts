import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";
import { M } from "../strings";

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** 数据库比这个版本的 Butler 新（装回了旧版本）：不能在不认识的表结构上运行。 */
export class NewerDatabaseError extends Error {
  constructor(readonly found: number, readonly known: number) {
    super(M().newerDatabase(found, known));
  }
}

export function migrate(db: Db): number {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
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
