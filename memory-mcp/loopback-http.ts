// 共享 MCP（WS-M H，设计文档 2026-11-17 §8）的 HTTP 监听：只绑 127.0.0.1，按 URL 里的 token 把 JSON-RPC 交给对应的 server。
// MCP Streamable HTTP 的无状态用法：只回 JSON（不开 SSE 流），不发 Mcp-Session-Id。
// ESLint 只允许这个文件从 node:http 拿 createServer（BTL-243）：它只收本机 claude 发来的请求，从不往外发。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** 一条 JSON-RPC 消息（请求、通知或回复）。 */
export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** 一个 token 对应的 server：处理一条消息，通知返回 null。 */
export type RpcHandler = (msg: RpcMessage) => Promise<object | null>;

export interface LoopbackMcp {
  port: number;
  close(): Promise<void>;
}

/** URL 里的 token：32 字节的 base64url（43 个字符）。 */
export const ROUTE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PATH_RE = /^\/mcp\/([^/?#]+)$/;
/** 请求体上限：工具参数都很小，4 MB 足够。 */
const MAX_BODY = 4 * 1024 * 1024;

/**
 * 在 127.0.0.1 上监听。port 是想要的端口（0 = 随便一个）；被占用时报错，调用方决定要不要换 0 再试。
 * route(token) 找不到时回 404（不是 401：401 会让 claude 去做 OAuth 发现）。
 */
export function startLoopbackMcp(o: { port: number; route: (token: string) => RpcHandler | null; log?: (msg: string, e?: unknown) => void }): Promise<LoopbackMcp> {
  let port = o.port;
  const server = createServer((req, res) => {
    void serve(req, res, port, o.route, o.log).catch((e: unknown) => {
      o.log?.("shared MCP request failed", e);
      if (!res.headersSent) send(res, 500);
      else res.end();
    });
  });
  // 工具调用可能要等 Butler 一阵（start_session 最多几分钟）：不按 Node 的默认 5 分钟掐断请求。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : o.port;
      server.on("error", (e) => o.log?.("shared MCP listener error", e));
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}

async function serve(req: IncomingMessage, res: ServerResponse, port: number, route: (token: string) => RpcHandler | null, log?: (msg: string, e?: unknown) => void): Promise<void> {
  // DNS rebinding：Host 必须正好是 127.0.0.1:<port>。浏览器发来的请求都带 Origin，一律不收。
  if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined) return send(res, 403);
  const m = PATH_RE.exec(req.url ?? "");
  const handler = m && ROUTE_TOKEN_RE.test(m[1]) ? route(m[1]) : null;
  if (!handler) return send(res, 404);
  // 没有 SSE 流、没有会话：GET（开流）和 DELETE（结束会话）按规范回 405。
  if (req.method !== "POST") return send(res, 405, undefined, { Allow: "POST" });
  const body = await readBody(req);
  if (body === null) return send(res, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const batch = Array.isArray(parsed);
  const msgs = (batch ? parsed : [parsed]) as unknown[];
  if (msgs.length === 0 || msgs.some((x) => typeof x !== "object" || x === null || Array.isArray(x))) {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  }
  const replies: object[] = [];
  for (const msg of msgs as RpcMessage[]) {
    // 通知和回复没有要回的东西。
    if (typeof msg.method !== "string" || msg.id === undefined || msg.id === null) {
      // 通知出错也照样回 202（没有地方可以回错误）。
      if (typeof msg.method === "string") await handler(msg).catch((e: unknown) => log?.("MCP notification failed", e));
      continue;
    }
    const r = await handler(msg).catch((e: unknown) => ({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } }));
    if (r) replies.push(r);
  }
  if (replies.length === 0) return send(res, 202);
  return send(res, 200, batch ? replies : replies[0]);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, { ...headers, "Content-Type": "application/json" }).end(JSON.stringify(body));
}
