import type { AvailabilityHit, AvailabilityView, LessonsPause, LessonsPauseReason } from "../../shared/availability";
import type { AvailabilityRepo, StoredAvailability } from "../db/availability-repo";
import { isPauseKind } from "./limits";

export const RESUME_SLACK_MS = 60_000;
export const BACKOFF_MINUTES = [10, 20, 40, 80, 120];
export const HIT_DEDUPE_MS = 60_000;
export const MODEL_RETRY_MS = 3_600_000;
/** setTimeout 的上限：更大的延时会溢出并立刻触发。 */
const MAX_TIMER_MS = 2 ** 31 - 1;

export type LessonsGate = { paused: false } | { paused: true; reason: LessonsPauseReason; until: number | null; message: string | null };

export interface ClaudeAvailabilityDeps {
  repo: AvailabilityRepo;
  now: () => number;
  onChange: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (msg: string, err?: unknown) => void;
}

/** Claude 账号的可用状态：限流 / 模型不可用的记录、复盘队列的暂停和自动恢复。 */
export class ClaudeAvailability {
  private s: StoredAvailability = { current: null, lastHit: null, retryAt: null, backoffStep: 0, lessonsPause: null };
  private timer: unknown = null;
  private subs = new Set<() => void>();
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (t: unknown) => void;
  private log: (msg: string, err?: unknown) => void;

  constructor(private d: ClaudeAvailabilityDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.log = d.log ?? (() => undefined);
    const stored = d.repo.load();
    if (stored) this.s = stored;
    const now = d.now();
    const p = this.s.lessonsPause;
    const expired = (this.s.retryAt !== null && this.s.retryAt <= now) || (p !== null && p.reason !== "manual" && p.until !== null && p.until <= now);
    if (expired) {
      this.clearAuto();
      this.persist(false);
    }
    this.arm();
  }

  report(hit: Omit<AvailabilityHit, "at"> & { at?: number }): void {
    const now = this.d.now();
    const at = hit.at ?? now;
    const h: AvailabilityHit = { ...hit, at };
    if (isPauseKind(h.kind)) {
      const prev = this.s.current;
      const dup = prev !== null && prev.kind === h.kind && Math.abs(at - prev.at) < HIT_DEDUPE_MS;
      let retryAt: number;
      if (h.resetsAt !== null && h.resetsAt > now) {
        retryAt = h.resetsAt + RESUME_SLACK_MS;
      } else if (dup && this.s.retryAt !== null) {
        retryAt = this.s.retryAt;
      } else {
        const step = Math.min(this.s.backoffStep, BACKOFF_MINUTES.length - 1);
        retryAt = now + BACKOFF_MINUTES[step]! * 60_000;
        this.s.backoffStep = Math.min(step + 1, BACKOFF_MINUTES.length - 1);
      }
      this.s.current = h;
      this.s.lastHit = h;
      this.s.retryAt = retryAt;
      this.setPause("limit", now, retryAt);
    } else if (h.job === "lessons") {
      const retryAt = now + MODEL_RETRY_MS;
      this.s.current = h;
      this.s.lastHit = h;
      this.s.retryAt = retryAt;
      this.setPause("model", now, retryAt);
    } else {
      this.s.lastHit = h;
    }
    this.commit();
  }

  /** 一次成功：清掉限流 / 模型不可用的暂停。运行开始得比当前这次撞限还早（startedAt < current.at）时，它的成功说明不了现在，什么都不改。 */
  noteSuccess(startedAt: number, job: string | null): void {
    const s = this.s;
    if (s.current !== null && startedAt < s.current.at) return;
    const keepModel = s.lessonsPause?.reason === "model" && job !== "lessons";
    let changed = false;
    if (s.current !== null && !(keepModel && s.current.kind === "model_unavailable")) {
      s.current = null;
      changed = true;
    }
    if (s.retryAt !== null && !keepModel) {
      s.retryAt = null;
      changed = true;
    }
    if (s.lessonsPause?.reason === "limit" || (s.lessonsPause?.reason === "model" && job === "lessons")) {
      s.lessonsPause = null;
      changed = true;
    }
    if (s.backoffStep !== 0) {
      s.backoffStep = 0;
      changed = true;
    }
    if (changed) this.commit();
  }

  lessonsGate(now: number): LessonsGate {
    const p = this.s.lessonsPause;
    if (p === null || (p.until !== null && p.until <= now)) return { paused: false };
    if (p.reason === "manual") return { paused: true, reason: "manual", until: null, message: null };
    return { paused: true, reason: p.reason, until: p.until, message: this.s.current?.message ?? this.s.lastHit?.message ?? null };
  }

  pauseLessons(): void {
    this.s.lessonsPause = { reason: "manual", since: this.d.now(), until: null };
    this.commit();
  }

  resumeLessons(): void {
    this.s.current = null;
    this.s.retryAt = null;
    this.s.lessonsPause = null;
    this.s.backoffStep = 0;
    this.commit();
  }

  view(): AvailabilityView {
    const c = this.s.current;
    const state = c === null ? "ok" : isPauseKind(c.kind) ? "limited" : "model_unavailable";
    return { state, current: c, lastHit: this.s.lastHit, retryAt: this.s.retryAt, lessonsPause: this.s.lessonsPause };
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  dispose(): void {
    this.disarm();
  }

  /** 手动暂停优先：限流 / 模型的暂停不覆盖它。 */
  private setPause(reason: LessonsPauseReason, since: number, until: number): void {
    if (this.s.lessonsPause?.reason === "manual") return;
    const p: LessonsPause = { reason, since, until };
    this.s.lessonsPause = p;
  }

  private clearAuto(): void {
    this.s.current = null;
    this.s.retryAt = null;
    if (this.s.lessonsPause?.reason !== "manual") this.s.lessonsPause = null;
  }

  private disarm(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.disarm();
    if (this.s.retryAt === null) return;
    this.timer = this.setTimer(() => this.fire(), Math.min(MAX_TIMER_MS, Math.max(0, this.s.retryAt - this.d.now())));
  }

  private fire(): void {
    this.timer = null;
    if (this.s.retryAt !== null && this.s.retryAt > this.d.now()) {
      this.arm();
      return;
    }
    this.clearAuto();
    this.commit();
  }

  private persist(emit: boolean): void {
    try {
      this.d.repo.save(this.s, this.d.now());
    } catch (e) {
      this.log("availability: save failed", e);
    }
    if (!emit) return;
    for (const f of [this.d.onChange, ...this.subs]) {
      try {
        f();
      } catch (e) {
        this.log("availability: listener failed", e);
      }
    }
  }

  private commit(): void {
    this.arm();
    this.persist(true);
  }
}
