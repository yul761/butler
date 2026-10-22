import type { ChildProcess, StdioOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import spawn from "cross-spawn";
import { absolutePathEntries, findOnPath } from "./locate";

/** 实际要执行的程序和参数。viaCmd：认不出 shim，只能经过 cmd.exe。 */
export interface Launch {
  file: string;
  args: string[];
  viaCmd: boolean;
}

export interface LaunchDeps {
  /** 登录 shell 的 PATH（找 node.exe 用，只看绝对目录）。 */
  pathValue?: string;
  read?: (file: string) => string;
  exists?: (p: string) => boolean;
}

/** npm 的 cmd-shim 写 "%dp0%\..."，pnpm 写 "%~dp0\..."：取出 JS 入口的相对路径。 */
const SHIM_SCRIPT_RE = /"%(?:~dp0|dp0%)\\([^"%]+?\.[cm]?js)"/i;

export function parseCmdShim(content: string): string | null {
  return SHIM_SCRIPT_RE.exec(content)?.[1] ?? null;
}

export function isCmdShim(file: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/**
 * Windows 上 npm / pnpm 装的 claude.cmd 直接用 node 执行它的 JS 入口，不经过 cmd.exe：
 * 参数（例如带空格的 --mcp-config 路径）原样传递，taskkill /T 也能找到整棵进程树。
 * shim 旁边有 node.exe 就用它，否则在 PATH 的绝对目录里找 node.exe。认不出来时回退到 cmd.exe /c。
 */
export function resolveLaunch(claudePath: string, args: string[], platform: NodeJS.Platform, deps: LaunchDeps = {}): Launch {
  if (!isCmdShim(claudePath, platform)) return { file: claudePath, args, viaCmd: false };
  const read = deps.read ?? ((f: string) => readFileSync(f, "utf8"));
  const exists = deps.exists ?? existsSync;
  try {
    const rel = parseCmdShim(read(claudePath));
    if (rel) {
      const dir = path.win32.dirname(claudePath);
      const script = path.win32.resolve(dir, rel);
      const local = path.win32.join(dir, "node.exe");
      const node = exists(local) ? local : findOnPath("node", absolutePathEntries(deps.pathValue ?? "", "win32"), "win32", ".EXE", exists);
      if (node && exists(script)) return { file: node, args: [script, ...args], viaCmd: false };
    }
  } catch {
    // 读不了 shim：按原来的方式经过 cmd.exe。
  }
  return { file: "cmd.exe", args: ["/c", claudePath, ...args], viaCmd: true };
}

/** 给 cross-spawn 用：认出了 shim 就直接起 node；认不出来就把 .cmd 原样交给 cross-spawn（它会按 cmd.exe 的规则转义）。 */
export function childLaunch(claudePath: string, args: string[], platform: NodeJS.Platform, deps: LaunchDeps = {}): Launch {
  const l = resolveLaunch(claudePath, args, platform, deps);
  return l.viaCmd ? { file: claudePath, args, viaCmd: true } : l;
}

/** 解析一次的启动方式再接上参数（P5-PF10：安全检查和真正启动用同一个结果，shim 中途被换掉也不会绕过检查）。 */
export function withArgs(l: Launch, args: string[]): Launch {
  return { file: l.file, args: [...l.args, ...args], viaCmd: l.viaCmd };
}

/**
 * 后台运行和 MCP 探测共用的启动方式：POSIX 上独立进程组（killTree 才能整组杀掉），Windows 上不弹窗口。
 * l 由调用方用 childLaunch 算好，并据它的 viaCmd 做过参数检查（P5-PF10）。
 */
export function spawnClaude(l: Launch, o: { cwd: string; env: Record<string, string>; stdio: StdioOptions }): ChildProcess {
  return spawn(l.file, l.args, { cwd: o.cwd, env: o.env, stdio: o.stdio, windowsHide: true, detached: process.platform !== "win32" });
}
