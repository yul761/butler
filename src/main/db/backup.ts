// 迁移前的备份（BTL-262）：数据库要升级表结构时，先 VACUUM INTO 一份 app.db.pre-v<N>（N 是备份里的数据版本），只留最近两份。
// 迁移本身每一步都在事务里，失败会回滚；备份是给两种情况用的：迁移逻辑有错（成功了但丢了数据），和用户要装回旧版本。
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { renameWithRetrySync } from "../util/fs-retry";

/** 打开就 fsync 再关上。文件用 r+：Windows 上 FlushFileBuffers 要写权限。 */
function fsyncPath(path: string, flags: "r" | "r+"): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 最多留这么多份迁移前的备份（版本号最大的几份）。 */
export const KEEP_BACKUPS = 2;

export const backupPath = (file: string, version: number): string => `${file}.pre-v${version}`;

export interface BackupFailure {
  /** 本来要写的备份文件。 */
  backup: string;
  /** 给人看的原因（错误码或 SQLite 的错误信息），不含数据。 */
  reason: string;
  /** 磁盘满了（SQLITE_FULL、ENOSPC）。 */
  diskFull: boolean;
}

/**
 * 备份失败时怎么办（BTL-262 的决定）：不迁移，先问用户。
 * - 返回 true：用户知道没有备份，仍然要升级，照常迁移；
 * - 返回 false 或者没有给这个回调：不迁移、不打开，抛 DatabaseBackupError（原因写在消息里，启动失败的对话框会显示它）。
 * 理由：迁移是不可逆的，没有备份时如果迁移逻辑有错，数据就回不来了；而备份失败多半是磁盘满了，这时迁移本身也很可能失败。
 * 让用户先腾出空间再打开，比默默地冒险好；真要继续也可以，但必须是用户自己选的。
 */
export type OnBackupFailed = (f: BackupFailure) => boolean;

export class DatabaseBackupError extends Error {
  constructor(readonly failure: BackupFailure, readonly declined: boolean, message: string) {
    super(message);
  }
}

const SQLITE_FULL = 13;

export function describeBackupError(e: unknown): { reason: string; diskFull: boolean } {
  const err = e as { code?: string; errcode?: number; errstr?: string; message?: string };
  const diskFull = err?.errcode === SQLITE_FULL || err?.code === "ENOSPC" || /database or disk is full|ENOSPC/i.test(err?.message ?? "");
  const reason = err?.errstr ?? err?.code ?? (e instanceof Error ? e.message : String(e));
  return { reason, diskFull };
}

/**
 * 版本号最大的 keep 份留下，其余的删掉；上次备份中途被打断留下的 app.db.pre-v<N>.tmp 也删掉。
 * 只认自己的命名（app.db.pre-v 后面只有数字，或者数字加 .tmp），同一目录里用户自己放的文件不碰。删不掉的记日志，不影响启动。
 */
export function pruneBackups(file: string, keep: number, log: (m: string) => void): void {
  const dir = dirname(file);
  const prefix = `${basename(file)}.pre-v`;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(prefix));
  } catch {
    return;
  }
  const found = names
    .filter((n) => /^\d+$/.test(n.slice(prefix.length)))
    .map((n) => ({ name: n, v: Number(n.slice(prefix.length)) }))
    .sort((a, b) => b.v - a.v);
  const stale = names.filter((n) => /^\d+\.tmp$/.test(n.slice(prefix.length))).map((name) => ({ name }));
  for (const old of [...found.slice(keep), ...stale]) {
    try {
      rmSync(join(dir, old.name), { force: true });
      log(`database: removed old backup ${old.name}`);
    } catch (e) {
      log(`database: could not remove old backup ${old.name} (${describeBackupError(e).reason})`);
    }
  }
}

/**
 * 把版本 current 的数据写进 app.db.pre-v<current>：先写临时文件再改名，半截的备份不会冒充成完整的。
 * 成功返回 true；失败时按 onFailed 的回答，继续返回 false（不备份迁移），不继续就抛 DatabaseBackupError。
 */
export function backupBeforeMigrate(
  db: DatabaseSync,
  file: string,
  current: number,
  o: { log?: (m: string) => void; onBackupFailed?: OnBackupFailed; failedMessage: (f: BackupFailure) => string; now?: () => number },
): boolean {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? Date.now;
  const target = backupPath(file, current);
  const tmp = `${target}.tmp`;
  const started = now();
  try {
    rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    // VACUUM INTO 不 fsync 输出文件（BTL-262 审查）：先落盘再改名，免得断电后 app.db.pre-v<N> 名字对、内容却不完整。
    fsyncPath(tmp, "r+");
    renameWithRetrySync(tmp, target);
    // 改名本身也落盘（POSIX 上 fsync 目录；Windows 不支持，跳过）。失败不算备份失败：文件内容已经落盘了。
    if (process.platform !== "win32") {
      try {
        fsyncPath(dirname(target), "r");
      } catch (e) {
        log(`database: could not fsync the backup's directory (${(e as NodeJS.ErrnoException)?.code ?? "error"})`);
      }
    }
  } catch (e) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true, recursive: false });
    } catch {
      // 临时文件删不掉：下次备份前会先删。
    }
    const failure: BackupFailure = { backup: target, ...describeBackupError(e) };
    log(`database: backup before migrating from version ${current} failed (${failure.reason}${failure.diskFull ? ", disk full" : ""})`);
    const go = o.onBackupFailed?.(failure) ?? false;
    if (!go) throw new DatabaseBackupError(failure, o.onBackupFailed !== undefined, o.failedMessage(failure));
    log("database: migrating without a backup (the user chose to continue)");
    return false;
  }
  log(`database: backed up version ${current} to ${basename(target)} in ${now() - started} ms`);
  pruneBackups(file, KEEP_BACKUPS, log);
  return true;
}
