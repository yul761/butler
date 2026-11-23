// BTL-260：产品从 Butler 改名为 Shipherd，默认数据目录从 ~/.butler 改成 ~/.shipherd。这个文件把老用户的数据搬过去。
// 这里的 butler 都是旧名字，必须认得才能迁移。TODO(5.0)：保留一个大版本后整个文件可以删掉。
import { closeSync, cpSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { envValue } from "../../shared/legacy-env";
import { readSettings, writeSettingsAtomic } from "../hooks/installer";
import { renameWithRetrySync } from "../util/fs-retry";

/** 旧的默认数据目录名、旧的全局总控工作区名。 */
export const LEGACY_HOME_NAME = ".butler";
export const LEGACY_SHIPHERD_WORKSPACE = "_butler";
/** 迁移完写在新目录里的标记：之后每次启动据此做一遍幂等的收尾（Claude 的 projects 目录、~/.claude.json、数据库里的路径）。 */
export const MIGRATED_MARKER = "migrated-from-butler.json";
/** 留在旧位置的说明文件（Windows，或者复制迁移后旧目录删不掉时）。 */
export const LEGACY_NOTE = "README-moved-to-shipherd.txt";

export interface MigrationMarker {
  from: string;
  to: string;
  how: "rename" | "copy" | "symlink";
  at: number;
  /** ~/.butler 是符号链接时它指向的真实目录：库里、Claude 那边也可能记的是这个真实路径（只有总控工作区那一段要换）。 */
  alias?: string;
}

export type LegacyHomeResult =
  | { kind: "skipped"; reason: "env" | "no_legacy" | "already" }
  | { kind: "moved"; marker: MigrationMarker; leftover: "symlink" | "note" | "none" }
  /** 没搬成，数据原样在 legacy：调用方这次就用 legacy 启动（SHIPHERD_HOME 指过去），下次启动再试。 */
  | { kind: "failed"; error: string; legacy: string };

export interface LegacyHomeDeps {
  env: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** 测试用：模拟跨卷、文件被占用时的 rename 失败。 */
  rename?: (from: string, to: string) => void;
  /** 测试用：模拟复制失败、建不了链接。 */
  copy?: (from: string, to: string) => void;
  symlink?: (target: string, path: string, type: "dir" | "junction") => void;
}

const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const noteText = (to: string): string =>
  [
    "Butler has been renamed to Shipherd. Its data now lives in:",
    `  ${to}`,
    "This folder is no longer used and can be deleted once Shipherd is working.",
    "",
    "Butler 已改名为 Shipherd，数据已经搬到：",
    `  ${to}`,
    "这个目录不再使用，确认 Shipherd 正常后可以删掉。",
    "",
  ].join("\n");

/**
 * 启动时（拿到单实例锁之后、打开数据库之前）调用。只有这几种情况才搬：
 * SHIPHERD_HOME、BUTLER_HOME 都没设；~/.shipherd 不存在；~/.butler 存在。
 * - 迁移标记先写进旧目录，再整个搬：标记和数据一起到新目录，搬到一半崩了也不会有「数据到了、标记没到」。
 * - 同一个卷上直接 rename；失败（跨卷、文件被占用）就复制到临时目录再改名成 ~/.shipherd，旧目录保留、里面留说明文件。
 * - rename 成功后在旧位置留一个指向新目录的链接（macOS / Linux 是符号链接，Windows 是不要权限的目录联接 junction）：
 *   改名前起的 claude、hook、存下来的分叉参数还按旧的绝对路径找得到。建不了链接就留一个只有说明文件的目录。
 * - ~/.butler 本身是符号链接（用户把数据放在别的盘上）：不动数据，~/.shipherd 也建成指向同一个地方的符号链接。
 * 出错不抛：返回 failed（复制了一半的临时目录、写进旧目录的标记都清掉），调用方这次就用旧目录启动，下次启动再试。
 */
export function migrateLegacyHome(d: LegacyHomeDeps): LegacyHomeResult {
  const home = d.home ?? homedir();
  const platform = d.platform ?? process.platform;
  const now = d.now ?? Date.now;
  if (envValue(d.env, "HOME")?.trim()) return { kind: "skipped", reason: "env" };
  const from = join(home, LEGACY_HOME_NAME);
  const to = join(home, ".shipherd");
  if (exists(to)) return { kind: "skipped", reason: "already" };
  if (!isDir(from) && !isLink(from)) return { kind: "skipped", reason: "no_legacy" };
  const link = d.symlink ?? ((target: string, path: string, type: "dir" | "junction") => symlinkSync(target, path, type));
  let markerAt: string | null = null;
  let tmp: string | null = null;
  try {
    if (isLink(from)) {
      const target = realpathSync(from);
      if (!isDir(target)) return { kind: "skipped", reason: "no_legacy" };
      const marker: MigrationMarker = { from, to, how: "symlink", at: now(), alias: target };
      markerAt = writeMarker(target, marker);
      link(target, to, platform === "win32" ? "junction" : "dir");
      markerAt = null;
      renameWorkspace(to);
      return { kind: "moved", marker, leftover: "none" };
    }
    let how: MigrationMarker["how"] = "rename";
    const marker = (): MigrationMarker => ({ from, to, how, at: now() });
    markerAt = writeMarker(from, marker());
    try {
      if (d.rename) d.rename(from, to);
      else renameWithRetrySync(from, to, { platform });
      markerAt = null;
    } catch {
      how = "copy";
      // 旧目录里的标记还写着 rename：换成 copy 再复制。
      writeMarker(from, marker());
      tmp = `${to}.migrating-${now()}`;
      if (d.copy) d.copy(from, tmp);
      else cpSync(from, tmp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      renameSync(tmp, to);
      tmp = null;
      // 旧目录还在：里面的标记删掉，免得以后被当成这次迁移的目标。
      rmQuiet(join(from, MIGRATED_MARKER));
      markerAt = null;
    }
    const m = readMigrationMarker(to) ?? marker();
    renameWorkspace(to);
    return { kind: "moved", marker: m, leftover: leaveBehind(from, to, how, platform, link) };
  } catch (e) {
    if (tmp) rmQuiet(tmp);
    // rename 报错但其实已经搬过去了（标记跟着数据到了新目录）：按搬成了算，不能拿已经不存在的旧目录启动。
    const landed = !exists(from) ? readMigrationMarker(to) : null;
    if (landed) {
      renameWorkspace(to);
      return { kind: "moved", marker: landed, leftover: "none" };
    }
    if (markerAt) rmQuiet(markerAt);
    return { kind: "failed", error: e instanceof Error ? e.message : String(e), legacy: from };
  }
}

function writeMarker(dir: string, marker: MigrationMarker): string {
  const file = join(dir, MIGRATED_MARKER);
  writeFileSync(file, JSON.stringify(marker, null, 2) + "\n");
  return file;
}

function rmQuiet(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // 清不掉就留着：下次迁移用新的临时目录名。
  }
}

/**
 * 全局总控的工作区 workspaces/_butler 改名成 _shipherd。幂等、不抛：迁移时做一次，之后每次收尾（finishLegacyHome）再看一次，
 * 搬完还没来得及改名就退出了的也补上。新名字已经有了（启动时被建出来）而且是空的，就先删掉空的再改。
 */
export function renameWorkspace(home: string): boolean {
  const oldWs = join(home, "workspaces", LEGACY_SHIPHERD_WORKSPACE);
  const newWs = join(home, "workspaces", "_shipherd");
  try {
    if (!isDir(oldWs) || isLink(oldWs)) return false;
    if (exists(newWs)) {
      if (!isDir(newWs) || readdirSync(newWs).length > 0) return false;
      rmSync(newWs, { recursive: true });
    }
    renameSync(oldWs, newWs);
    return true;
  } catch {
    return false;
  }
}

function leaveBehind(
  from: string, to: string, how: MigrationMarker["how"], platform: NodeJS.Platform, link: (target: string, path: string, type: "dir" | "junction") => void,
): "symlink" | "note" | "none" {
  try {
    if (how === "copy") {
      // 复制的：旧目录还在（可能有文件被占着），不删，留一句话。
      writeFileSync(join(from, LEGACY_NOTE), noteText(to));
      return "note";
    }
    try {
      link(to, from, platform === "win32" ? "junction" : "dir");
      return "symlink";
    } catch {
      // 建不了链接：留一个只有说明文件的目录。
    }
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, LEGACY_NOTE), noteText(to));
    return "note";
  } catch {
    return "none";
  }
}

