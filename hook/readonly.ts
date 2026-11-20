export type ReadonlyDecision = { allow: true } | { allow: false; reason: string };

/** 记忆类 MCP 工具（任何 server）只要名字以这些后缀结尾就是只读。 */
export const READONLY_MCP_SUFFIXES: readonly string[] = ["__recall", "__facts", "__why"];
/** butler-sessions 里只读的工具：所有 list_* 加 session_activity（精确匹配，不含 report / ask_user 等写操作）。 */
export const READONLY_SESSIONS_TOOLS: readonly string[] = ["list_epics", "list_features", "list_tickets", "list_prs", "list_repos", "list_sessions", "list_inbox", "list_stacks", "session_activity"];

const SESSIONS_PREFIX = "mcp__butler-sessions__";
const PLAIN_TOOLS = new Set(["Read", "Grep", "Glob", "TodoWrite", "ToolSearch"]);
// 链接、重定向、命令替换、换行、--output（git diff/log 带它会写文件）一律不放。
const BAD_SHELL = /[;&|<>`\n\r]|\$\(|--output/;
const READ_GIT = /^git (status|diff|log|show)(\s|$)/;

const DENY: ReadonlyDecision = Object.freeze({ allow: false, reason: "This is a read-only forked discussion: only Read, Grep, Glob and git status/diff/log/show are allowed; nothing may be changed." });

/** 分叉讨论的只读白名单；不认识的一律拒绝。 */
export function readonlyDecision(input: unknown): ReadonlyDecision {
  if (typeof input !== "object" || input === null) return DENY;
  const p = input as { tool_name?: unknown; tool_input?: { command?: unknown } | null };
  const name = p.tool_name;
  if (typeof name !== "string") return DENY;
  if (PLAIN_TOOLS.has(name)) return { allow: true };
  if (name === "Bash") {
    const command = p.tool_input?.command;
    if (typeof command !== "string" || BAD_SHELL.test(command)) return DENY;
    return READ_GIT.test(command) ? { allow: true } : DENY;
  }
  if (name.startsWith("mcp__")) {
    if (name.startsWith(SESSIONS_PREFIX)) return READONLY_SESSIONS_TOOLS.includes(name.slice(SESSIONS_PREFIX.length)) ? { allow: true } : DENY;
    return READONLY_MCP_SUFFIXES.some((s) => name.endsWith(s)) ? { allow: true } : DENY;
  }
  return DENY;
}

/** 读 hook 的 stdin JSON，返回要写到 stdout 的文字；空串 = 放行。任何异常都拒绝（格式同 gate）。 */
export function runReadonly(raw: string): string {
  let d: ReadonlyDecision;
  try {
    d = readonlyDecision(JSON.parse(raw));
  } catch {
    d = DENY;
  }
  if (d.allow) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } });
}
