import { NOTIFY_EVENTS, type NotifyEvent, type NotifyStatus } from "../../shared/interrupts";
import type { NotificationLogRepo } from "../db/interrupts-repo";
import type { ExternalActions } from "../external/actions";
import type { WebhookRequest, WebhookResult } from "../gateway/webhook";
import { normalizeNotifyEvents, normalizeQuietHours } from "../settings/settings-values";
import { M } from "../strings";

/** 同一类事件攒这么久再发一条。 */
export const NOTIFY_BATCH_MS = 60_000;

export type NotifySetting = "notifyFormat" | "notifyEvents" | "notifyDetails" | "notifyQuietHours";

/** 带编号时用的：ticket 号、PR 号（不带仓库名、路径、原文）。 */
export interface NotifyRef {
  ticketKey?: string | null;
  prNumber?: number | null;
}

export interface NotifierDeps {
  actions: Pick<ExternalActions, "allowed" | "attempt">;
  log: Pick<NotificationLogRepo, "insert" | "prune">;
  webhook: { get(): string | null };
  /** PrivacyGateway.postWebhook。 */
  post(r: Omit<WebhookRequest, "fetch">): Promise<WebhookResult>;
  setting(key: NotifySetting): string;
  now(): number;
  /** 本地时间的「几点几分」（分钟数，0–1439）；测试里固定。 */
  minuteOfDay?(at: number): number;
  /** 通知记录的保留期起点（和审计一样）；不给就不清理。 */
  cutoff?(now: number): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
  /** 记了一条（界面刷新）。 */
  changed?(): void;
  logError?(msg: string, err?: unknown): void;
}

/** "HH:MM-HH:MM" → 起止分钟；空的为 null。 */
function quietRange(v: string): [number, number] | null {
  let norm: string;
  try {
    norm = normalizeQuietHours(v);
  } catch {
    return null;
  }
  if (!norm) return null;
  const [a, b] = norm.split("-").map((x) => {
    const [h, m] = x.split(":").map(Number);
    return h! * 60 + m!;
  });
  return [a!, b!];
}