export function readMigrationMarker(shipherdHome: string): MigrationMarker | null {
  try {
    const v = JSON.parse(readFileSync(join(shipherdHome, MIGRATED_MARKER), "utf8")) as Partial<MigrationMarker>;
    return typeof v.from === "string" && typeof v.to === "string" ? (v as MigrationMarker) : null;
  } catch {
    return null;
  }
}

/** Windows 路径（盘符或 UNC 开头）：比较时不分大小写，/ 和 \\ 算同一个分隔符（Claude Code 在 Windows 上记的路径是正斜杠）。 */
// 带反斜杠的也算：Windows 上不带盘符的路径（如 \h\.butler，测试里 join("/h", …) 在 Windows 上得到的就是这种）。
const winLike = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) || p.includes("\\");
const normWin = (p: string): string => p.replace(/\//g, "\\").toLowerCase();

/**
 * p 是 dir 本身或在它下面时，返回 p 在 dir 之后的部分（空串，或以分隔符开头）；否则 null。
 * dir 是 Windows 路径时按 Windows 的规矩比（见 winLike），否则逐字比。
 */
export function pathUnder(p: string, dir: string): string | null {
  if (p.length < dir.length) return null;
  const head = p.slice(0, dir.length);
  const same = winLike(dir) ? normWin(head) === normWin(dir) : head === dir;
  if (!same) return null;
  const rest = p.slice(dir.length);
  return rest === "" || rest[0] === "/" || (winLike(dir) && rest[0] === "\\") ? rest : null;
}

const WS_RE = (win: boolean) => new RegExp(`^([\\\\/]workspaces[\\\\/])${LEGACY_SHIPHERD_WORKSPACE}(?=$|[\\\\/])`, win ? "i" : "");

/** 一对「旧前缀 → 新前缀」下的映射；总控工作区 _butler 换成 _shipherd。不在旧前缀下为 null。 */
function mapUnder(p: string, from: string, to: string): string | null {
  const rest = pathUnder(p, from);
  if (rest === null) return null;
  const win = winLike(from);
  // 输出沿用 p 的分隔符：Windows 上 p 全是正斜杠的（Claude Code 记的），新前缀也换成正斜杠。
  const slash = win && p.includes("/") && !p.includes("\\");
  const base = slash ? to.replace(/\\/g, "/") : to;
  return base + rest.replace(WS_RE(win), "$1_shipherd");
}

/**
 * 旧数据目录下的绝对路径换成新目录下的：前缀 from 换成 to，总控工作区 _butler 换成 _shipherd。
 * ~/.butler 是符号链接的（marker.alias），按真实路径记的也认：前缀不变，只换工作区那一段。
 * 不在旧目录下的路径返回 null。
 */
export function mapLegacyPath(p: string, m: Pick<MigrationMarker, "from" | "to" | "alias">): string | null {
  return mapUnder(p, m.from, m.to) ?? (m.alias ? mapUnder(p, m.alias, m.alias) : null);
}

/** Claude Code 存对话记录的目录名：cwd 里不是字母数字的字符都换成 -。 */
export const claudeProjectDirName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

function mapDirName(name: string, from: string, to: string): string | null {
  const oldPrefix = claudeProjectDirName(from);
  const newPrefix = claudeProjectDirName(to);
  // 目录名只有字母数字和 -，转小写不改长度。Windows 上盘符大小写可能不一样。
  const eq = (a: string, b: string) => (winLike(from) ? a.toLowerCase() === b.toLowerCase() : a === b);
  const head = name.slice(0, oldPrefix.length);
  const rest = name.slice(oldPrefix.length);
  if (!eq(head, oldPrefix) || (rest !== "" && rest[0] !== "-")) return null;
  const ws = `-workspaces--${LEGACY_SHIPHERD_WORKSPACE.slice(1)}`;
  const wsHit = eq(rest.slice(0, ws.length), ws) && (rest.length === ws.length || rest[ws.length] === "-");
  return newPrefix + (wsHit ? "-workspaces--shipherd" + rest.slice(ws.length) : rest);
}

/** 旧 cwd 对应的 projects 目录名 → 新 cwd 对应的目录名；不是旧数据目录下的为 null（alias 的规则同 mapLegacyPath）。 */
export function mapProjectDirName(name: string, m: Pick<MigrationMarker, "from" | "to" | "alias">): string | null {
  return mapDirName(name, m.from, m.to) ?? (m.alias ? mapDirName(name, m.alias, m.alias) : null);
}

/**
 * 目录名只是 cwd 把非字母数字换成 - 的结果，~/.butler-old、~/.butler_bak 这类不相干目录的名字也以同样的前缀开头。
 * 所以再看一眼目录里对话记录的 cwd：读得到 cwd 而且不在旧数据目录下的，不是我们的，不动。读不到（没有记录、格式不认得）的按名字算。
 */
function ownedByLegacyHome(dir: string, m: Pick<MigrationMarker, "from" | "to" | "alias">): boolean {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return true;
  }
  for (const f of files) {
    let head: string;
    try {
      const fd = openSync(join(dir, f), "r");
      try {
        const buf = Buffer.alloc(64 * 1024);
        head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    for (const line of head.split("\n")) {
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === "string") return mapLegacyPath(cwd, m) !== null;
      } catch {
        // 半行或者不是 JSON：看下一行。
      }
    }
  }
  return true;
}

