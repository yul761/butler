/**
 * 只给测试用的工具（不会被生产代码 import，所以不会打进主进程包）。
 * 放在 gateway 目录里：后面的假服务器要用 node:http，只有这里允许。
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { Rng } from "./types";

/** 可复现的随机数（mulberry32）。 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** 以 JSON 返回；给了 raw 时原样返回 raw。 */
  body?: unknown;
  raw?: string;
  /** 延迟多久再回复（测超时）。 */
  delayMs?: number;
}

export type FakeHandler = (req: FakeRequest, n: number) => FakeReply;

export interface FakeProvider {
  /** 形如 http://127.0.0.1:<port>/v1，可以直接填进 llmBaseUrl。 */
  baseUrl: string;
  requests: FakeRequest[];
  handle(fn: FakeHandler): void;
  close(): Promise<void>;
}

/** 一个成功的 chat.completion 响应。usage 为 null 时不带 usage 字段。 */
export function chatReply(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number } | null = { prompt_tokens: 120, completion_tokens: 40 },
): FakeReply {
  return {
    body: {
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      ...(usage ? { usage } : {}),
    },
  };
}

/** 进程内的假 OpenAI 兼容服务器，只监听 127.0.0.1。记录收到的每个请求，按 handle() 给的函数回复。 */
export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: FakeRequest[] = [];
  let handler: FakeHandler = () => chatReply('{"focus":["OK"]}');
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const r: FakeRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(r);
      const reply = handler(r, requests.length);
      const send = () => {
        if (res.destroyed || res.headersSent) return;
        res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
        res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    handle: (fn) => {
      handler = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
