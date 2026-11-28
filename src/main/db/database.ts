import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { basename, dirname, resolve } from "node:path";
import { backupBeforeMigrate, backupPath, DatabaseBackupError, KEEP_BACKUPS, pruneBackups, type OnBackupFailed } from "./backup";
import { CHECKED_ADD_COLUMNS, MIGRATIONS } from "./migrations";
import { M } from "../strings";

export type Db = DatabaseSync;
export { DatabaseBackupError };

export interface OpenDatabaseOptions {
  log?: (msg: string) => void;
  /** 迁移前的备份失败了怎么办（见 backup.ts 的 OnBackupFailed）：不给就不迁移、抛 DatabaseBackupError。 */
  onBackupFailed?: OnBackupFailed;
  /** 迁移列表，只给测试用（默认 MIGRATIONS）：拿合成的列表走一遍 openDatabase 的备份、报错和裁剪。 */
  migrations?: readonly string[];
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
    const list = o.migrations ?? MIGRATIONS;
    const current = userVersion(db);
    if (current > list.length) {
      const backup = backupPath(file, list.length);
      throw new NewerDatabaseError(current, list.length, file !== ":memory:" && existsSync(backup) ? backup : undefined);
    }
    let backedUp = false;
    if (current > 0 && current < list.length && file !== ":memory:") {
      backedUp = backupBeforeMigrate(db, file, current, { log: o.log, onBackupFailed: o.onBackupFailed, failedMessage: (f) => M().databaseBackupFailed(f.backup, f.reason, f.diskFull) });
    }
    try {
      migrate(db, undefined, list);
    } catch (e) {
      // 迁移顺序对不上：指给用户装测试版本之前的那份备份（比现在版本旧、最新的一份；刚才那份 pre-v<current> 就是这份数据本身）。
      if (!(e instanceof MigrationOrderError) || file === ":memory:") throw e;
      const backup = olderBackup(file, current);
      // 找不到更早的（第四轮复核）：说清数据目录在哪、pre-v<current> 是什么，让用户有下一步可走。预检拦下时一步都没提交，
      // 它就是现在这份数据的副本；走到后面某一步才拦下（e.found 比 current 新，第七轮复核建议 1）时，它是这次升级前的数据。
      const copy = backupPath(file, current);
      const hint = backup !== undefined ? { backup } : { dir: dirname(resolve(file)), copy: existsSync(copy) ? basename(copy) : null, partial: e.found !== current };
      throw new MigrationOrderError(e.found, e.index, hint, e.what);
    }
    // 迁移成功了才裁旧备份（BTL-279 第六轮）：失败时（不管什么错）一份都不删，装测试版本之前的那份不会被这次和下次启动的备份挤掉。
    if (backedUp) pruneBackups(file, KEEP_BACKUPS, o.log ?? (() => undefined));
    // WAL 下 NORMAL 是安全的（BTL-275）：断电最多丢最后几次提交，库不会坏；FULL 每次自动提交都在主线程 fsync 一次。
    // 迁移完才改：迁移和它前面的备份照旧在 FULL 下跑，备份自己还另外 fsync（backup.ts）。
    db.exec("PRAGMA synchronous = NORMAL;");
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/**
 * 比 current 旧、版本号最大的那份迁移前备份（MigrationOrderError 指给用户的）；没有就是 undefined。
 * 迁移成功后只留最新两份（KEEP_BACKUPS），平时这里最多看到一份；迁移失败、或者备份失败用户选了不备份接着升时不裁，可能有好几份。
 */
export function olderBackup(file: string, current: number): string | undefined {
  for (let v = current - 1; v > 0; v--) if (existsSync(backupPath(file, v))) return backupPath(file, v);
  return undefined;
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

/**
 * 把数据库升到 target（默认最新）。target 只给测试用：单独看某一条迁移改了什么，不被后面合进来的迁移带上（4.3.0 rebase 时
 * BTL-270 的「别的表没动」被 BTL-279 后加的 session_messages 列弄红过）。
 */
export function migrate(db: Db, target?: number, list: readonly string[] = MIGRATIONS): number {
  const end = target ?? list.length;
  const current = userVersion(db);
  if (current > list.length) throw new NewerDatabaseError(current, list.length);
  if (!Number.isInteger(end) || end < current || end > list.length) throw new Error(`migrate target ${end} outside ${current}..${list.length}`);
  // 先把要跑的步骤要加的列、要建的表都查一遍，再提交任何一步（BTL-279 第六、七轮）：每一步各自提交，走到一半才发现顺序不对的话，
  // 前面几步已经升上去了，提示里的「没有升级」就不成立，下次启动的备份还会把装测试版本之前的那份挤掉。
  checkMigrationOrder(db, list, current, end);
  for (let i = current; i < end; i++) {
    // 重建表（改 CHECK）的迁移要 DROP 别的表外键指着的表：外键只能在事务外关，提交前查一遍有没有这条迁移新造成的违规。
    const fkOff = list[i].includes(FOREIGN_KEYS_OFF) && fkOn(db);
    if (fkOff) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN");
      try {
        const violations = fkOff ? fkViolations(db) : 0;
        if (list[i].startsWith(CHECKED_ADD_COLUMNS)) addMissingColumns(db, list[i], i);
        else db.exec(list[i]);
        if (fkOff && fkViolations(db) > violations) throw new Error(`migration ${i + 1} broke foreign keys`);
        db.exec(`PRAGMA user_version = ${i + 1}`);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      if (fkOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
  return end;
}

/** 迁移里新建的表（CREATE TABLE [IF NOT EXISTS] 后面的名字；TEMP 表不在库里留下，不算）。 */
const CREATE_TABLE = /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["'`[]?(\w+)/gi;
/**
 * 迁移里新建的索引（CREATE [UNIQUE] INDEX [IF NOT EXISTS] 后面的名字）。带 IF NOT EXISTS 的也算（第九轮复核，总控定，和表一致）：
 * 它已经在了时这一步什么都不做、照样提交，排在它前面的迁移就被悄悄跳过了；不带的反倒有 SQLite 的 already exists 兜底。
 * 也用来看版本 from 之前的迁移有没有建过这个名字。
 * 和 CREATE_TABLE 一样只是正则：迁移里注释或字符串中的「CREATE INDEX x」字样也会被认成建索引，待跑的步骤里是误报，
 * from 之前的步骤里是把一个名字当成建过、筛掉了。真要这么写时改成别的字样。
 */
const CREATE_INDEX = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?(\w+)/gi;

/**
 * 预检（BTL-279 第六、七轮）：从 from 升到 to 之前，一步都还没提交时，先查这份数据是不是被迁移顺序不同的版本动过。
 * 待跑的只加列迁移要加的列、待跑的迁移要 CREATE 的表，现在的库里已经有了，而照这份迁移列表升到版本 from 本不该有：
 * 抛 MigrationOrderError（found 是现在的数据版本 from）。
 * 「版本 from 本该有的表结构」是在内存库里把 list[0..from) 跑一遍得到的，不靠解析 SQL 猜哪些表会被后面的步骤重建
 *（第七轮复核：#109 先合时它重建 session_messages，按 DDL 跳过这张表会漏掉 4.3.0 测试版本加过的 attempts 三列，
 * 重建把它们丢掉、BTL-270 永远不跑）。正常升级时库里没有这种列和表，不跑模拟。
 * 以前有过、被后面的步骤删掉再加回来的列和表，版本 from 时本来就有，不误报。
 * CREATE INDEX 要建的索引也一样查（第八轮复核建议 2；带不带 IF NOT EXISTS 都查，第九轮），但只查 list[0..from) 里从没建过的名字：
 * 重建表的迁移 DROP TABLE 会带走索引、再 CREATE INDEX 同名的建回来（v57 重建 memory_samples 和 memory_samples_at），
 * 不先筛一下，从 v30–v56 正常升级的库每次都要跑一遍模拟。分支版本新加的索引都是新名字，照样查得到。
 *
 * 已知限制（查不到的写法，第八轮复核）：
 * - ALTER TABLE … RENAME TO 的目标已经在了；不是 addColumns 写的普通 ALTER TABLE … ADD COLUMN，要加的列已经在了。
 *   这两种照旧在那一步报 SQLite 自己的错、回滚那一步，前面的步骤已经提交了。
 * - CREATE VIRTUAL TABLE；带 main. 之类库名前缀的表名、索引名。
 * - 分支版本建了一个 list[0..from) 里建过、后来又删掉的同名索引（包括 DROP TABLE 时顺带删掉的索引）。表不这样筛，建过又删掉的同名表照样查。
 * - 只查已经在了的，不查缺了的（比如开过一个多了迁移的分支版本，再用没合那个分支的版本打开）：另开 ticket。
 * - 运行时建的表不在模拟里：conv_fts（conv-repo.ts 建的 FTS5 虚表）和它的影子表 conv_fts_data、conv_fts_idx 等。
 *   以后哪条迁移要用 CREATE TABLE 建同名的表，正常升级上来的库也会被误报成顺序不对。
 * onSimulate 只给测试用：每建一次模拟库调一次（守着「正常升级不建模拟库」）。
 */
export function checkMigrationOrder(db: Db, list: readonly string[], from: number, to: number, onSimulate?: () => void): void {
  const colsOf = (d: Db, t: string): Set<string> => new Set((d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name.toLowerCase()));
  const has = (d: Db, type: "table" | "index", name: string): boolean =>
    d.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? COLLATE NOCASE").get(type, name) !== undefined;
  const have = new Map<string, Set<string>>();
  let indexedBefore: Set<string> | undefined;
  const indexCreatedBefore = (name: string): boolean => {
    indexedBefore ??= new Set(list.slice(0, from).flatMap((sql) => [...sql.matchAll(CREATE_INDEX)].map((m) => m[1].toLowerCase())));
    return indexedBefore.has(name.toLowerCase());
  };
  let expected: DatabaseSync | undefined;
  const expectedDb = (): DatabaseSync => {
    if (!expected) {
      onSimulate?.();
      expected = new DatabaseSync(":memory:");
      // 重建表的迁移要 DROP 被外键指着的表：内存库里没有数据，关掉外键照着跑就行。
      expected.exec("PRAGMA foreign_keys = OFF");
      for (let k = 0; k < from; k++) expected.exec(list[k]);
    }
    return expected;
  };
  try {
    for (let i = from; i < to; i++) {
      if (!list[i].startsWith(CHECKED_ADD_COLUMNS)) {
        for (const [re, type] of [[CREATE_TABLE, "table"], [CREATE_INDEX, "index"]] as const) {
          for (const m of list[i].matchAll(re)) {
            if (!has(db, type, m[1]) || (type === "index" && indexCreatedBefore(m[1]))) continue;
            if (!has(expectedDb(), type, m[1])) throw new MigrationOrderError(from, i, undefined, type);
          }
        }
        continue;
      }
      for (const line of list[i].split("\n").slice(1)) {
        const m = ADD_COLUMN.exec(line);
        // 认不出来的行、不存在的表：留给那一步自己报错。
        if (!m) continue;
        const t = m[1].toLowerCase();
        let cols = have.get(t);
        if (!cols) have.set(t, (cols = colsOf(db, t)));
        if (cols.has(m[2].toLowerCase()) && !colsOf(expectedDb(), t).has(m[2].toLowerCase())) throw new MigrationOrderError(from, i);
      }
    }
  } finally {
    expected?.close();
  }
}

/** addColumns 生成的那一行一条 ALTER TABLE … ADD COLUMN（名字只认 \\w）。 */
const ADD_COLUMN = /^ALTER TABLE (\w+) ADD COLUMN (\w+)\s+[^;\n]+;$/;

/** MigrationOrderError 说的是哪种已经在了：列、表还是索引。 */
export type MigrationOrderWhat = "column" | "table" | "index";

/**
 * 迁移顺序和这份数据走过的不一样（4.3.0 复核）：数据版本 found 还没到第 index+1 条，它要加的列、要建的表或索引（what）却已经在了，
 * 说明装过把这条排在更前面的测试版本（表是第七轮、索引是第八轮加的，见 checkMigrationOrder）。那个版本在这个位置跑的是这条，现在排在它前面的别的迁移这份数据就没跑过；接着升级会悄悄跳过它们，之后查询才出错。
 * 宁可起不来：告诉用户换回装测试版本之前的备份。
 */
export class MigrationOrderError extends Error {
  /** 指给用户的备份（比现在版本旧、最新的一份）。 */
  readonly backup?: string;
  /**
   * hint：找到了更早的备份就是 { backup }；没找到就是数据目录和 pre-v<打开时的版本>（这次刚备份的）的文件名。
   * partial：走到后面某一步才发现、前面几步已经提交了（found 比打开时的版本新），那份副本是这次升级前的数据，不是现在这份。
   * migrate 自己抛的没有 hint（它不知道文件在哪），openDatabase 补上再抛。
   */
  constructor(
    readonly found: number,
    readonly index: number,
    readonly hint?: { backup: string } | { dir: string; copy: string | null; partial?: boolean },
    /** 已经在了的是这一步要加的列、要建的表（第七轮，总控定：#109、#107 新建的表也查），还是要建的索引（第八轮）。 */
    readonly what: MigrationOrderWhat = "column",
  ) {
    super(
      M().migrationOrder(found, index + 1, what) +
        (!hint ? "" : "backup" in hint ? ` ${M().migrationOrderBackup(hint.backup)}` : ` ${M().migrationOrderNoBackup(hint.dir, hint.copy, hint.partial === true)}`),
    );
    if (hint && "backup" in hint) this.backup = hint.backup;
  }
}

/**
 * 启动失败时对话框里的那句话（BTL-262、4.3.0 复核）：数据比程序新、迁移顺序对不上、备份失败是给用户看的，只给它们自己的话，不贴调用栈；
 * 别的错误给调用栈（报 bug 用）。
 */
export function startupErrorText(e: unknown): string {
  if (e instanceof NewerDatabaseError || e instanceof DatabaseBackupError || e instanceof MigrationOrderError) return e.message;
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

/**
 * addColumns 写的迁移：先逐列查 PRAGMA table_info，再加。不是 addColumns 的格式就报错，不能把认不出来的一行跳过。
 * 照现在的顺序升上来的库，这几列不会已经在（同一列只有这一条加）；已经在了就是迁移顺序不同的版本动过这份数据：抛 MigrationOrderError，
 * 不跳过、不报看不懂的 duplicate column。
 */
export function addMissingColumns(db: Db, sql: string, index: number): void {
  const have = new Map<string, Set<string>>();
  const colsOf = (table: string): Set<string> => {
    let c = have.get(table);
    if (!c) have.set(table, (c = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name.toLowerCase()))));
    return c;
  };
  for (const line of sql.split("\n").slice(1)) {
    const m = ADD_COLUMN.exec(line);
    if (!m) throw new Error(`not an addColumns migration line: ${line}`);
    const cols = colsOf(m[1]);
    if (cols.size === 0) throw new Error(`no table ${m[1]}`);
    if (cols.has(m[2].toLowerCase())) throw new MigrationOrderError(userVersion(db), index);
    db.exec(line);
    cols.add(m[2].toLowerCase());
  }
}

/** 迁移里写了这一行：migrate 在它的事务外关掉外键（见 BTL-270 重建 tickets 表）。 */
const FOREIGN_KEYS_OFF = "-- shipherd:foreign-keys-off";
const fkOn = (db: Db): boolean => (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined)?.foreign_keys === 1;
const fkViolations = (db: Db): number => db.prepare("PRAGMA foreign_key_check").all().length;

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
