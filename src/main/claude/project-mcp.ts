import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** 读 JSON 对象；文件不存在返回 undefined（正常），损坏/读不了记日志后返回 undefined。 */
function readJson(file: string, log?: ProjectMcpPaths["log"]): Json | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log?.(`project MCP: cannot read ${file}`, e);
    return undefined;
  }
  try {
    const v: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (isObject(v)) return v;
    log?.(`project MCP: ${file} is not a JSON object`);
  } catch (e) {
    log?.(`project MCP: ${file} is not valid JSON`, e);
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

/** settings.local.json 是用户本机的（Claude Code 在这里记审批）；被 git 跟踪或 git 不可用时，它可能是仓库带来的，不信。 */
function isUntracked(cwd: string, rel: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd, stdio: "ignore", timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
    return false; // 退出码 0：被跟踪
  } catch (e) {
    return typeof (e as { status?: unknown }).status === "number"; // 非 0 退出：未跟踪或不是 git 仓库；起不来 git 则不信
  }
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
  if (p.claudeSettings) add(readJson(p.claudeSettings, p.log), true);
  const rel = join(".claude", "settings.local.json");
  const local = readJson(join(cwd, rel), p.log);
  if (local) add(local, isUntracked(cwd, rel));
  return a;
}

function writePrivate(file: string, servers: Json): void {
  writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  // 文件已存在时 writeFileSync 不改权限。
  chmodSync(file, 0o600);
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
  const claudeJson = readJson(p.claudeJson, p.log);
  try {
    const declared = readJson(join(cwd, ".mcp.json"), p.log)?.mcpServers;
    if (isServerMap(declared)) {
      const a = approvals(cwd, claudeJson, p);
      const allowed = Object.fromEntries(Object.entries(declared).filter(([name]) => !a.disabled.has(name) && (a.enableAll || a.enabled.has(name))));
      if (isServerMap(allowed)) {
        const file = join(p.mcpDir, fileKey(cwd, "project"));
        writePrivate(file, allowed);
        out.push(file);
      }
    }
  } catch (e) {
    p.log?.("project MCP: skipping project-scope servers", e);
  }
  if (INCLUDE_LOCAL_SCOPE) {
    try {
      const local = projectEntry(cwd, claudeJson)?.mcpServers;
      if (isServerMap(local)) {
        const file = join(p.mcpDir, fileKey(cwd, "local"));
        writePrivate(file, local);
        out.push(file);
      }
    } catch (e) {
      p.log?.("project MCP: skipping local-scope servers", e);
    }
  }
  return out;
}
