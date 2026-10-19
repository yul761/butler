import { existsSync } from "node:fs";
import path from "node:path";
import { execText, type ExecText } from "../util/exec";
import { pathKey } from "../util/env";

const START = "__BUTLER_PATH_START__";
const END = "__BUTLER_PATH_END__";

/** 从 Finder/开始菜单启动的 GUI 应用拿不到用户 shell 配置里的 PATH，所以要问登录 shell。 */
export async function readLoginShellPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, run: ExecText = execText): Promise<string> {
  const fallback = env[pathKey(env)] ?? "";
  if (platform === "win32") return fallback;
  try {
    const out = await run(env.SHELL || "/bin/zsh", ["-ilc", `printf '%s%s%s' '${START}' "$PATH" '${END}'`], { timeoutMs: 5000 });
    const s = out.indexOf(START);
    const e = out.indexOf(END, s);
    return s === -1 || e === -1 ? fallback : out.slice(s + START.length, e);
  } catch {
    return fallback;
  }
}

export function findOnPath(
  name: string,
  pathValue: string,
  platform: NodeJS.Platform,
  pathext = ".EXE;.CMD;.BAT",
  exists: (p: string) => boolean = existsSync,
): string | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names = platform === "win32" ? pathext.split(";").filter(Boolean).map((ext) => name + ext.toLowerCase()) : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = p.join(dir, n);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function locateClaude(opts: {
  override: string;
  pathValue: string;
  platform: NodeJS.Platform;
  exists?: (p: string) => boolean;
  pathext?: string;
}): string | null {
  const exists = opts.exists ?? existsSync;
  const override = opts.override.trim();
  if (override) return exists(override) ? override : null;
  return findOnPath("claude", opts.pathValue, opts.platform, opts.pathext, exists);
}
