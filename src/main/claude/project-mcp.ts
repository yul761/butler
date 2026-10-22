import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { renameWithRetrySync } from "../util/fs-retry";
import { GIT_SAFE_ARGS, gitBinary } from "../util/git-path";

/**
 * 计划 3 任务 1 的实测（Ruling P3-R1）：--setting-sources user 下本地级（~/.claude.json 里按目录记录的）MCP 会不会丢。
 * 会丢时为 true：把它导出成 --mcp-config 文件挂回去。
 */
export const INCLUDE_LOCAL_SCOPE = true;

export interface ProjectMcpPaths {
  /** Claude Code 的全局配置，只读。 */
  claudeJson: string;
  /** 用户级 settings.json，只读（可选）。 */
  claudeSettings?: string;
  /** ~/.butler/mcp：生成的 --mcp-config 文件只写在这里。 */
  mcpDir: string;
  log?: (msg: string, err?: unknown) => void;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isServerMap = (v: unknown): v is Json => isObject(v) && Object.keys(v).length > 0;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** 仓库里的文件（仓库的人能写）：不读符号链接、不读非普通文件，限制大小，免得被 /dev/zero 之类卡住主进程。 */
const REPO_FILE_LIMIT = 1024 * 1024;
const USER_FILE_LIMIT = 64 * 1024 * 1024;

const errTag = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.name ?? "error";

/**
 * 读 JSON 对象；文件不存在返回 undefined（正常），其余问题记日志后返回 undefined。
 * 日志只写路径和错误码/类型，绝不写 e.message（JSON.parse 的消息会带出文件内容片段，~/.claude.json 里有密钥）。
 */
function readJson(file: string, log: ProjectMcpPaths["log"], o: { repo: boolean }): Json | undefined {
  let fd: number | undefined;
  try {
    if (o.repo && lstatSync(file).isSymbolicLink()) {
      log?.(`project MCP: ignoring symlink ${file}`);
      return undefined;
    }
    fd = openSync(file, "r");
    const st = fstatSync(fd);
    const limit = o.repo ? REPO_FILE_LIMIT : USER_FILE_LIMIT;
    if (!st.isFile() || st.size > limit) {
      log?.(`project MCP: ignoring ${file} (${st.isFile() ? "too large" : "not a regular file"})`);
      return undefined;
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    const v: unknown = JSON.parse(buf.toString("utf8", 0, off).replace(/^\uFEFF/, ""));
    if (isObject(v)) return v;
    log?.(`project MCP: ${file} is not a JSON object`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log?.(`project MCP: cannot read ${file} (${errTag(e)})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** ~/.claude.json 里这个目录的条目；Windows 上 claude 记录的路径可能是正斜杠。 */
function projectEntry(cwd: string, claudeJson: Json | undefined): Json | undefined {
  const projects = claudeJson?.projects;
  if (!isObject(projects)) return undefined;
  for (const key of new Set([cwd, realpathOr(cwd), cwd.replace(/\\/g, "/")])) {
    const entry = projects[key];
    if (isObject(entry)) return entry;
  }
  return undefined;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
  env.LC_ALL = "C";
  return env;
}

function git(cwd: string, args: string[]): { status: number | null; stdout: string } {
  let bin: string;
  try {
    bin = gitBinary();
  } catch {
    return { status: null, stdout: "" };
  }
  const r = spawnSync(bin, [...GIT_SAFE_ARGS, ...args], { cwd, env: gitEnv(), timeout: 5000, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
}

/**
 * settings.local.json 是用户本机的（Claude Code 在这里记审批），仓库可以自带一份冒充。只在能证明它不是仓库带来的时才信：
 * git 明确说它未被跟踪（退出码恰为 1；128、超时、没有 git 都算不信），.claude 本身不是被跟踪的条目/gitlink（大小写不敏感），
 * .claude 是真目录、文件是普通文件，且真实路径就是 cwd/.claude/settings.local.json。
 */
function localSettingsTrusted(cwd: string): boolean {
  const rel = join(".claude", "settings.local.json");
  const file = join(cwd, rel);
  try {
    if (!lstatSync(join(cwd, ".claude")).isDirectory()) return false;
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    if (realpathSync.native(file) !== join(realpathSync.native(cwd), ".claude", "settings.local.json")) return false;
  } catch {
    return false;
  }
  if (git(cwd, ["ls-files", "--error-unmatch", "--", ":(icase).claude/settings.local.json"]).status !== 1) return false;
  const dir = git(cwd, ["ls-files", "-s", "-z", "--", ":(icase).claude"]);
  if (dir.status !== 0) return false;
  return !dir.stdout.split("\0").some((entry) => entry.slice(entry.indexOf("\t") + 1).toLowerCase() === ".claude");
}

interface Approval {
  enabled: Set<string>;
  disabled: Set<string>;
  enableAll: boolean;
}

/**
 * 用户在 Claude Code 里对仓库 .mcp.json 的审批，只读这些地方：
 * ~/.claude.json 该目录条目、用户级 settings.json、该仓库未被跟踪的 .claude/settings.local.json。
 * 仓库自己的 .claude/settings.json（仓库的人能写）不算；disabled 列表任何来源都生效。
 */
function approvals(cwd: string, claudeJson: Json | undefined, p: ProjectMcpPaths): Approval {
  const a: Approval = { enabled: new Set(), disabled: new Set(), enableAll: false };
  const add = (src: Json | undefined, trusted: boolean): void => {
    if (!src) return;
    for (const n of strings(src.disabledMcpjsonServers)) a.disabled.add(n);
    if (!trusted) return;
    for (const n of strings(src.enabledMcpjsonServers)) a.enabled.add(n);
    if (src.enableAllProjectMcpServers === true) a.enableAll = true;
  };
  add(projectEntry(cwd, claudeJson), true);
  if (p.claudeSettings) add(readJson(p.claudeSettings, p.log, { repo: false }), true);
  const rel = join(".claude", "settings.local.json");
  const local = readJson(join(cwd, rel), p.log, { repo: true });
  if (local) add(local, localSettingsTrusted(cwd));
  return a;
}

const STALE_TMP_MS = 60 * 60 * 1000;
const swept = new Set<string>();

/** 进程在写入和 rename 之间退出会留下 *.tmp：每个进程对每个目录清一次顶层超过一小时的。不进子目录（mcp/tickets/ 归计划 4）。 */
function sweepStaleTmp(dir: string): void {
  if (swept.has(dir)) return;
  swept.add(dir);
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".tmp")) continue;
      const f = join(dir, e.name);
      try {
        if (Date.now() - statSync(f).mtimeMs > STALE_TMP_MS) unlinkSync(f);
      } catch {
        // 别的进程先清掉了，或者删不掉：下次再说。
      }
    }
  } catch {
    // 目录还不存在：没有可清的。
  }
}

/** 同目录随机名临时文件（0600，wx：绝不覆盖已有的）再 rename，不会留下半截或宽权限的文件。 */
function writePrivate(file: string, servers: Json): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600); // 失败（含 EEXIST）时不是我们建的，什么都不删。
  try {
    try {
      writeSync(fd, JSON.stringify({ mcpServers: servers }, null, 2));
    } finally {
      closeSync(fd);
    }
    renameWithRetrySync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 已经没了。
    }
    throw e;
  }
}

const fileKey = (cwd: string, kind: string): string => `${kind}-${createHash("sha1").update(cwd).digest("hex").slice(0, 12)}.json`;

/**
 * 后台运行要额外挂上的 --mcp-config 文件，全部生成在 mcpDir 下（权限 0600，里面可能有 token）：
 * - 仓库 .mcp.json 里用户已在 Claude Code 里批准的 server（仓库内容由仓库的人控制，未批准、被禁用的不挂）；
 * - INCLUDE_LOCAL_SCOPE 时，~/.claude.json 里这个目录的本地级 MCP（用户自己写的）。
 * 任何一步失败都记日志并跳过那一项，不抛错。
 */
export function projectMcpConfigs(cwd: string, p: ProjectMcpPaths): string[] {
  const out: string[] = [];
  sweepStaleTmp(p.mcpDir);
  const claudeJson = readJson(p.claudeJson, p.log, { repo: false });
  const localRaw = INCLUDE_LOCAL_SCOPE ? projectEntry(cwd, claudeJson)?.mcpServers : undefined;
  const local = isServerMap(localRaw) ? localRaw : undefined;
  try {
    const declared = readJson(join(cwd, ".mcp.json"), p.log, { repo: true })?.mcpServers;
    if (isServerMap(declared)) {
      const a = approvals(cwd, claudeJson, p);
      // 同名时本地级（用户自己写的）优先，丢掉仓库的那一项。
      const allowed = Object.fromEntries(
        Object.entries(declared).filter(([name]) => !a.disabled.has(name) && (a.enableAll || a.enabled.has(name)) && !(local && name in local)),
      );
      if (isServerMap(allowed)) {
        const file = join(p.mcpDir, fileKey(cwd, "project"));
        writePrivate(file, allowed);
        out.push(file);
      }
    }
  } catch (e) {
    p.log?.(`project MCP: skipping project-scope servers (${errTag(e)})`);
  }
  if (local) {
    try {
      const file = join(p.mcpDir, fileKey(cwd, "local"));
      writePrivate(file, local);
      out.push(file);
    } catch (e) {
      p.log?.(`project MCP: skipping local-scope servers (${errTag(e)})`);
    }
  }
  return out;
}
