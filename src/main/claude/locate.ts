import { existsSync } from "node:fs";
import path from "node:path";
import { execText, type ExecText } from "../util/exec";
import { pathKey } from "../util/env";

const START = "__SHIPHERD_PATH_START__";
const END = "__SHIPHERD_PATH_END__";

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

/** PATH 里只保留绝对目录（去掉 Windows 条目两边的引号）：相对目录等于“当前目录”，仓库里的人能往里放同名程序。 */
export function absolutePathEntries(pathValue: string, platform: NodeJS.Platform): string {
  const sep = platform === "win32" ? ";" : ":";
  const p = platform === "win32" ? path.win32 : path.posix;
  return pathValue
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d && p.isAbsolute(d))
    .join(sep);
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

/**
 * PATH 里没有 claude 时再看的几个常见安装位置（BTL-249）：都在用户目录下。官方安装脚本装到 ~/.local/bin，
 * 有的 shell 配置只在交互 shell 里把它加进 PATH，从 Finder 启动时登录 shell 的 PATH 里就没有。
 * 不看 /usr/local/bin、/opt/homebrew/bin 这类系统目录：它们本来就在登录 shell 的 PATH 里。
 */
export function wellKnownClaudePaths(platform: NodeJS.Platform, env: { home?: string; appData?: string }): string[] {
  const out: string[] = [];
  if (platform === "win32") {
    const p = path.win32;
    if (env.home) out.push(p.join(env.home, ".local", "bin", "claude.exe"));
    if (env.appData) out.push(p.join(env.appData, "npm", "claude.cmd"));
    return out;
  }
  if (env.home) out.push(path.posix.join(env.home, ".local", "bin", "claude"), path.posix.join(env.home, ".claude", "local", "claude"));
  return out;
}

export function locateClaude(opts: {
  override: string;
  pathValue: string;
  platform: NodeJS.Platform;
  exists?: (p: string) => boolean;
  pathext?: string;
  /** PATH 里没找到时依次看的位置（wellKnownClaudePaths）。 */
  fallbacks?: readonly string[];
}): string | null {
  const exists = opts.exists ?? existsSync;
  const override = opts.override.trim();
  if (override) return exists(override) ? override : null;
  return findOnPath("claude", opts.pathValue, opts.platform, opts.pathext, exists) ?? opts.fallbacks?.find((p) => exists(p)) ?? null;
}
