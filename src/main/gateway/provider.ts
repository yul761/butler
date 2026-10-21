import { formatDuration } from "../../shared/text";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatRequest {
  /** 规范化后的 base URL（normalizeBaseUrl），例如 https://api.deepseek.com/v1。 */
  baseUrl: string;
  /** 本机服务可以为 null。 */
  apiKey: string | null;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** 原样的响应体（写审计用）。 */
  raw: string;
  /** 实际发出的请求体（换参数名重试时是第二次的）。 */
  sentBody: string;
}

export type ProviderErrorKind = "http" | "timeout" | "network" | "bad_response" | "aborted";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null,
    /** 最后一次实际发出的请求体；没发出任何请求时为 null。 */
    public sentBody: string | null = null,
  ) {
    super(message);
  }
}

export type ChatCall = (req: ChatRequest) => Promise<ChatResponse>;

export const PROVIDER_TIMEOUT_MS = 60_000;
export const RESPONSE_LIMIT = 1_000_000;
type TokenParam = "max_tokens" | "max_completion_tokens";

export function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** 请求体就是审计里的“原样发出的内容”：key 在请求头里，永远不在请求体里。 */
export function chatBody(req: Pick<ChatRequest, "model" | "messages" | "maxTokens">, tokenParam: TokenParam = "max_tokens"): string {
  return JSON.stringify({ model: req.model, messages: req.messages, [tokenParam]: req.maxTokens, stream: false });
}

/** key 可能被回显的几种写法：原样、URL 编码、JSON 转义（例如 `/` 被写成 `\/`）。 */
function secretForms(secret: string): Set<string> {
  return new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), secret.replaceAll("/", "\\/")]);
}

/** 只去掉 key 本身（各种回显写法），不动其他文本。审计里的请求体用它：要原样展示发出去的内容。 */
export function scrubKey(text: string, secret: string | null): string {
  if (!secret || secret.length < 4) return text;
  let t = text;
  for (const form of secretForms(secret)) t = t.split(form).join("***");
  return t;
}

/** 去掉报错信息里的 key 和任何 Bearer 凭证（有的服务商把请求头原样回显）。 */
export function scrub(text: string, secret: string | null): string {
  let t = text;
  if (secret && secret.length >= 4) {
    for (const form of secretForms(secret)) t = t.split(form).join("***");
  }
  return t.replace(/Bearer\s+(?!\*\*\*(?![^\s"'\\,;]))[^\s"'\\,;]+/gi, "Bearer ***");
}

async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError("bad_response", `响应超过 ${limit} 个字符`);
    }
  }
  return out + decoder.decode();
}

function contentOf(v: unknown): string | null {
  const c = (v as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const text = c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
    return text || null;
  }
  return null;
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

function checkUrl(baseUrl: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new ProviderError("network", "base URL 无效");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  const okScheme = u.protocol === "https:" || (u.protocol === "http:" && loopback);
  if (!okScheme || u.search || u.hash || u.username || u.password) {
    throw new ProviderError("network", "base URL 不安全：必须是 https（本机可用 http），且不能带查询、片段或用户信息");
  }
}

async function attempt(req: ChatRequest, body: string, deadline: number, totalMs: number, state: { sent: string | null }): Promise<{ status: number; text: string }> {
  checkUrl(req.baseUrl);
  const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`;
  try {
    if (!signal.aborted) state.sent = body;
    const res = await fetch(chatUrl(req.baseUrl), { method: "POST", headers, body, signal, redirect: "error" });
    let raw: string;
    try {
      raw = await readCapped(res, RESPONSE_LIMIT);
    } catch (e) {
      // 带上 HTTP 状态：2xx 时服务商已经收下请求、可能已经计费。
      if (e instanceof ProviderError) throw new ProviderError(e.kind, e.message, res.status);
      throw e;
    }
    return { status: res.status, text: scrub(raw, req.apiKey) };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (req.signal?.aborted) throw new ProviderError("aborted", "已取消");
    if (timeout.aborted) throw new ProviderError("timeout", `超过 ${formatDuration(totalMs)}没有响应`);
    const cause = e instanceof Error ? `${e.message}${e.cause instanceof Error ? `：${e.cause.message}` : ""}` : String(e);
    throw new ProviderError("network", scrub(cause, req.apiKey));
  }
}

/** POST {baseUrl}/chat/completions。所有失败都抛 ProviderError，信息里不会有 key。整次调用共用一个截止时间。 */
export const chatCompletion: ChatCall = async (req) => {
  const totalMs = req.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const deadline = Date.now() + totalMs;
  let body = chatBody(req, "max_tokens");
  const state: { sent: string | null } = { sent: null };
  try {
    let r = await attempt(req, body, deadline, totalMs, state);
    // 有的模型只认 max_completion_tokens：400 且报错里提到它时换参数名重试一次（被拒的请求没有生成，不计费）。
    if (r.status === 400 && r.text.includes("max_completion_tokens")) {
      body = chatBody(req, "max_completion_tokens");
      r = await attempt(req, body, deadline, totalMs, state);
    }
    if (r.status < 200 || r.status >= 300) {
      throw new ProviderError("http", `HTTP ${r.status}：${r.text.slice(0, 300)}`, r.status);
    }
    let v: unknown;
    try {
      v = JSON.parse(r.text);
    } catch {
      throw new ProviderError("bad_response", "响应不是 JSON", r.status);
    }
    const content = contentOf(v);
    if (content === null) throw new ProviderError("bad_response", "响应里没有 choices[0].message.content", r.status);
    const usage = (v as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
    return { content, tokensIn: count(usage?.prompt_tokens), tokensOut: count(usage?.completion_tokens), raw: r.text, sentBody: body };
  } catch (e) {
    if (e instanceof ProviderError && e.sentBody === null) e.sentBody = state.sent;
    throw e;
  }
};
