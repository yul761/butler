/**
 * 只给测试用的工具（不会被生产代码 import，所以不会打进主进程包）。
 * 放在 gateway 目录里：后面的假服务器要用 node:http，只有这里允许。
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrivacyLevel } from "../../shared/llm";
import { AuditRepo } from "../db/audit-repo";
import { SecretsRepo } from "../db/secrets-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TermsRepo } from "../db/terms-repo";
import { memDb } from "../test-utils";
import { PrivacyGateway } from "./gateway";
import { KeyStore, type SecretBox } from "./key-store";
import type { ChatCall } from "./provider";
import type { NarrativeSource, Rng } from "./types";

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
      let reply: FakeReply;
      try {
        reply = handler(r, requests.length);
      } catch (e) {
        reply = { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
      }
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

export type FakeSecretBox = SecretBox & { setAvailable(v: boolean): void; setBroken(v: boolean): void };

/** 可逆的假加密（逐字节异或），用来证明落盘的不是明文；可以模拟“加密不可用”和“解不开”。 */
export function fakeSecretBox(o: { available?: boolean; broken?: boolean } = {}): FakeSecretBox {
  let available = o.available ?? true;
  let broken = o.broken ?? false;
  const xor = (b: Uint8Array) => b.map((x) => x ^ 0x5a);
  return {
    available: () => available,
    encrypt: (plain) => xor(new TextEncoder().encode(plain)),
    decrypt: (data) => {
      if (broken) throw new Error("decrypt failed");
      return new TextDecoder().decode(xor(data));
    },
    setAvailable: (v) => {
      available = v;
    },
    setBroken: (v) => {
      broken = v;
    },
  };
}

/** 夹具里的“现在”：2026-10-21（周三）09:00。 */
export const HARNESS_NOW = new Date(2026, 9, 21, 9).getTime();

export interface GatewayHarness {
  gateway: PrivacyGateway;
  provider: FakeProvider;
  settings: SettingsRepo;
  audit: AuditRepo;
  terms: TermsRepo;
  keys: KeyStore;
  box: FakeSecretBox;
  /** 每次发送前确认收到的文本。 */
  confirms: string[];
  logs: string[];
  setNow(ms: number): void;
  setConfirm(fn: (text: string) => Promise<boolean>): void;
  /** 假服务器收到的所有请求体。 */
  bodies(): string[];
  close(): Promise<void>;
}

/**
 * 一个连着本地假服务器、用内存数据库的 PrivacyGateway：档位默认 metadata，价格 * 1 2，月预算 5 美元，不需要 key（本机地址）。
 * chat：替换真正的 chatCompletion（测“什么都没发出去就失败”这类本地服务器造不出来的情况）。
 * log：每条日志记进 logs 之后再交给它（测“日志本身抛错”）。
 */
export async function gatewayHarness(
  o: { level?: PrivacyLevel; rng?: Rng; chat?: ChatCall; log?: (msg: string, err?: unknown) => void } = {},
): Promise<GatewayHarness> {
  const db = memDb();
  const settings = new SettingsRepo(db);
  const audit = new AuditRepo(db);
  const terms = new TermsRepo(db);
  const box = fakeSecretBox();
  const logs: string[] = [];
  const keys = new KeyStore({ secrets: new SecretsRepo(db), box, now: () => 1, log: (m) => logs.push(m) });
  const provider = await startFakeProvider();
  settings.set("llmLevel", o.level ?? "metadata");
  settings.set("llmBaseUrl", provider.baseUrl);
  settings.set("llmModel", "fake-model");
  settings.set("llmPrices", "* 1 2");
  settings.set("llmMonthlyBudgetUsd", "5");
  let now = HARNESS_NOW;
  let confirm: (text: string) => Promise<boolean> = async () => true;
  const confirms: string[] = [];
  const gateway = new PrivacyGateway({
    settings, audit, terms, keys, now: () => now, rng: o.rng, chat: o.chat,
    confirm: (text) => {
      confirms.push(text);
      return confirm(text);
    },
    log: (m, e) => {
      logs.push(e === undefined ? m : `${m} ${e instanceof Error ? e.message : String(e)}`);
      o.log?.(m, e);
    },
  });
  return {
    gateway, provider, settings, audit, terms, keys, box, confirms, logs,
    setNow: (ms) => {
      now = ms;
    },
    setConfirm: (fn) => {
      confirm = fn;
    },
    bodies: () => provider.requests.map((r) => r.body),
    close: () => provider.close(),
  };
}

/** 典型的简报数据：PROJ-12（进行中，带自由文本）和 PROJ-123（等 review，PR 已批准），仓库 acme-billing，分支 feature/PROJ-12-login。 */
export function sampleSource(): NarrativeSource {
  return {
    date: "2026-10-21",
    tickets: [
      {
        key: "PROJ-12", status: "active", pr: null, daysInStatus: 1, idleDays: 0, doneLastDay: 2,
        nextSteps: ["修好 PROJ-12 的登录"], blockers: [],
        followups: [{ kind: "config", trigger: "after_merge", description: "改 acme-billing 的 staging 配置", overdueDays: null }],
      },
      {
        key: "PROJ-123", status: "in_review", pr: { state: "open", review: "approved" }, daysInStatus: 3, idleDays: 1, doneLastDay: 0,
        nextSteps: [], blockers: [], followups: [],
      },
    ],
    items: [
      { section: "first", rule: "pr_approved", ticketKey: "PROJ-123", days: null, count: null },
      { section: "today", rule: "next_step", ticketKey: "PROJ-12", days: null, count: null },
    ],
    known: { tickets: ["PROJ-12", "PROJ-123"], repos: ["acme-billing"], branches: ["feature/PROJ-12-login"] },
  };
}
