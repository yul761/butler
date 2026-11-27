// 预审徽标的数据（BTL-271）：页面上每枚徽标各自说要哪个 ticket / session / PR，同一轮渲染里的合成一次 IPC（prereview:status）。
// 之后每次 stateChanged 重取一次（防抖），只取还挂在页面上的。
import { useEffect, useSyncExternalStore } from "react";
import { PRE_REVIEW_STATUS_MAX, type PreReviewBadge, type PreReviewStatusBatch, type PreReviewStatusRequest, type PreReviewTicketStatus } from "../../../shared/prereview";
import { api } from "../api";
import { reportError } from "../errors";
import { STATE_DEBOUNCE_MS } from "./useStateRefetch";

type Kind = "tickets" | "sessions" | "prs";

export interface PreReviewStoreDeps {
  fetch(req: PreReviewStatusRequest): Promise<PreReviewStatusBatch>;
  onStateChanged(fn: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  report(e: unknown): void;
}

export class PreReviewStore {
  /** 页面上挂着的：id → 几枚徽标在用。 */
  private readonly want: Record<Kind, Map<string, number>> = { tickets: new Map(), sessions: new Map(), prs: new Map() };
  /** 取到的；session、PR 没有预审时存 null。 */
  private readonly cache = { tickets: new Map<string, PreReviewTicketStatus>(), sessions: new Map<string, PreReviewBadge | null>(), prs: new Map<string, PreReviewBadge | null>() };
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private timer = false;
  private seq = 0;
  private offState: (() => void) | null = null;

  constructor(private readonly d: PreReviewStoreDeps) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    // 第一枚徽标挂上时才开始听 stateChanged。
    this.offState ??= this.d.onStateChanged(() => this.schedule(STATE_DEBOUNCE_MS));
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.offState) {
        this.offState();
        this.offState = null;
      }
    };
  };

  readonly snapshot = (): number => this.version;

  /** 一枚徽标挂上：要这个 id；还没取过的马上（这一轮渲染之后）取。返回卸下时调的函数。 */
  hold(kind: Kind, id: string): () => void {
    const m = this.want[kind];
    m.set(id, (m.get(id) ?? 0) + 1);
    if (!this.cache[kind].has(id)) this.schedule(0);
    return () => {
      const n = (m.get(id) ?? 1) - 1;
      if (n > 0) m.set(id, n);
      else m.delete(id);
    };
  }

  ticket(key: string): PreReviewTicketStatus | undefined {
    return this.cache.tickets.get(key);
  }
  /** undefined = 还没取到；null = 没有预审。 */
  session(id: string): PreReviewBadge | null | undefined {
    return this.cache.sessions.get(id);
  }
  pr(id: number): PreReviewBadge | null | undefined {
    return this.cache.prs.get(String(id));
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = true;
    this.d.setTimeout(() => {
      this.timer = false;
      void this.load();
    }, ms);
  }

  private async load(): Promise<void> {
    // 上限之内一次要完（页面上不会有这么多枚徽标；超了也不悄悄丢，分几次要）。
    const ids = { tickets: [...this.want.tickets.keys()], sessions: [...this.want.sessions.keys()], prs: [...this.want.prs.keys()] };
    if (ids.tickets.length + ids.sessions.length + ids.prs.length === 0) return;
    const n = ++this.seq;
    try {
      const chunks: PreReviewStatusRequest[] = [];
      for (let i = 0; i < Math.max(ids.tickets.length, ids.sessions.length, ids.prs.length); i += PRE_REVIEW_STATUS_MAX) {
        const slice = (a: string[]) => a.slice(i, i + PRE_REVIEW_STATUS_MAX);
        chunks.push({ tickets: slice(ids.tickets), sessions: slice(ids.sessions), prs: slice(ids.prs).map(Number) });
      }
      const results = await Promise.all(chunks.map((c) => this.d.fetch(c)));
      if (n !== this.seq) return;
      for (const [i, r] of results.entries()) {
        const c = chunks[i];
        for (const k of c.tickets ?? []) if (r.tickets[k]) this.cache.tickets.set(k, r.tickets[k]);
        for (const k of c.sessions ?? []) this.cache.sessions.set(k, r.sessions[k] ?? null);
        for (const k of c.prs ?? []) this.cache.prs.set(String(k), r.prs[k] ?? null);
      }
      this.version++;
      for (const fn of this.listeners) fn();
    } catch (e) {
      this.d.report(e);
    }
  }
}

export const preReviewStore = new PreReviewStore({
  fetch: (req) => api.preReviewStatus(req),
  onStateChanged: (fn) => api.onStateChanged(fn),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  report: reportError,
});

function useHold(kind: Kind, id: string | null): void {
  useSyncExternalStore(preReviewStore.subscribe, preReviewStore.snapshot, preReviewStore.snapshot);
  useEffect(() => (id === null ? undefined : preReviewStore.hold(kind, id)), [kind, id]);
}

/** 一个 ticket 的预审状态；还没取到为 undefined。 */
export function usePreReviewTicket(key: string | null): PreReviewTicketStatus | undefined {
  useHold("tickets", key);
  return key === null ? undefined : preReviewStore.ticket(key);
}

/** 一个 session 最近一次预审；没有为 null，还没取到为 undefined。 */
export function usePreReviewSession(id: string | null): PreReviewBadge | null | undefined {
  useHold("sessions", id);
  return id === null ? undefined : preReviewStore.session(id);
}

/** 一个 PR 最近一次预审；没有为 null，还没取到为 undefined。 */
export function usePreReviewPr(id: number | null): PreReviewBadge | null | undefined {
  useHold("prs", id === null ? null : String(id));
  return id === null ? undefined : preReviewStore.pr(id);
}
