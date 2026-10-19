import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ButlerPaths {
  home: string;
  db: string;
  inbox: string;
  inboxBad: string;
  bin: string;
  hookBin: string;
  logs: string;
  claudeConfigDir: string;
  claudeSettings: string;
  claudeProjects: string;
  claudeCommands: string;
}

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ButlerPaths {
  const butlerHome = env.BUTLER_HOME?.trim() || join(home, ".butler");
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
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
    claudeConfigDir,
    claudeSettings: join(claudeConfigDir, "settings.json"),
    claudeProjects: join(claudeConfigDir, "projects"),
    claudeCommands: join(claudeConfigDir, "commands"),
  };
}

export async function ensureDirs(p: ButlerPaths): Promise<void> {
  for (const dir of [p.home, p.inbox, p.inboxBad, p.bin, p.logs]) await mkdir(dir, { recursive: true });
}