/**
 * ~/.claude/projects 里按旧 cwd 命名的目录改成新 cwd 的名字，`claude --resume` 才找得到以前的对话。
 * 新名字的目录已经有了（迁移后又在新路径上开过 session）：把旧目录里新目录没有的文件挪过去。幂等，返回动过的目录数。
 */
export function moveClaudeProjects(projectsDir: string, m: Pick<MigrationMarker, "from" | "to" | "alias">): number {
  let names: string[];
  try {
    names = readdirSync(projectsDir);
  } catch {
    return 0;
  }
  let moved = 0;
  for (const name of names) {
    const next = mapProjectDirName(name, m);
    if (next === null || next === name) continue;
    const src = join(projectsDir, name);
    const dst = join(projectsDir, next);
    if (!ownedByLegacyHome(src, m)) continue;
    try {
      if (!exists(dst)) {
        renameSync(src, dst);
        moved++;
        continue;
      }
      let any = false;
      for (const f of readdirSync(src)) {
        if (exists(join(dst, f))) continue;
        renameSync(join(src, f), join(dst, f));
        any = true;
      }
      if (any) moved++;
    } catch {
      // 一个目录挪不动不影响别的。
    }
  }
  return moved;
}

/**
 * ~/.claude.json 的 projects 里按旧路径记的条目（信任对话框已接受、允许的工具等）复制一份到新路径下：
 * 只加不改，新路径已有的条目不动，旧条目也留着。有变化才写：读完马上写，写法和装 hook 时写 settings.json 一样
 * （writeSettingsAtomic：保留原来的权限位，是符号链接就写到真实文件，第一次写之前留一份备份）。返回新加的条目数。
 */
