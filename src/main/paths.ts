import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ButlerPaths {
  home: string;
  db: string;
  inbox: string;
  inboxBad: string;
  bin: string;
  hookBin: string;
  logs: string;
  /** Butler 生成的 --mcp-config 文件。 */
  mcp: string;
  /** StateCore 的嵌入式存储目录（里面是 statecore.db）。 */
  statecore: string;
  claudeConfigDir: string;
  claudeSettings: string;
  claudeProjects: string;
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

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ButlerPaths {
  const butlerHome = dirFromEnv(env.BUTLER_HOME, home) ?? join(home, ".butler");
  const configOverride = dirFromEnv(env.CLAUDE_CONFIG_DIR, home);
  const claudeConfigDir = configOverride ?? join(home, ".claude");
  const inbox = join(butlerHome, "inbox");
  const bin = join(butlerHome, "bin");
  return {
    home: butlerHome,
    db: join(butlerHome, "app.db"),
    inbox,
    inboxBad: join(inbox, "bad"),
    bin,
    hookBin: join(bin, platform === "win32" ? "butler-hook.exe" : "butler-hook"),
    logs: join(butlerHome, "logs"),
    mcp: join(butlerHome, "mcp"),
    statecore: join(butlerHome, "statecore"),
    claudeConfigDir,
    claudeSettings: join(claudeConfigDir, "settings.json"),
    claudeProjects: join(claudeConfigDir, "projects"),
    claudeCommands: join(claudeConfigDir, "commands"),
    claudeJson: configOverride ? join(configOverride, ".claude.json") : join(home, ".claude.json"),
  };
}

export async function ensureDirs(p: ButlerPaths): Promise<void> {
  for (const dir of [p.home, p.inbox, p.inboxBad, p.bin, p.logs, p.mcp, p.statecore]) await mkdir(dir, { recursive: true });
}
