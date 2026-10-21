import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import type { McpProbe } from "../../shared/types";
import { killTree, unsafeCmdArg } from "./headless";

/** 读到 init 就结束，模型还没开始回答。不落盘，权限全拒。 */
export const PROBE_ARGS = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "dontAsk"];

const READ_WORDS = new Set(["get", "list", "search", "read", "view", "fetch", "query", "find", "lookup", "describe"]);
/** 任何一个词在这里，整个工具就不建议（get_or_create、search_and_replace、execute_query……）。 */
const WRITE_WORDS = new Set([
  "create", "update", "delete", "remove", "transition", "comment", "edit", "write", "add", "set", "send", "post", "put", "patch", "assign",
  "merge", "close", "run", "execute", "replace", "move", "upload", "import", "archive", "insert", "upsert", "modify", "rename", "approve",
  "reject", "publish", "sync", "trigger", "invoke", "call",
]);

/** claude 给 server 名做的清洗（验证记录 V3）：非 [A-Za-z0-9_-] 的字符换成 _。 */
const sanitizeServerName = (n: string): string => n.replace(/[^A-Za-z0-9_-]/g, "_");

/** 工具名去掉 mcp__<server>__ 前缀；认得 server 时按最长前缀，否则取最后一个 __ 段。 */
function toolPart(tool: string, servers: string[]): string {
  let best = "";
  for (const s of servers) {
    const prefix = `mcp__${sanitizeServerName(s)}__`;
    if (tool.startsWith(prefix) && prefix.length > best.length) best = prefix;
  }
  if (best) return tool.slice(best.length);
  return tool.split("__").pop() ?? tool;
}

/** 工具部分按下划线、连字符和驼峰拆词：至少一个查询类动词，且没有任何写类动词，才算“只读建议”。 */
export function suggestReadOnly(tools: string[], serverNames: string[] = []): string[] {
  return tools.filter((t) => {
    const words = toolPart(t, serverNames).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean).map((w) => w.toLowerCase());
    return words.some((w) => READ_WORDS.has(w)) && !words.some((w) => WRITE_WORDS.has(w));
  });
}

export function parseInitMessage(line: string): McpProbe | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as { type?: unknown; subtype?: unknown; tools?: unknown; mcp_servers?: unknown };
  if (o.type !== "system" || o.subtype !== "init") return null;
  const tools = (Array.isArray(o.tools) ? o.tools : []).filter((t): t is string => typeof t === "string" && t.startsWith("mcp__")).sort();
  const servers = (Array.isArray(o.mcp_servers) ? o.mcp_servers : []).flatMap((s) => {
    const x = s as { name?: unknown; status?: unknown } | null;
    return x && typeof x.name === "string" ? [{ name: x.name, status: typeof x.status === "string" ? x.status : "" }] : [];
  });
  return { servers, tools, suggested: suggestReadOnly(tools, servers.map((s) => s.name)) };
}

const PROBE_TIMEOUT_MS = 60_000;
const BUF_LIMIT = 8 * 1024 * 1024;

/**
 * 起一个 headless claude，读到 init 就杀掉整棵进程树（不留下 MCP server 孤儿进程）。
 * env 由调用方用 headlessEnv() 生成；prompt 只走 stdin。超时、取消、提前退出都会 settle。
 */
export function probeMcpTools(o: { claudePath: string; cwd: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<McpProbe> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let done = false;
    let buf = "";
    const finish = (err: Error | null, value?: McpProbe): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (child) {
        killTree(child);
        // 后代进程可能还握着管道：放手，不等 close。
        child.stdin?.destroy();
        child.stdout?.destroy();
      }
      if (err) reject(err);
      else resolve(value as McpProbe);
    };
    const timer = setTimeout(() => finish(new Error("等待 claude 启动超时，没有收到 init 消息")), o.timeoutMs ?? PROBE_TIMEOUT_MS);
    function onAbort(): void {
      finish(new Error("已取消"));
    }

    if (o.signal?.aborted) {
      finish(new Error("已取消"));
      return;
    }
    if (unsafeCmdArg(PROBE_ARGS, o.claudePath, process.platform) !== null) {
      finish(new Error("参数在 Windows 的 .cmd 下无法安全传递"));
      return;
    }
    try {
      // POSIX 上独立进程组，killTree 才能整组杀掉。
      child = spawn(o.claudePath, PROBE_ARGS, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (e) {
      finish(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const probe = parseInitMessage(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (probe) {
          // 假设（验证记录 V3）：init 在第一次模型请求之前发出（init 约 2 秒，第一条 assistant 约 5 秒），
          // 所以读到 init 就杀进程不会花输出 token。任务 16 会用真实 claude 验证。
          finish(null, probe);
          return;
        }
      }
      if (buf.length > BUF_LIMIT) finish(new Error("claude 的输出过大且没有 init 消息"));
    });
    child.on("error", (e) => finish(e));
    child.on("close", () => {
      // 最后一行可能没有换行符。
      const last = parseInitMessage(buf);
      if (last) finish(null, last);
      else finish(new Error("claude 没有输出 init 消息就退出了"));
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end("Reply with OK.", "utf8");
  });
}