/** 现在在不在安静时段里（可以跨午夜：22:00-08:00）。 */
export function inQuietHours(v: string, minute: number): boolean {
  const r = quietRange(v);
  if (!r) return false;
  const [start, end] = r;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

const localMinute = (at: number): number => {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * 外部通知（ws-j 设计 7）：只推那五种事件；开关（对外动作 push_notification）关着时什么都不做、什么都不记。
 * 默认只说是哪类事、几件；notifyDetails 打开才带 ticket 号、PR 号。同一类事件攒一分钟发一条；安静时段里的直接丢掉（记 quiet）。
 */
export class Notifier {
  private readonly batches = new Map<NotifyEvent, { count: number; refs: Set<string>; timer: unknown }>();
  private lastPrune = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: NotifierDeps) {}

  private enabled(): boolean {
    try {
      return this.d.actions.allowed("push_notification");
    } catch {
      return false;
    }
  }

  private events(): readonly NotifyEvent[] {
    try {
      return normalizeNotifyEvents(this.d.setting("notifyEvents")).split(",").filter(Boolean) as NotifyEvent[];
    } catch {
      return NOTIFY_EVENTS;
    }
  }

  /** 来了一件事。不会抛错。 */
  emit(event: NotifyEvent, ref: NotifyRef = {}): void {
    try {
      if (!this.enabled()) return;
      const now = this.d.now();
      if (!this.events().includes(event)) return this.record({ ts: now, event, count: 1, status: "filtered" });
      if (inQuietHours(this.d.setting("notifyQuietHours"), (this.d.minuteOfDay ?? localMinute)(now))) return this.record({ ts: now, event, count: 1, status: "quiet" });
      const refText = [ref.ticketKey ?? null, ref.prNumber ? `#${ref.prNumber}` : null].filter((x): x is string => !!x).join(" ");
      const b = this.batches.get(event);
      if (b) {
        b.count++;
        if (refText) b.refs.add(refText);
        return;
      }
      const timer = (this.d.setTimer ?? setTimeout)(() => void this.flush(event), NOTIFY_BATCH_MS);
      (timer as { unref?: () => void } | null)?.unref?.();
      this.batches.set(event, { count: 1, refs: new Set(refText ? [refText] : []), timer });
    } catch (e) {
      this.d.logError?.("notifier: handling an event failed", e);
    }
  }

  /** 把攒着的这一类发出去（到点时调；测试里直接调）。 */
  async flush(event: NotifyEvent): Promise<void> {
    const b = this.batches.get(event);
    if (!b) return;
    this.batches.delete(event);
    (this.d.clearTimer ?? clearTimeout)(b.timer as ReturnType<typeof setTimeout>);
    // 攒的这一分钟里设置可能变了、也可能进了安静时段：发之前再看一次。
    if (!this.enabled()) return;
    const now = this.d.now();
    if (!this.events().includes(event)) return this.record({ ts: now, event, count: b.count, status: "filtered" });
    if (inQuietHours(this.d.setting("notifyQuietHours"), (this.d.minuteOfDay ?? localMinute)(now))) return this.record({ ts: now, event, count: b.count, status: "quiet" });
    const details = this.d.setting("notifyDetails").trim() === "1" && b.refs.size > 0 ? [...b.refs].slice(0, 10).join(", ") : null;
    let text = M().interrupts.notifyBody[event](b.count);
    if (details) text += M().interrupts.notifyDetails(details);
    await this.send(event, b.count, text);
  }

  /** 设置页上的「发一条测试」：开关关着也记一笔 skipped（审计页），返回结果。 */
  async test(): Promise<{ ok: boolean; error: string | null }> {
    return this.send("decision_needed", 0, M().interrupts.notifyTest);
  }

  private async send(event: NotifyEvent, count: number, text: string): Promise<{ ok: boolean; error: string | null }> {
    const ts = this.d.now();
    const url = this.d.webhook.get();
    if (!url) {
      const error = M().interrupts.webhookNotSaved;
      if (this.enabled()) this.record({ ts, event, count, status: "failed", error });
      return { ok: false, error };
    }
    const host = new URL(url).host;
    const req = this.request(url, event, count, text);
    try {
      const r = await this.d.actions.attempt("push_notification", { target: host, summary: M().interrupts.notifySummary(event, count), payload: text }, async () => {
        const res = await this.d.post(req);
        if (!res.ok) throw new Error(res.error);
        return res;
      });
      if (!r.ran) return { ok: false, error: M().interrupts.notifyOff };
      this.record({ ts, event, count, status: "sent", host, payload: text });
      return { ok: true, error: null };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.record({ ts, event, count, status: "failed", host, payload: text, error });
      return { ok: false, error };
    }
  }

  private request(url: string, event: NotifyEvent, count: number, text: string): Omit<WebhookRequest, "fetch"> {
    const title = M().interrupts.notifyTitle;
    if (this.d.setting("notifyFormat").trim() === "ntfy") return { url, body: text, contentType: "text/plain; charset=utf-8", headers: { Title: title } };
    return { url, body: JSON.stringify({ text: `${title}: ${text}`, content: `${title}: ${text}`, title, event, count }), contentType: "application/json" };
  }

  private record(e: { ts: number; event: NotifyEvent; count: number; status: NotifyStatus; host?: string | null; payload?: string | null; error?: string | null }): void {
    try {
      if (this.d.cutoff && e.ts - this.lastPrune >= 3600_000) {
        this.lastPrune = e.ts;
        this.d.log.prune(this.d.cutoff(e.ts));
      }
      this.d.log.insert({ ts: e.ts, event: e.event, count: e.count, status: e.status, host: e.host ?? null, payload: e.payload ?? null, error: e.error ?? null });
      this.d.changed?.();
    } catch (err) {
      this.d.logError?.("notifier: writing the notification log failed", err);
    }
  }

  /** 退出时丢掉攒着的（不在退出时发网络请求）。 */
  dispose(): void {
    for (const b of this.batches.values()) (this.d.clearTimer ?? clearTimeout)(b.timer as ReturnType<typeof setTimeout>);
    this.batches.clear();
  }
}

/**
 * 度量事件 → 要推的事件（设计 7 的表）：cost.pause / cost.stop（L）、pr_risk_high / pr_ready（G，契约 4.6）。别的都不推。
 * data 里只看 PR 号（prNumber 或 number），不看别的字段。
 */
export function notifyFromMetric(kind: string, refs: { ticketKey?: string | null; data?: Record<string, unknown> } = {}): { event: NotifyEvent; ref: NotifyRef } | null {
  const event: NotifyEvent | null =
    kind === "cost.pause" || kind === "cost.stop" ? "cost_breaker" : kind === "pr_risk_high" ? "pr_high_risk" : kind === "pr_ready" ? "pr_ready" : null;
  if (!event) return null;
  const n = refs.data?.prNumber ?? refs.data?.number;
  return { event, ref: { ticketKey: refs.ticketKey ?? null, prNumber: typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null } };
}
