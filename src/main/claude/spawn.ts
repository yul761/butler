import { HEADLESS_SESSION_PREFIX } from "../../shared/hook-envelope";
import { pathKey } from "../util/env";

export interface SpawnSpec {
  file: string;
  args: string[];
}

export function claudeArgs(req: { mode: "new" | "resume"; sessionId: string; mcpConfigPath?: string }): string[] {
  const args = req.mode === "new" ? ["--session-id", req.sessionId] : ["--resume", req.sessionId];
  if (req.mcpConfigPath) args.push("--mcp-config", req.mcpConfigPath);
  return args;
}

/** 直接用 PTY 跑 claude；只有 Windows 上 npm 装的 claude.cmd 需要经过 cmd.exe。 */
export function spawnSpec(claudePath: string, args: string[], platform: NodeJS.Platform): SpawnSpec {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(claudePath)) return { file: "cmd.exe", args: ["/c", claudePath, ...args] };
  return { file: claudePath, args };
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
  if (pathValue) out[pathKey(out)] = pathValue;
  return out;
}

/** 交互式终端里的 claude：挂上 ticket 和启动时的 session id。 */
export function sessionEnv(
  base: NodeJS.ProcessEnv,
  x: { pathValue: string; ticketKey: string; sessionId: string },
): Record<string, string> {
  const out = cleanEnv(base, x.pathValue);
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.BUTLER_TICKET = x.ticketKey;
  out.BUTLER_SESSION = x.sessionId;
  return out;
}

/** headless claude（handoff、刷新、MCP 探测）：不挂 ticket；BUTLER_SESSION 带 headless: 前缀，hook 上报会被整体忽略。 */
export function headlessEnv(base: NodeJS.ProcessEnv, x: { pathValue: string; runId: string }): Record<string, string> {
  const out = cleanEnv(base, x.pathValue);
  out.BUTLER_SESSION = `${HEADLESS_SESSION_PREFIX}${x.runId}`;
  return out;
}
