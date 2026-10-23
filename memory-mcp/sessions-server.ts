import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renameWithRetrySync } from "../src/main/util/fs-retry";
import { CONTROL_VERSION, TASK_LIMIT, type ControlRequest, type ControlResult } from "../src/shared/control";

/**
 * butler-sessions：只挂给总控 session 的 MCP server（设计文档 2026-10-23 第二步）。stdio 上按行收发 JSON-RPC 2.0；
 * 工具调用写成请求文件交给 Butler，等结果文件。不开端口，也不调用任何模型。
 */

export interface SessionsServerOptions {
  /** 这个总控属于哪个 ticket：来自 Butler 写的 mcp 配置，不来自模型。 */
  ticketKey: string;
  /** 总控自己的 session id（claude 传下来的 BUTLER_SESSION），子 session 记成由它开启。 */
  from: string | null;
  requestsDir: string;
  resultsDir: string;
  timeoutMs?: number;
  pollMs?: number;
  version?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER_NAME = "butler-sessions";
const DEFAULT_PROTOCOL = "2025-06-18";

export const TOOLS = [
  {
    name: "list_repos",
    description: "列出这个 ticket 的仓库（名字、工作目录、分支）。start_session 的 repo 参数用这里的名字。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "start_session",
    description:
      "在这个 ticket 的某个仓库里新开一个 Claude Code session，把 task 当作第一条消息发给它。新 session 会出现在 Butler 的同一个 ticket 下面，" +
      "用户可以看到、接手，权限确认仍由用户处理。各个 session 共享这个 ticket 的记忆：要交代的背景和约定先写进记忆。返回新 session 的 id。",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "仓库名（list_repos 里的 name）或工作目录" },
        task: { type: "string", description: `交给新 session 的任务，最长 ${TASK_LIMIT} 字` },
      },
      required: ["repo", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sessions",
    description: "列出这个 ticket 的 session：在哪个仓库、第一句话、是否在运行、是否在等用户输入、最近活动时间、是否由总控开启。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SessionsServer {
  /** 写出去、还没等到结果的请求文件。 */
  private readonly pending = new Set<string>();

  constructor(private readonly o: SessionsServerOptions) {}

  /** 退出前撤回还没被 Butler 拿走的请求：没人等结果了，不该再去开 session。 */
  withdrawAll(): void {
    for (const f of this.pending) {
      try {
        unlinkSync(f);
      } catch {
        // Butler 已经拿走了。
      }
    }
    this.pending.clear();
  }

  /** 处理一条消息；通知（没有 id）返回 null。 */
  async handle(msg: JsonRpcMessage): Promise<object | null> {
    const id = msg.id;
    const isRequest = id !== undefined && id !== null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: isRequest ? id : null, error: { code, message } });
    switch (msg.method) {
      case "initialize": {
        const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : DEFAULT_PROTOCOL;
        return reply({ protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: this.o.version ?? "1" } });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call":
        return reply(await this.call(msg.params ?? {}));
      default:
        if (!isRequest) return null;
        return fail(-32601, `method not found: ${String(msg.method)}`);
    }
  }

  private async call(params: Record<string, unknown>): Promise<object> {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const base = { v: CONTROL_VERSION, ticketKey: this.o.ticketKey, from: this.o.from } as const;
    let req: ControlRequest;
    switch (params.name) {
      case "list_repos":
        req = { ...base, op: "list_repos" };
        break;
      case "list_sessions":
        req = { ...base, op: "list_sessions" };
        break;
      case "start_session":
        if (typeof args.repo !== "string" || typeof args.task !== "string") return toolError("start_session 需要 repo 和 task 两个字符串参数");
        if (args.task.length > TASK_LIMIT) return toolError(`task 太长（最多 ${TASK_LIMIT} 字）`);
        req = { ...base, op: "start_session", repo: args.repo, task: args.task };
        break;
      default:
        return toolError(`没有这个工具：${String(params.name)}`);
    }
    const result = await this.send(req);
    if (!result) {
      return toolError(
        req.op === "start_session"
          ? "Butler 没有及时回应（可能没在运行）。session 也可能已经开了：重试之前先用 list_sessions 看一下。"
          : "Butler 没有回应（Butler 没在运行？）",
      );
    }
    if (!result.ok) return toolError(result.error);
    return { content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }] };
  }

  /** 写请求文件（临时文件 + rename），等同名的结果文件。超时返回 null，并撤回还没被处理的请求。 */
  async send(req: ControlRequest): Promise<ControlResult | null> {
    const id = randomUUID();
    mkdirSync(this.o.requestsDir, { recursive: true });
    const file = join(this.o.requestsDir, `${id}.json`);
    const tmp = join(this.o.requestsDir, `${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(req), { mode: 0o600 });
    renameWithRetrySync(tmp, file);
    this.pending.add(file);
    try {
      const resultFile = join(this.o.resultsDir, `${id}.json`);
      const end = Date.now() + (this.o.timeoutMs ?? 60_000);
      while (Date.now() < end) {
        if (existsSync(resultFile)) {
          let r: ControlResult | null = null;
          try {
            r = JSON.parse(readFileSync(resultFile, "utf8")) as ControlResult;
          } catch {
            // 结果文件还没写完（rename 之前不会出现，这里只是兜底）。
          }
          if (r) {
            try {
              unlinkSync(resultFile);
            } catch {
              // Windows 上可能被短暂占用：结果已经读到了，留下的文件由 Butler 定期清理。
            }
            return r;
          }
        }
        await sleep(this.o.pollMs ?? 200);
      }
      try {
        unlinkSync(file);
      } catch {
        // Butler 已经拿走了请求。
      }
      return null;
    } finally {
      this.pending.delete(file);
    }
  }
}

function toolError(text: string): object {
  return { content: [{ type: "text", text }], isError: true };
}

/** stdio：每行一条 JSON-RPC 消息，回复也是一行一条。 */
export function serveStdio(server: SessionsServer, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
  let buf = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
        continue;
      }
      void server.handle(msg).then(
        (r) => r && output.write(`${JSON.stringify(r)}\n`),
        (e: unknown) => output.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: String(e) } })}\n`),
      );
    }
  });
}
