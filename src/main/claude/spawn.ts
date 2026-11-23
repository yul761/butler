import { HEADLESS_SESSION_PREFIX } from "../../shared/hook-envelope";
import { dirFromEnv } from "../paths";
import { pathKey } from "../util/env";
import { isCmdShim } from "./launch";

export interface SpawnSpec {
  file: string;
  args: string[];
}

/** session 的模型：别名（opus、sonnet、haiku、fable）或模型路由里登记的名字。 */
export type SessionModel = string;

const ALIASES: ReadonlySet<string> = new Set(["opus", "sonnet", "haiku", "fable"]);

/** 记下的模型：别名，或者 known 认得的名字（模型路由里登记的）；别的值（老数据、手改）当没记。 */
export function storedModel(s: { model: string | null }, known?: (model: string) => boolean): SessionModel | null {
  const m = s.model;
  if (!m) return null;
  return ALIASES.has(m) || known?.(m) ? m : null;
}

/** 子代理默认用 sonnet，省 token；用户环境里已有的值优先。 */
export const SUBAGENT_MODEL_DEFAULT = "sonnet";
/** Claude Code 自己的 auto-compact 窗口（token）；用户环境里已有的值优先。 */
export const AUTO_COMPACT_WINDOW_DEFAULT = "250000";

/**
 * model：不传（或 null）就用 Claude Code 自己的默认。
 * guidePath：Shipherd 的 session 说明文件。addDirs：总控 session 能看到的额外目录（每个一个 --add-dir）。settingsPath：Shipherd 写的 --settings 文件（自动启用仓库 .mcp.json 的 server）。
 * 只有路径，prompt 永远不进 argv。
 */
export function claudeArgs(req: { mode: "new" | "resume"; sessionId: string; mcpConfigPath?: string; settingsPath?: string; addDirs?: string[]; guidePath?: string; model?: SessionModel | null }): string[] {
  const args = req.mode === "new" ? ["--session-id", req.sessionId] : ["--resume", req.sessionId];
  if (req.mcpConfigPath) args.push("--mcp-config", req.mcpConfigPath);
  if (req.settingsPath) args.push("--settings", req.settingsPath);
  for (const dir of req.addDirs ?? []) args.push("--add-dir", dir);
  if (req.guidePath) args.push("--append-system-prompt-file", req.guidePath);
  if (req.model) args.push("--model", req.model);
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
 * 外层 Claude Code 会话注入的会话级标记。Shipherd 若从一个 claude 会话里启动，这些变量会被继承，
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

/** 去掉 Electron 和外层 Claude Code 的标记变量（以及 Shipherd 自己的标记），换上登录 shell 的 PATH。 */
function cleanEnv(base: NodeJS.ProcessEnv, pathValue: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("ELECTRON_") || PARENT_SESSION_VARS.has(k) || k === "SHIPHERD_TICKET" || k === "SHIPHERD_SESSION") continue;
    out[k] = v;
  }
  // 相对路径按 Shipherd 自己的当前目录解析成绝对路径：子进程的 cwd 不同，hook 才会写到同一个 inbox。
  for (const k of ["SHIPHERD_HOME", "CLAUDE_CONFIG_DIR"]) {
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
  if (x.ticketKey !== undefined) out.SHIPHERD_TICKET = x.ticketKey;
  out.SHIPHERD_SESSION = x.sessionId;
  // 用户自己的环境里有就不动。
  out.CLAUDE_CODE_SUBAGENT_MODEL ??= SUBAGENT_MODEL_DEFAULT;
  out.CLAUDE_CODE_AUTO_COMPACT_WINDOW ??= AUTO_COMPACT_WINDOW_DEFAULT;
  bypassProxyForLoopback(out);
  return out;
}

/**
 * 设了代理（HTTP_PROXY 之类）时把 127.0.0.1 加进 NO_PROXY：共享 MCP（WS-M H）的 URL 是本机回环，不能被送去代理（连不上，token 还会给代理看到）。
 * 没设代理不动。已有的 NO_PROXY / no_proxy 不论大小写都在原来的键上追加（Windows 上环境变量不分大小写，不能有两个）。
 */
export function bypassProxyForLoopback(env: Record<string, string>): void {
  const keys = Object.keys(env);
  const has = (name: string) => keys.some((k) => k.toLowerCase() === name && env[k].trim() !== "");
  if (!["http_proxy", "https_proxy", "all_proxy"].some(has)) return;
  const noProxy = keys.filter((k) => k.toLowerCase() === "no_proxy");
  if (noProxy.length === 0) noProxy.push(...(process.platform === "win32" ? ["NO_PROXY"] : ["NO_PROXY", "no_proxy"]));
  for (const k of noProxy) {
    const list = (env[k] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!list.includes("127.0.0.1") && !list.includes("*")) env[k] = [...list, "127.0.0.1"].join(",");
  }
}

/** headless claude（handoff、刷新、MCP 探测）：不挂 ticket；SHIPHERD_SESSION 带 headless: 前缀，hook 上报会被整体忽略。 */
export function headlessEnv(base: NodeJS.ProcessEnv, x: { pathValue: string; runId: string }): Record<string, string> {
  const out = cleanEnv(base, x.pathValue);
  out.SHIPHERD_SESSION = `${HEADLESS_SESSION_PREFIX}${x.runId}`;
  return out;
}
