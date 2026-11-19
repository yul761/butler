import { net } from "electron";
import { isLoopbackHost } from "../settings/settings-values";
import { M } from "../strings";

/** 和 provider 一样用 Electron 的 net.fetch（遵循系统代理）；单元测试里退回 Node 的 fetch。 */
const httpFetch: typeof fetch = (input, init) => (typeof net?.fetch === "function" ? net.fetch(input as string, init) : fetch(input, init));

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_URL_MAX = 2000;

/** webhook 地址：https，本机可以 http；不带账号密码。合规返回规范化的地址，否则 null。 */
export function parseWebhookUrl(v: string): URL | null {
  const t = v.trim();
  if (!t || t.length > WEBHOOK_URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname.replace(/^\[|\]$/g, ""))) return u;
  return null;
}

export interface WebhookRequest {
  url: string;
  body: string;
  contentType: string;
  /** 额外的头（ntfy 的 Title）；只收 ASCII 可见字符。 */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type WebhookResult = { ok: true; status: number } | { ok: false; status: number | null; error: string };

/**
 * 发一次 webhook（ws-j 设计 7）：只有 PrivacyGateway 调它。地址再查一遍；不带 cookie、不跟随重定向，10 秒超时。
 * 不抛错：失败的原因只用固定的几句话（不带响应正文）。
 */
export async function sendWebhook(r: WebhookRequest): Promise<WebhookResult> {
  const u = parseWebhookUrl(r.url);
  if (!u) return { ok: false, status: null, error: M().interrupts.webhookUrl };
  const headers: Record<string, string> = { "Content-Type": r.contentType };
  for (const [k, v] of Object.entries(r.headers ?? {})) if (/^[\x20-\x7e]{1,200}$/.test(v) && /^[A-Za-z-]{1,40}$/.test(k)) headers[k] = v;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), r.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  try {
    const res = await (r.fetch ?? httpFetch)(u.toString(), { method: "POST", headers, body: r.body, credentials: "omit", redirect: "error", signal: ctl.signal });
    // 不读正文，丢掉连接。
    void res.body?.cancel().catch(() => undefined);
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: M().interrupts.webhookHttp(res.status) };
  } catch {
    return { ok: false, status: null, error: ctl.signal.aborted ? M().interrupts.webhookTimeout : M().interrupts.webhookNetwork };
  } finally {
    clearTimeout(timer);
  }
}
