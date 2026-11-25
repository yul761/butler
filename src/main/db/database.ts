import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
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
  const db = cacheStatements(new DatabaseSync(file));
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

const uncached = new WeakMap<Db, (sql: string) => StatementSync>();

/** 不走语句缓存、单独编译一条（cacheStatements 包过的连接；没包过的就是 db.prepare）：给读的时候会回调外面的 iterate 用。 */
export function prepareUncached(db: Db, sql: string): StatementSync {
  return (uncached.get(db) ?? ((q: string) => db.prepare(q)))(sql);
}

/** 每个连接最多留这么多条编译好的语句（拼出来的 SQL 不会把内存撑满）。 */
export const STATEMENT_CACHE_MAX = 512;

/** 绑定的参数超过这么大（文本按字符、blob 按字节），这条语句跑完就不留在缓存里（见 cacheStatements）。 */
export const LARGE_PARAM_BYTES = 4096;

const isLarge = (v: unknown): boolean =>
  (typeof v === "string" && v.length > LARGE_PARAM_BYTES) || (ArrayBuffer.isView(v) && v.byteLength > LARGE_PARAM_BYTES);

/** 位置参数，或者第一个参数是命名参数的对象（node:sqlite 两种都收）。 */
function hasLargeParam(args: unknown[]): boolean {
  for (const a of args) {
    if (isLarge(a)) return true;
    if (a !== null && typeof a === "object" && !ArrayBuffer.isView(a) && Object.values(a).some(isLarge)) return true;
  }
  return false;
}

/**
 * 编译好的语句按 SQL 文本留着重用（BTL-265）：node:sqlite 不缓存，每次 db.prepare 都要重新编译，
 * 首页一次刷新几百次查询，一半的时间花在编译上。最近用过的留 STATEMENT_CACHE_MAX 条。
 * 重用同一个 StatementSync 是安全的：all / get / run 同步跑完，开头都会重置语句；iterate 用 for-of 读，break / return 也会重置。
 * 不要拿着读了一半的 iterate 去查同一条 SQL（会被重置），也不要在缓存的语句上改选项（setReadBigInts 之类会留给下一个用的人）：带选项的 prepare 不走缓存。
 * iterate 的循环体里会调外面传进来的回调（说不定又查同一条 SQL）时，用 prepareUncached。
 * node:sqlite 跑完不清绑定（也没有 clearBindings），缓存的语句会一直留着最后一次的参数：哪次带了大参数
 *（超过 LARGE_PARAM_BYTES 的文本或 blob，比如 handoff 的 raw_text、json_each(?) 的长列表），跑完就把这条踢出缓存，参数随语句一起释放。
 */
export function cacheStatements(db: Db): Db {
  const raw = db.prepare.bind(db) as (sql: string, ...rest: unknown[]) => StatementSync;
  uncached.set(db, raw);
  const cache = new Map<string, StatementSync>();
  const dropIfLarge = (sql: string, s: StatementSync): void => {
    for (const m of ["run", "get", "all", "iterate"] as const) {
      const f = s[m].bind(s) as (...a: unknown[]) => unknown;
      (s as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        const r = f(...a);
        if (cache.get(sql) === s && hasLargeParam(a)) cache.delete(sql);
        return r;
      };
    }
  };
  const prepare = (sql: string, ...rest: unknown[]): StatementSync => {
    if (rest.length > 0) return raw(sql, ...rest);
    const hit = cache.get(sql);
    if (hit) {
      // 挪到最后：Map 的顺序就是最近用过的顺序。
      cache.delete(sql);
      cache.set(sql, hit);
      return hit;
    }
    const s = raw(sql);
    dropIfLarge(sql, s);
    cache.set(sql, s);
    if (cache.size > STATEMENT_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return s;
  };
  db.prepare = prepare as Db["prepare"];
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
