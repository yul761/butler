import { HEADLESS_SESSION_PREFIX } from "../../shared/hook-envelope";
import { dirFromEnv } from "../paths";
import { pathKey } from "../util/env";
import { isCmdShim } from "./launch";

export interface SpawnSpec {
  file: string;
  args: string[];
}

/** addDirs：总控 session 能看到的额外目录（每个一个 --add-dir）。只有路径，prompt 永远不进 argv。 */
export function claudeArgs(req: { mode: "new" | "resume"; sessionId: string; mcpConfigPath?: string; addDirs?: string[] }): string[] {
  const args = req.mode === "new" ? ["--session-id", req.sessionId] : ["--resume", req.sessionId];
  if (req.mcpConfigPath) args.push("--mcp-config", req.mcpConfigPath);
  for (const dir of req.addDirs ?? []) args.push("--add-dir", dir);
  return args;
}

/**
 * 经过 cmd.exe 的 .cmd/.bat：参数里有空白、引号、括号或 cmd 元字符时没法安全传递，调用方不传这个参数。
 * 计划 5 起只有认不出的 shim（回退到 cmd.exe）才需要这道检查。
 */
export function cmdShimSafe(file: string, arg: string, platform: NodeJS.Platform): boolean {
  if (!isCmdShim(file, platform)) return true;
  return /^[^\s"&|<>^%()!]+$/.test(arg);
}

/**
 * 外层 Claude Code 会话注入的会话级标记。Butler 若从一个 claude 会话里启动，这些变量会被继承，
 * 被启动的 claude 会把自己当成子会话（例如不保存 transcript，导致无法 --resume），所以必须去掉。
 * 用户自己的配置（CLAUDE_CODE_USE_BEDROCK、ANTHROPIC_* 等）保留。
 */
const PARENT_SESSION_VARS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_PID",
]);

/** 去掉 Electron 和外层 Claude Code 的标记变量（以及 Butler 自己的标记），换上登录 shell 的 PATH。 */
function cleanEnv(base: NodeJS.ProcessEnv, pathValue: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("ELECTRON_") || PARENT_SESSION_VARS.has(k) || k === "BUTLER_TICKET" || k === "BUTLER_SESSION") continue;
    out[k] = v;
  }
  // 相对路径按 Butler 自己的当前目录解析成绝对路径：子进程的 cwd 不同，hook 才会写到同一个 inbox。
  for (const k of ["BUTLER_HOME", "CLAUDE_CONFIG_DIR"]) {
    const dir = dirFromEnv(out[k]);
    if (dir) out[k] = dir;
  }
  if (pathValue) out[pathKey(out)] = pathValue;
  return out;
}

/** 交互式终端里的 claude：挂上 ticket 和启动时的 session id。feature 总控没有 ticket（设计文档 2026-10-26）。 */
export function sessionEnv(
  base: NodeJS.ProcessEnv,
  x: { pathValue: string; ticketKey?: string; sessionId: string },
): Record<string, string> {
  const out = cleanEnv(base, x.pathValue);
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  if (x.ticketKey !== undefined) out.BUTLER_TICKET = x.ticketKey;
  out.BUTLER_SESSION = x.sessionId;
  return out;
}

/** headless claude（handoff、刷新、MCP 探测）：不挂 ticket；BUTLER_SESSION 带 headless: 前缀，hook 上报会被整体忽略。 */
export function headlessEnv(base: NodeJS.ProcessEnv, x: { pathValue: string; runId: string }): Record<string, string> {
  const out = cleanEnv(base, x.pathValue);
  out.BUTLER_SESSION = `${HEADLESS_SESSION_PREFIX}${x.runId}`;
  return out;
}
