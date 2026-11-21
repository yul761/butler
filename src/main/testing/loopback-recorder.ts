/**
 * 只给测试用（生产代码不 import，不会打进主进程包）。ESLint 只允许这个文件用 node:http 的 createServer 和 request（BTL-243）：
 * - 本机记录器：只听 127.0.0.1，记下收到的每个请求，按给的函数回复。用来证明 StateCore 一个请求也没发（bundle.test），也给 webhook 当收件方；
 * - 往本机回环地址发请求：测共享 MCP 的 HTTP 监听。
 */
import { createServer, request, type IncomingHttpHeaders } from "node:http";

/** 别的测试要用请求头类型时从这里拿：它们自己不能 import node:http。 */
export type RecordedHeaders = IncomingHttpHeaders;

export interface RecordedRequest {
  method: string;
  url: string;
  headers: RecordedHeaders;
  body: string;
}

export interface RecorderReply {
  status?: number;
  headers?: Record<string, string>;
  /** 原样返回的正文；不给时回 {}。 */
  raw?: string;
  /** 延迟多久再回复（测超时）。 */
  delayMs?: number;
}

export type RecorderHandler = (req: RecordedRequest, n: number) => RecorderReply;

export interface LoopbackRecorder {
  /** 形如 http://127.0.0.1:<port>/v1：可以填进任何 *_BASE_URL。 */
  baseUrl: string;
  /** http://127.0.0.1:<port><path>。 */
  url(path: string): string;
  requests: RecordedRequest[];
  handle(fn: RecorderHandler): void;
  close(): Promise<void>;
}

/** 在 127.0.0.1 的随机端口上开一个记录器。 */
export async function startLoopbackRecorder(handler: RecorderHandler = () => ({})): Promise<LoopbackRecorder> {
  const requests: RecordedRequest[] = [];
  let reply = handler;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const r: RecordedRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(r);
      let out: RecorderReply;
      try {
        out = reply(r, requests.length);
      } catch (e) {
        out = { status: 500, raw: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) };
      }
      const send = () => {
        if (res.destroyed || res.headersSent) return;
        res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
        res.end(out.raw ?? "{}");
      };
      if (out.delayMs) setTimeout(send, out.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    requests,
    handle: (fn) => {
      reply = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface LoopbackResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

/** 往 127.0.0.1:<port> 发一个请求。默认 POST、JSON。 */
export function loopbackRequest(
  port: number,
  o: { method?: string; path: string; body?: string; headers?: Record<string, string> },
): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1", port, method: o.method ?? "POST", path: o.path,
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...o.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

/** 向本机回环 MCP（共享 MCP 的 hub）POST 一条 JSON-RPC：状态码和 JSON 回复（不是 200 时 json 为 null）。 */
export async function postLoopback(port: number, path: string, body: object): Promise<{ status: number; json: unknown }> {
  const r = await loopbackRequest(port, { path, body: JSON.stringify(body) });
  return { status: r.status, json: r.status === 200 ? JSON.parse(r.body) : null };
}
