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
  /** shim 设置的 NODE_PATH（pnpm）：子进程环境里照样加上（launchEnv）。 */
  nodePath?: string;
}

export interface LaunchDeps {
  /** 登录 shell 的 PATH（找 node.exe 用，只看绝对目录）。 */
  pathValue?: string;
  read?: (file: string) => string;
  exists?: (p: string) => boolean;
}

/** 从 claude.cmd 读出来的启动方式。 */
export interface CmdShim {
  /** node：用 node 执行 JS 入口；exe：直接执行原生程序（claude-code 2.1 起 npm 包的 bin 是 claude.exe）。 */
  kind: "node" | "exe";
  /** 入口相对 shim 所在目录的路径（可以有 ..，不能带盘符或 UNC 前缀）。 */
  target: string;
  /** shim 写在入口前面的 node 参数（只认白名单里的）。 */
  nodeArgs: string[];
  /** shim 固定的 node.exe 绝对路径（pnpm 管理的 node）。 */
  node?: string;
  /** shim 设置的 NODE_PATH（pnpm）。 */
  nodePath?: string;
}

/** shebang 带来的 node 参数：只有这几个原样照传，别的一律认不出（回退到 cmd.exe）。 */
const NODE_FLAGS = new Set(["--no-warnings", "--preserve-symlinks", "--preserve-symlinks-main"]);
/** npm 写 "%dp0%\..."，pnpm 写 "%~dp0\..."。 */
const DP0_TARGET = String.raw`"%(?:~dp0|dp0%)\\([^"%]+)"`;
/** npm cmd-shim 在 JS 入口那一行前面的固定前缀。 */
const NPM_PREFIX = String.raw`endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & `;
/** 执行 node 的程序：npm 的 %_prog%、shim 旁边的 node.exe、PATH 里的 node，或 pnpm 固定的绝对路径。 */
const NODE_PROG = String.raw`(?:"%_prog%"|"%(?:~dp0|dp0%)\\node\.exe"|node|"([A-Za-z]:\\[^"%]*\\node\.exe)")`;
/** 程序后面直接是（白名单 flag 和）入口，再后面只有 %*。 */
const NODE_LINE = new RegExp(String.raw`^@?(?:${NPM_PREFIX})?${NODE_PROG}((?:\s+[^\s"]+)*?)\s+${DP0_TARGET}\s+%\*$`, "i");
/** 原生入口：程序本身就是入口。 */
const EXE_LINE = new RegExp(String.raw`^@?${DP0_TARGET}\s+%\*$`, "i");
const PROG_SET_LINE = /^SET "_prog=(?:%dp0%\\node\.exe|node)"$/i;
const NODE_PATH_IF_LINE = /^@?IF NOT DEFINED NODE_PATH \($/i;
const NODE_PATH_SET_LINE = /^@?SET "NODE_PATH=([^"%]+?)(?:;%NODE_PATH%)?"$/i;
const PATH_SET_LINE = /\bSET\s+"?PATH=/i;

/** 只认 shim 目录下的相对路径（.. 可以）：带盘符、UNC 或根目录前缀的一律不认。 */
function contained(rel: string): boolean {
  return !path.win32.isAbsolute(rel) && !/^[\\/]/.test(rel) && !rel.includes(":");
}

/**
 * 读 npm（cmd-shim）/ pnpm 生成的 claude.cmd。只看真正执行的那一行（REM 注释不算），
 * 入口必须紧跟在程序后面、后面只有 %*；改 PATH、执行别的东西、带白名单以外参数的 shim 一律认不出（null）。
 */
export function parseCmdShim(content: string): CmdShim | null {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^@?(?:rem(?:\s|$)|::)/i.test(l));
  let found: CmdShim | null = null;
  const nodePaths = new Set<string>();
  for (const line of lines) {
    if (PATH_SET_LINE.test(line)) return null;
    if (/_prog=/i.test(line) && !PROG_SET_LINE.test(line)) return null;
    if (/NODE_PATH/i.test(line) && !line.includes("%*")) {
      const set = NODE_PATH_SET_LINE.exec(line);
      if (set) nodePaths.add(set[1]);
      else if (!NODE_PATH_IF_LINE.test(line)) return null;
      continue;
    }
    if (!line.includes("%*")) continue;
    let shim: CmdShim;
    const exe = EXE_LINE.exec(line);
    const node = exe ? null : NODE_LINE.exec(line);
    if (exe) {
      if (!/\.exe$/i.test(exe[1])) return null;
      shim = { kind: "exe", target: exe[1], nodeArgs: [] };
    } else if (node) {
      const nodeArgs = node[2].trim().split(/\s+/).filter(Boolean);
      if (!/\.[cm]?js$/i.test(node[3]) || nodeArgs.some((a) => !NODE_FLAGS.has(a))) return null;
      shim = { kind: "node", target: node[3], nodeArgs, ...(node[1] ? { node: node[1] } : {}) };
    } else {
      return null;
    }
    if (!contained(shim.target)) return null;
    // pnpm 的 IF EXIST 两个分支都执行同一个入口：不一致就不认。
    if (found && (found.kind !== shim.kind || found.target !== shim.target || found.node !== shim.node || found.nodeArgs.join(" ") !== shim.nodeArgs.join(" "))) return null;
    found = shim;
  }
  if (!found || nodePaths.size > 1) return null;
  const [nodePath] = nodePaths;
  return nodePath ? { ...found, nodePath } : found;
}