export async function copyClaudeJsonProjects(claudeJson: string, m: Pick<MigrationMarker, "from" | "to" | "alias">): Promise<number> {
  let data: { projects?: Record<string, unknown> };
  try {
    data = await readSettings(claudeJson);
  } catch {
    return 0;
  }
  const projects = data.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return 0;
  let added = 0;
  for (const [k, v] of Object.entries(projects)) {
    const next = mapLegacyPath(k, m);
    if (next === null || next === k || next in projects) continue;
    projects[next] = structuredClone(v);
    added++;
  }
  if (added === 0) return 0;
  await writeSettingsAtomic(claudeJson, data);
  return added;
}

/** 数据库里记着旧数据目录下绝对路径的列：sessions.cwd（总控、复盘 session 的工作区），分叉讨论的 cwd 和启动参数。 */
export interface PathColumnDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
}

/** sessions.cwd 里旧目录下的路径换成新路径。表不大，整表读出来逐行判断（Windows 上大小写、分隔符不一定一样）。幂等，返回改了的行数。 */
export function rewriteSessionCwds(db: PathColumnDb, m: Pick<MigrationMarker, "from" | "to" | "alias">): number {
  const rows = db.prepare(`SELECT id, cwd FROM sessions`).all() as { id: string; cwd: string }[];
  const update = db.prepare(`UPDATE sessions SET cwd = ? WHERE id = ?`);
  let n = 0;
  for (const r of rows) {
    const next = mapLegacyPath(r.cwd, m);
    if (next === null || next === r.cwd) continue;
    update.run(next, r.id);
    n++;
  }
  return n;
}

