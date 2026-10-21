import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: Db): number {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
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

/**
 * 同步事务：fn 抛错时整体回滚。fn 里不能有 await。
 * 可重入：已经在事务里（例如 SessionsRepo.delete 被包在另一个 withTransaction 里）就直接执行 fn，
 * 由最外层负责 COMMIT / ROLLBACK（SQLite 没有嵌套 BEGIN）。
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
