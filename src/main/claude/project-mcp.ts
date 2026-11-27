import { spawnSync } from "node:child_process";
import { isSafeRule } from "../permissions/classify";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { renameWithRetrySync } from "../util/fs-retry";
import { GIT_SAFE_ARGS, gitBinary } from "../util/git-path";

/** feature 记忆的 remember 工具：约定广播（BTL-245）的来源。 */
export const REMEMBER_TOOL = "mcp__shipherd-feature__remember";

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
  /** ~/.shipherd/mcp：生成的 --mcp-config 文件只写在这里。 */
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

/** 文件的版本：设备、inode、大小、修改和变更时间（纳秒）。读不到（不存在等）为 null。 */
function fileVersion(file: string): string | null {
  try {
    const st = statSync(file, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return null;
  }
}

/**
 * 用户自己的 JSON（~/.claude.json、用户级 settings.json）按文件版本缓存解析结果（BTL-275）：~/.claude.json 常有几 MB，
 * 开一个 session 原来要同步读、解析两三遍。文件一变（版本不同）就重读；读不出来的不缓存（下次照旧重试、记日志）。
 * 返回的对象是共享的，调用方只读不改。
 */
const userJsonCache = new Map<string, { version: string; value: Json }>();
function readUserJson(file: string, log: ProjectMcpPaths["log"]): Json | undefined {
  const version = fileVersion(file);
  const hit = userJsonCache.get(file);
  if (version !== null && hit?.version === version) return hit.value;
  const value = readJson(file, log, { repo: false });
  if (version !== null && value !== undefined) {
    if (userJsonCache.size >= 8) userJsonCache.clear();
    userJsonCache.set(file, { version, value });
  } else {
    userJsonCache.delete(file);
  }
  return value;
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
  if (p.claudeSettings) add(readUserJson(p.claudeSettings, p.log), true);
  const rel = join(".claude", "settings.local.json");
  const local = readJson(join(cwd, rel), p.log, { repo: true });
  if (local) add(local, localSettingsTrusted(cwd));
  return a;
}

/**
 * 主目录按 cwd 缓存（BTL-275：每开一个 session 都起一次 git）。只缓存 cwd 下面就有 .git 的（主目录或 worktree 的根），
 * 而且只在 cwd/.git 没变时用：worktree 删了、同一个路径换成别的仓库的 worktree，.git 文件就换了，要重新问 git，
 * 不能把上一个仓库的批准带过来。git 失败的不缓存。
 */
const mainCache = new Map<string, { version: string; main: string | undefined }>();

/** cwd 所在仓库的主目录（主 worktree）：--git-common-dir 的上一级。不在 git 仓库里、bare 仓库、git 失败时返回 undefined。 */
function mainCheckout(cwd: string): string | undefined {
  const version = fileVersion(join(cwd, ".git"));
  const hit = mainCache.get(cwd);
  if (version !== null && hit?.version === version) return hit.main;
  const r = git(cwd, ["rev-parse", "--git-common-dir"]);
  const out = r.stdout.trim();
  if (r.status !== 0 || !out) {
    mainCache.delete(cwd);
    return undefined;
  }
  const common = resolve(cwd, out);
  const main = basename(common) === ".git" ? dirname(common) : undefined;
  if (version !== null) {
    if (mainCache.size >= 500) mainCache.clear();
    mainCache.set(cwd, { version, main });
  }
  return main;
}

/**
 * 审批只看 session 的目录和它所在仓库的主目录（BTL-262 审查）：一个 ticket 跨好几个仓库时，
 * 仓库 B 里批准过的（哪怕是 enableAll）不能带到仓库 A 的 worktree 里去。
 * candidates 是调用方知道的仓库路径，只有和 cwd 的主目录是同一个目录的那个才算（保留调用方的写法，~/.claude.json 按它记）。
 */
function approvalDirs(cwd: string, candidates: readonly string[]): string[] {
  const main = mainCheckout(cwd);
  if (!main) return [cwd];
  const real = realpathOr(main);
  const known = candidates.filter((c) => realpathOr(c) === real);
  return [...new Set([cwd, ...(known.length > 0 ? known : [main])])];
}

/** 几个目录（session 的目录、它所在仓库的主目录）的审批合在一起：任何一处批准算批准，任何一处禁用算禁用。 */
function mergedApprovals(dirs: readonly string[], claudeJson: Json | undefined, p: ProjectMcpPaths): Approval {
  const a: Approval = { enabled: new Set(), disabled: new Set(), enableAll: false };
  for (const dir of new Set(dirs)) {
    const one = approvals(dir, claudeJson, p);
    for (const n of one.enabled) a.enabled.add(n);
    for (const n of one.disabled) a.disabled.add(n);
    if (one.enableAll) a.enableAll = true;
  }
  return a;
}

/**
 * 仓库 .mcp.json 里的一个 server 能不能启用：交互和后台用的是同一条规则（BTL-262）。
 * 禁用优先；否则要用户在可信来源里批准过它（enabledMcpjsonServers），或者自己设了 enableAllProjectMcpServers。
 */
function mcpjsonServerApproved(name: string, a: Approval): boolean {
  return !a.disabled.has(name) && (a.enableAll || a.enabled.has(name));
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
function writePrivate(file: string, content: Json): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600); // 失败（含 EEXIST）时不是我们建的，什么都不删。
  try {
    try {
      writeSync(fd, JSON.stringify(content, null, 2));
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
  const claudeJson = readUserJson(p.claudeJson, p.log);
  const localRaw = INCLUDE_LOCAL_SCOPE ? projectEntry(cwd, claudeJson)?.mcpServers : undefined;
  const local = isServerMap(localRaw) ? localRaw : undefined;
  try {
    const declared = readJson(join(cwd, ".mcp.json"), p.log, { repo: true })?.mcpServers;
    if (isServerMap(declared)) {
      const a = approvals(cwd, claudeJson, p);
      // 同名时本地级（用户自己写的）优先，丢掉仓库的那一项。
      const allowed = Object.fromEntries(
        Object.entries(declared).filter(([name]) => mcpjsonServerApproved(name, a) && !(local && name in local)),
      );
      if (isServerMap(allowed)) {
        const file = join(p.mcpDir, fileKey(cwd, "project"));
        writePrivate(file, { mcpServers: allowed });
        out.push(file);
      }
    }
  } catch (e) {
    p.log?.(`project MCP: skipping project-scope servers (${errTag(e)})`);
  }
  if (local) {
    try {
      const file = join(p.mcpDir, fileKey(cwd, "local"));
      writePrivate(file, { mcpServers: local });
      out.push(file);
    } catch (e) {
      p.log?.(`project MCP: skipping local-scope servers (${errTag(e)})`);
    }
  }
  return out;
}

/**
 * Shipherd 打开的交互 session 用的 --settings 文件。仓库 .mcp.json 的审批和后台运行（projectMcpConfigs）同一条规则（BTL-262）：
 * 用户在这些目录（session 的目录、仓库主目录）的可信来源里批准过的 server 写进 enabledMcpjsonServers，worktree 是新目录也不用再问；
 * 用户自己设了 enableAllProjectMcpServers 才写它；禁用过的写进 disabledMcpjsonServers（禁用优先）。
 * 谁都没批准过的不写，交给 Claude Code 自己逐个询问：clone 来的仓库过了文件夹信任，也不能不经用户同意就跑 .mcp.json 里的命令。
 * Shipherd 自己的 MCP（shipherd-*、statecore）走 --mcp-config，不受这里影响。
 * 文件名按内容取 hash，内容一样就是同一个文件。写不了记日志返回 null（Claude Code 照常询问）。
 */
/**
 * allowTools：不用确认就能调用的工具（写进 permissions.allow），空的或者不给就不写。
 * checks：确定性检查打开时给（契约 4.5）：编辑后跑 `check`，Bash 前再跑 `check-push`；hook 的超时比检查的预算多留几秒，
 * 检查自己到点就放行，不会被 Claude Code 当成 hook 超时。预算也写在命令行上（--budget-ms）：session 开着时把设置调大，
 * 快照里的预算变了，但这份 settings 里的超时不会变，hook 按两者里小的那个跑。
 */
export function projectMcpApprovalSettings(
  /** 第一个是 session 的目录（cwd），后面是这个 session 涉及的仓库路径；审批只取 cwd 和 cwd 所在仓库的主目录（approvalDirs）。 */
  dirs: string[],
  p: ProjectMcpPaths & {
    gateCommand?: string; allowTools?: readonly string[]; checks?: { editTimeoutSec: number; pushTimeoutSec: number };
    /** 信箱（BTL-245）的 hook 命令（mailboxHookCommand）：每次工具调用之后跑，信箱为空时只是一次 test。要有 gateCommand 才挂。 */
    mailboxCommand?: string;
    /** 权限档案（ws-j）确认过的只读规则：再过一遍 isSafeRule，排在 allowTools 后面。 */
    profileRules?: readonly string[];
  },
): string | null {
  try {
    sweepStaleTmp(p.mcpDir);
    const claudeJson = readUserJson(p.claudeJson, p.log);
    const [cwd, ...repos] = dirs;
    const a = cwd ? mergedApprovals(approvalDirs(cwd, repos), claudeJson, p) : { enabled: new Set<string>(), disabled: new Set<string>(), enableAll: false };
    const content: Record<string, unknown> = {};
    if (a.enableAll) content.enableAllProjectMcpServers = true;
    content.enabledMcpjsonServers = [...a.enabled].filter((n) => mcpjsonServerApproved(n, a)).sort();
    content.disabledMcpjsonServers = [...a.disabled].sort();
    const allow = [...new Set([...(p.allowTools ?? []), ...(p.profileRules ?? []).filter((r) => isSafeRule(r))])];
    if (allow.length > 0) content.permissions = { allow };
    // 合并总控的 gate hook 只写进这份 session 专用的 settings，不碰用户全局的 settings.json
    if (p.gateCommand) {
      const group = [{ matcher: "Bash", hooks: [{ type: "command", command: `${p.gateCommand} gate`, timeout: 10 }] }];
      // 命令失败时只有 PostToolUseFailure，没有 PostToolUse：两个都要，不然失败的合并一直占着。
      // Skill 调用另记一组（PR 进度的设计 / 自我 review）：命令不带 gate，走写信封的那条路。
      const skill = { matcher: "Skill", hooks: [{ type: "command", command: p.gateCommand, timeout: 10 }] };
      // 子 agent 的派发另记一组（review agent 算自我 review）：同样不带 gate，信封里只留 description / subagent_type。
      const agent = { matcher: "Agent|Task", hooks: [{ type: "command", command: p.gateCommand, timeout: 10 }] };
      // 推送和开 PR 另记一组（工作流 W：分支是谁的，CI 结论按它递）：不带 gate，hook 只为 git push / gh pr create 写信封。
      const ship = { matcher: "Bash", hooks: [{ type: "command", command: p.gateCommand, timeout: 10 }] };
      // 失败的也要：`git push && gh pr create` 里 gh 失败了只有 PostToolUseFailure，推送却成功了。
      const hooks = { PreToolUse: group as unknown[], PostToolUse: [...group, skill, agent, ship] as unknown[], PostToolUseFailure: [...group, ship] as unknown[] };
      // 信箱（BTL-245）：工具调用的间隙把排队的消息送进去（matcher 为空 = 所有工具，MCP 工具也算）；失败的工具调用之后也送。
      // 约定广播：存进 feature 记忆的 remember 写一个信封，主进程推给同一个 feature 里开着的其他 session。
      if (p.mailboxCommand) {
        const mailbox = { matcher: "", hooks: [{ type: "command", command: p.mailboxCommand, timeout: 10 }] };
        hooks.PostToolUse.push(mailbox, { matcher: REMEMBER_TOOL, hooks: [{ type: "command", command: p.gateCommand, timeout: 10 }] });
        hooks.PostToolUseFailure.push(mailbox);
      }
      if (p.checks) {
        hooks.PreToolUse = [...group, { matcher: "Bash", hooks: [{ type: "command", command: `${p.gateCommand} check-push --budget-ms ${p.checks.pushTimeoutSec * 1000}`, timeout: p.checks.pushTimeoutSec + 30 }] }];
        hooks.PostToolUse.push({ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: `${p.gateCommand} check --budget-ms ${p.checks.editTimeoutSec * 1000}`, timeout: p.checks.editTimeoutSec + 3 }] });
      }
      content.hooks = hooks;
    }
    const file = join(p.mcpDir, `approve-${createHash("sha1").update(JSON.stringify(content)).digest("hex").slice(0, 12)}.json`);
    writePrivate(file, content);
    return file;
  } catch (e) {
    p.log?.(`project MCP: approval settings not written (${errTag(e)})`);
    return null;
  }
}
