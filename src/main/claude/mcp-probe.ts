import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import type { McpProbe } from "../../shared/types";
import { killTree, unsafeCmdArg } from "./headless";

/** 读到 init 就结束，模型还没开始回答。不落盘，权限全拒。 */
export const PROBE_ARGS = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "dontAsk"];

const READ_WORDS = new Set(["get", "list", "search", "read", "view", "fetch", "query", "find", "lookup", "describe"]);

/** 工具名的工具部分（mcp__server__tool 的 tool）按下划线和驼峰拆词，含查询类动词的算“只读建议”。 */
export function suggestReadOnly(tools: string[]): string[] {
  return tools.filter((t) => {
    const part = t.split("__").slice(2).join("__");
    const words = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).map((w) => w.toLowerCase());
    return words.some((w) => READ_WORDS.has(w));
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
  return { servers, tools, suggested: suggestReadOnly(tools) };
}

const PROBE_TIMEOUT_MS = 60_000;

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
          finish(null, probe);
          return;
        }
      }
    });
    child.on("error", (e) => finish(e));
    child.on("close", () => finish(new Error("claude 没有输出 init 消息就退出了")));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end("Reply with OK.", "utf8");
  });
}