/**
 * 分叉讨论（fork_discussions）每一轮都用行里存的 cwd 和启动参数（--settings、--mcp-config 都是数据目录下的文件）续上，
 * 里面旧目录下的路径也换成新路径。参数里只换整个参数就是旧目录下路径的那些。幂等，返回改了的行数。
 */
export function rewriteForkPaths(db: PathColumnDb, m: Pick<MigrationMarker, "from" | "to" | "alias">): number {
  const rows = db.prepare(`SELECT id, cwd, launch_args FROM fork_discussions`).all() as { id: number; cwd: string; launch_args: string }[];
  const update = db.prepare(`UPDATE fork_discussions SET cwd = ?, launch_args = ? WHERE id = ?`);
  let n = 0;
  for (const r of rows) {
    let args: unknown;
    try {
      args = JSON.parse(r.launch_args);
    } catch {
      continue;
    }
    if (!Array.isArray(args)) continue;
    const nextArgs = args.map((a) => (typeof a === "string" ? (mapLegacyPath(a, m) ?? a) : a));
    const nextCwd = mapLegacyPath(r.cwd, m) ?? r.cwd;
    const argsText = JSON.stringify(nextArgs);
    if (nextCwd === r.cwd && argsText === JSON.stringify(args)) continue;
    update.run(nextCwd, argsText, r.id);
    n++;
  }
  return n;
}

/**
 * 读对话记录的游标（usage_cursors、conv_cursors）记着文件的绝对路径：projects 目录改名后换成新路径，
 * 不然新路径会被当成没读过的文件从头再读一遍（用量重复计算、对话重复入库）。
 * 只改真的挪走了的文件（旧路径没了、新路径有了），和 moveClaudeProjects 实际做的保持一致；
 * 新路径已经有游标的，留新的、删旧的。幂等，返回改了的行数。
 */
export function rewriteTranscriptCursors(db: PathColumnDb, projectsDir: string, m: Pick<MigrationMarker, "from" | "to" | "alias">): number {
  const base = projectsDir.endsWith(sep) ? projectsDir : projectsDir + sep;
  const mapFile = (file: string): string | null => {
    if (!file.startsWith(base)) return null;
    const rest = file.slice(base.length);
    const i = rest.search(/[/\\]/);
    if (i < 0) return null;
    const dir = mapProjectDirName(rest.slice(0, i), m);
    if (dir === null || dir === rest.slice(0, i)) return null;
    const next = base + dir + rest.slice(i);
    return !exists(file) && exists(next) ? next : null;
  };
  // LIKE 不分 ASCII 大小写；_ 和 % 在目录名里不会出现（只有字母数字和 -）。
  const likes = [m.from, ...(m.alias ? [m.alias] : [])].map((p) => base + claudeProjectDirName(p) + "%");
  const where = likes.map(() => "file LIKE ?").join(" OR ");
  let n = 0;
  const usage = db.prepare(`SELECT file FROM usage_cursors WHERE ${where}`).all(...likes) as { file: string }[];
  const has = db.prepare(`SELECT 1 AS x FROM usage_cursors WHERE file = ?`);
  const del = db.prepare(`DELETE FROM usage_cursors WHERE file = ?`);
  const mv = db.prepare(`UPDATE usage_cursors SET file = ? WHERE file = ?`);
  for (const r of usage) {
    const next = mapFile(r.file);
    if (next === null) continue;
    if (has.all(next).length > 0) del.run(r.file);
    else mv.run(next, r.file);
    n++;
  }
  const conv = db.prepare(`SELECT session_id, file FROM conv_cursors WHERE ${where}`).all(...likes) as { session_id: string; file: string }[];
  const setConv = db.prepare(`UPDATE conv_cursors SET file = ? WHERE session_id = ?`);
  for (const r of conv) {
    const next = mapFile(r.file);
    if (next === null) continue;
    setConv.run(next, r.session_id);
    n++;
  }
  return n;
}