export function isCmdShim(file: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/**
 * Windows 上 npm / pnpm 装的 claude.cmd 不经过 cmd.exe：原生入口直接执行，JS 入口用 node 执行。
 * 参数（例如带空格的 --mcp-config 路径）原样传递，taskkill /T 也能找到整棵进程树。
 * node：shim 固定了绝对路径就用它；否则 shim 旁边有 node.exe 就用它，再否则在 PATH 的绝对目录里找。
 * 认不出来、入口或 node 不存在时回退到 cmd.exe /c。
 */
export function resolveLaunch(claudePath: string, args: string[], platform: NodeJS.Platform, deps: LaunchDeps = {}): Launch {
  if (!isCmdShim(claudePath, platform)) return { file: claudePath, args, viaCmd: false };
  const read = deps.read ?? ((f: string) => readFileSync(f, "utf8"));
  const exists = deps.exists ?? existsSync;
  try {
    const shim = parseCmdShim(read(claudePath));
    if (shim) {
      const dir = path.win32.dirname(claudePath);
      const target = path.win32.resolve(dir, shim.target);
      const extra = shim.nodePath ? { nodePath: shim.nodePath } : {};
      if (exists(target)) {
        if (shim.kind === "exe") return { file: target, args, viaCmd: false, ...extra };
        const local = path.win32.join(dir, "node.exe");
        const node =
          shim.node !== undefined
            ? exists(shim.node)
              ? shim.node
              : null
            : exists(local)
              ? local
              : findOnPath("node", absolutePathEntries(deps.pathValue ?? "", "win32"), "win32", ".EXE", exists);
        if (node) return { file: node, args: [...shim.nodeArgs, target, ...args], viaCmd: false, ...extra };
      }
    }
  } catch {
    // 读不了 shim：按原来的方式经过 cmd.exe。
  }
  return { file: "cmd.exe", args: ["/c", claudePath, ...args], viaCmd: true };
}

/** 给 cross-spawn 用：认出了 shim 就直接起程序；认不出来就把 .cmd 原样交给 cross-spawn（它会按 cmd.exe 的规则转义）。 */
export function childLaunch(claudePath: string, args: string[], platform: NodeJS.Platform, deps: LaunchDeps = {}): Launch {
  const l = resolveLaunch(claudePath, args, platform, deps);
  return l.viaCmd ? { file: claudePath, args, viaCmd: true } : l;
}

/** 解析一次的启动方式再接上参数（P5-PF10：安全检查和真正启动用同一个结果，shim 中途被换掉也不会绕过检查）。 */
export function withArgs(l: Launch, args: string[]): Launch {
  return { ...l, args: [...l.args, ...args] };
}

/** 子进程环境：加上 shim 会设置的 NODE_PATH（和 shim 一样，已有的 NODE_PATH 接在后面）。 */
export function launchEnv(l: Launch, env: Record<string, string>): Record<string, string> {
  if (!l.nodePath) return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "NODE_PATH") ?? "NODE_PATH";
  return { ...env, [key]: env[key] ? `${l.nodePath};${env[key]}` : l.nodePath };
}

/**
 * 后台运行和 MCP 探测共用的启动方式：POSIX 上独立进程组（killTree 才能整组杀掉），Windows 上不弹窗口。
 * l 由调用方用 childLaunch 算好，并据它的 viaCmd 做过参数检查（P5-PF10）。
 */
export function spawnClaude(l: Launch, o: { cwd: string; env: Record<string, string>; stdio: StdioOptions }): ChildProcess {
  return spawn(l.file, l.args, { cwd: o.cwd, env: launchEnv(l, o.env), stdio: o.stdio, windowsHide: true, detached: process.platform !== "win32" });
}
