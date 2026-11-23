import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { envValue } from "../shared/legacy-env";

export interface ShipherdPaths {
  home: string;
  db: string;
  inbox: string;
  inboxBad: string;
  bin: string;
  hookBin: string;
  logs: string;
  /** Shipherd 生成的 --mcp-config 文件。 */
  mcp: string;
  /** 信箱（BTL-245）的磁盘投影：每个开着、有消息在排队的终端一个 <SHIPHERD_SESSION> 目录。 */
  mailbox: string;
  /** 孤儿清理（WS-M F）记下的 Shipherd 起过的进程：procs/owned.json。 */
  procsOwned: string;
  /** StateCore 的嵌入式存储目录（里面是 statecore.db）。 */
  statecore: string;
  /** 总控 session 的工作区目录（每个 ticket 一个空目录）。 */
  workspaces: string;
  /** Shipherd 总控（BTL-190 第 5 点）的工作目录：workspaces/_shipherd，全局只有一个。 */
  shipherdWorkspace: string;
  /** 复盘分析 session 的工作目录：workspaces/_lessons，每次运行的记录文件 run-<id>.md 也写在这里。 */
  lessonsWorkspace: string;
  /** 换新前的对话尾巴（BTL-190 第 6 点）：每个 session 一个 <session id>.md，见 refreshTailPath。 */
  refresh: string;
  /** 总控开子 session 的请求和结果（sessions MCP server ↔ Shipherd，走文件）。 */
  controlRequests: string;
  controlResults: string;
  /** 合并总控的闸门：hook 写请求、Shipherd 写结果；alive.json 是 Shipherd 在线的标记（{ pid }）。 */
  gateRequests: string;
  gateResults: string;
  gateAlive: string;
  /** 确定性检查（契约 4.5）：Shipherd 写的只读快照、hook 写的命中日志、hook 的防抖状态。见 checksLayout。 */
  checksSnapshot: string;
  checksHits: string;
  checksState: string;
  claudeConfigDir: string;
  claudeSettings: string;
  claudeProjects: string;
  /** Claude Code 给每个运行中的 session 写的登记文件（<pid>.json）。 */
  claudeSessions: string;
  claudeCommands: string;
  /** Claude Code 的全局配置（含本地级 MCP）：设了 CLAUDE_CONFIG_DIR 时在它下面，否则在 home 下。 */
  claudeJson: string;
}

/** 环境变量给的目录：~ 展开到 home（GUI 启动时没有 shell 替你展开），相对路径按当前目录解析（Electron 的 setPath 只接受绝对路径）。 */
export function dirFromEnv(v: string | undefined, home: string = homedir()): string | null {
  const t = v?.trim();
  if (!t) return null;
  if (t === "~") return home;
  if (t.startsWith("~/") || t.startsWith("~\\")) return join(home, t.slice(2));
  return isAbsolute(t) ? t : resolve(t);
}

/**
 * 数据目录：SHIPHERD_HOME > BUTLER_HOME（改名前的变量，TODO(5.0) 删）> ~/.shipherd。
 * Shipherd 和 hook（hook/*.ts）都用它，两边算出来的目录才一致。
 */
export function homeFromEnv(env: Record<string, string | undefined>, home: string = homedir()): string {
  return dirFromEnv(envValue(env, "HOME"), home) ?? join(home, ".shipherd");
}

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ShipherdPaths {
  const shipherdHome = homeFromEnv(env, home);
  const configOverride = dirFromEnv(env.CLAUDE_CONFIG_DIR, home);
  const claudeConfigDir = configOverride ?? join(home, ".claude");
  const inbox = join(shipherdHome, "inbox");
  const bin = join(shipherdHome, "bin");
  return {
    home: shipherdHome,
    db: join(shipherdHome, "app.db"),
    inbox,
    inboxBad: join(inbox, "bad"),
    bin,
    hookBin: join(bin, platform === "win32" ? "shipherd-hook.exe" : "shipherd-hook"),
    logs: join(shipherdHome, "logs"),
    mcp: join(shipherdHome, "mcp"),
    mailbox: join(shipherdHome, "mailbox"),
    procsOwned: join(shipherdHome, "procs", "owned.json"),
    statecore: join(shipherdHome, "statecore"),
    workspaces: join(shipherdHome, "workspaces"),
    shipherdWorkspace: join(shipherdHome, "workspaces", "_shipherd"),
    lessonsWorkspace: join(shipherdHome, "workspaces", "_lessons"),
    refresh: join(shipherdHome, "refresh"),
    controlRequests: join(shipherdHome, "control", "requests"),
    controlResults: join(shipherdHome, "control", "results"),
    gateRequests: join(shipherdHome, "gate", "requests"),
    gateResults: join(shipherdHome, "gate", "results"),
    gateAlive: join(shipherdHome, "gate", "alive.json"),
    ...checksLayout(shipherdHome),
    claudeConfigDir,
    claudeSettings: join(claudeConfigDir, "settings.json"),
    claudeProjects: join(claudeConfigDir, "projects"),
    claudeSessions: join(claudeConfigDir, "sessions"),
    claudeCommands: join(claudeConfigDir, "commands"),
    claudeJson: configOverride ? join(configOverride, ".claude.json") : join(home, ".claude.json"),
  };
}

/** 检查用到的几个位置；hook 和 Shipherd 都从 SHIPHERD_HOME 算，所以放在一处。 */
export function checksLayout(shipherdHome: string): { checksSnapshot: string; checksHits: string; checksState: string } {
  const dir = join(shipherdHome, "checks");
  return { checksSnapshot: join(dir, "snapshot.json"), checksHits: join(dir, "hits"), checksState: join(dir, "state") };
}

/**
 * 这个 session 换新前的对话尾巴文件（BTL-190 第 6 点）。路径只由 session id 决定：下一次换新覆盖它，删 session 时按 id 找到它一起删。
 * id 里只留字母、数字、- 和 _（Claude Code 的 session id 是 UUID，本来就是这样），免得拼出别的目录。
 */
export function refreshTailPath(p: Pick<ShipherdPaths, "refresh">, sessionId: string): string {
  return join(p.refresh, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
}

export async function ensureDirs(p: ShipherdPaths): Promise<void> {
  for (const dir of [p.home, p.inbox, p.inboxBad, p.bin, p.logs, p.mcp, p.statecore, p.workspaces, p.refresh, p.controlRequests, p.controlResults, p.gateRequests, p.gateResults, p.checksHits, p.checksState]) {
    await mkdir(dir, { recursive: true });
  }
}
