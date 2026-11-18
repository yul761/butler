import type { AvailabilityHit } from "../../shared/availability";
import type { ClaudeAvailability, LessonsGate } from "../claude/availability";

/** 配置了路由、却没认出是哪个模型时，复盘先停多久（避免刚放回去的一项马上又被取走）。 */
export const LESSONS_LOCAL_BACKOFF_MS = 5 * 60_000;

export interface RoutedLessonsGateDeps {
  availability: Pick<ClaudeAvailability, "lessonsGate" | "subscribe" | "resumeLessons" | "pauseLessons" | "report">;
  routing: { configured: () => boolean; lessonsBlockedUntil: () => number | null; subscribe: (fn: () => void) => () => void };
  now: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * 复盘的闸门。没配置路由：就是账号级的 ClaudeAvailability（和 2.1.0 一样）。
 * 配置了路由：手动暂停照旧；限额只看 lesson_analyze 还有没有模型能跑（一个模型撞限会换别的，不停整个复盘）。
 */
export class RoutedLessonsGate {
  private local: { until: number; reason: "limit" | "model"; message: string | null } | null = null;
  private timer: unknown = null;
  private listeners = new Set<() => void>();
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (h: unknown) => void;

  constructor(private d: RoutedLessonsGateDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
    this.clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  lessonsGate(now: number): LessonsGate {
    if (!this.d.routing.configured()) return this.d.availability.lessonsGate(now);
    const a = this.d.availability.lessonsGate(now);
    if (a.paused && a.reason === "manual") return a;
    const until = this.d.routing.lessonsBlockedUntil();
    if (until !== null) return { paused: true, reason: "limit", until: until > now ? until : null, message: null };
    if (this.local && this.local.until > now) return { paused: true, reason: this.local.reason, until: this.local.until, message: this.local.message };
    return { paused: false };
  }

  /** lesson runner 发现限额了闸门却还开着时调用（headless 层已经把模型的限额报给路由了）。 */
  report(hit: Omit<AvailabilityHit, "at"> & { at?: number }): void {
    if (!this.d.routing.configured()) return this.d.availability.report(hit);
    const now = this.d.now();
    const until = Math.max(now + LESSONS_LOCAL_BACKOFF_MS, hit.resetsAt ?? 0);
    this.local = { until, reason: hit.kind === "model_unavailable" ? "model" : "limit", message: hit.message };
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.emit();
    }, until - now);
    this.emit();
  }

  pauseLessons(): void {
    this.d.availability.pauseLessons();
  }

  resumeLessons(): void {
    this.local = null;
    this.d.availability.resumeLessons();
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    const a = this.d.availability.subscribe(fn);
    const r = this.d.routing.subscribe(fn);
    return () => {
      this.listeners.delete(fn);
      a();
      r();
    };
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
