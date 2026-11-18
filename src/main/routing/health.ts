import type { LimitKind } from "../../shared/availability";
import type { ModelHealthView } from "../../shared/model-routing";
import { BACKOFF_MINUTES, HIT_DEDUPE_MS, MODEL_RETRY_MS, RESUME_SLACK_MS } from "../claude/availability";
import { isPauseKind } from "../claude/limits";
import type { RoutingRepo, StoredHealth } from "../db/routing-repo";

/** 探测本身失败了（不是撞限，比如超时）：过这么久再探测一次。 */
export const PROBE_RETRY_MS = 10 * 60_000;
/** setTimeout 的上限。 */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ModelHealthDeps {
  repo: Pick<RoutingRepo, "health" | "saveHealth" | "deleteHealth">;
  now: () => number;
  onChange: () => void;
  /** 退避到期但不知道额度什么时候恢复：要用一次便宜的探测调用验证。 */
  onProbeDue: (model: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (msg: string, err?: unknown) => void;
}

export interface HealthHit {
  kind: LimitKind;
  resetsAt: number | null;
  message: string;
  at?: number;
  /** 规则认不出、靠通用信号或「连续失败而别的模型成功」判断的。 */
  suspected?: boolean;
}

const fresh = (model: string): StoredHealth => ({
  model, state: "ok", kind: null, until: null, resetKnown: false, backoffStep: 0, hitAt: null, suspected: false,
  consecutiveFailures: 0, failureStreakSince: null, lastSuccessAt: null, lastFailureAt: null, lastFailureText: null,
});

/**
 * 每个模型一份可用状态（设计 addendum 第 6 节）。退避和 ClaudeAvailability 一样；知道重置时间的到点就恢复，
 * 不知道的退避到期后进入 probing，等一次探测成功才恢复。
 */
export class ModelHealth {
  private cells = new Map<string, StoredHealth>();
  private timer: unknown = null;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (t: unknown) => void;
  private log: (msg: string, err?: unknown) => void;

  constructor(private d: ModelHealthDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.log = d.log ?? (() => undefined);
    try {
      for (const h of d.repo.health()) this.cells.set(h.model, h);
    } catch (e) {
      this.log("model health: load failed, starting clean", e);
    }
    // 上次退出前已经到期的：知道重置时间的直接恢复，不知道的等探测（启动后由 arm 的定时器立刻触发）。
    this.arm();
  }

  get(model: string): StoredHealth {
    return this.cells.get(model) ?? fresh(model);
  }

  /** 现在能不能用：ok，或者知道重置时间且已经过了。probing 不算（等探测成功）。 */
  usable(model: string, now: number = this.d.now()): boolean {
    const c = this.cells.get(model);
    if (!c || c.state === "ok") return true;
    if (c.state === "probing") return false;
    return c.resetKnown && c.until !== null && c.until <= now;
  }

  /** 不能用的模型预计什么时候能用；能用为 null。不知道重置时间的按退避到期时间算（还要等探测）。 */
  recoversAt(model: string, now: number = this.d.now()): number | null {
    if (this.usable(model, now)) return null;
    const c = this.cells.get(model)!;
    return c.state === "probing" ? now + PROBE_RETRY_MS : (c.until ?? now + PROBE_RETRY_MS);
  }

  /** 撞限：标记这个模型（返回它现在的 until）。 */
  report(model: string, hit: HealthHit): number | null {
    const now = this.d.now();
    const at = hit.at ?? now;
    const c = { ...this.get(model) };
    if (isPauseKind(hit.kind)) {
      const dup = c.kind === hit.kind && c.hitAt !== null && Math.abs(at - c.hitAt) < HIT_DEDUPE_MS && c.state !== "ok";
      if (hit.resetsAt !== null && hit.resetsAt > now) {
        c.until = hit.resetsAt + RESUME_SLACK_MS;
        c.resetKnown = true;
      } else if (dup && c.until !== null) {
        // 一分钟内同一类的重复报告：不往后推。
      } else {
        const step = Math.min(c.backoffStep, BACKOFF_MINUTES.length - 1);
        c.until = now + BACKOFF_MINUTES[step]! * 60_000;
        c.backoffStep = Math.min(step + 1, BACKOFF_MINUTES.length - 1);
        c.resetKnown = false;
      }
      c.state = "limited";
    } else {
      c.until = now + MODEL_RETRY_MS;
      c.resetKnown = false;
      c.state = "unavailable";
    }
    c.kind = hit.kind;
    c.hitAt = at;
    c.suspected = hit.suspected === true;
    c.lastFailureAt = at;
    c.lastFailureText = hit.message;
    this.put(c);
    return c.until;
  }

  /** 一次成功：比当前这次撞限还早开始的运行说明不了现在，只记成功时间。 */
  noteSuccess(model: string, startedAt: number): void {
    const now = this.d.now();
    const c = { ...this.get(model) };
    if (c.hitAt !== null && startedAt < c.hitAt && c.state !== "ok") {
      c.lastSuccessAt = Math.max(c.lastSuccessAt ?? 0, now);
      this.put(c, false);
      return;
    }
    const changed = c.state !== "ok" || c.consecutiveFailures !== 0 || c.backoffStep !== 0;
    Object.assign(c, { state: "ok", kind: null, until: null, resetKnown: false, backoffStep: 0, suspected: false, consecutiveFailures: 0, failureStreakSince: null, lastSuccessAt: now });
    this.put(c, changed);
  }

  /** 不是撞限的失败：记进连续失败（学习用）。返回这一串失败的次数和开始时间。 */
  noteFailure(model: string, text: string, at: number = this.d.now()): { count: number; since: number } {
    const c = { ...this.get(model) };
    c.consecutiveFailures += 1;
    c.failureStreakSince ??= at;
    c.lastFailureAt = at;
    c.lastFailureText = text.slice(0, 1000);
    this.put(c, false);
    return { count: c.consecutiveFailures, since: c.failureStreakSince };
  }

  /** 探测的结果：成功恢复；撞限进下一级退避；别的失败过一会儿再探。 */
  probeResult(model: string, r: { ok: true } | { ok: false; hit: HealthHit | null }): void {
    if (r.ok) {
      this.noteSuccess(model, this.d.now());
      return;
    }
    if (r.hit) {
      this.report(model, r.hit);
      return;
    }
    const c = { ...this.get(model) };
    if (c.state === "ok") return;
    c.state = "probing";
    c.until = this.d.now() + PROBE_RETRY_MS;
    c.resetKnown = false;
    this.put(c);
  }

  clear(model: string): void {
    if (!this.cells.has(model)) return;
    this.cells.delete(model);
    try {
      this.d.repo.deleteHealth(model);
    } catch (e) {
      this.log("model health: delete failed", e);
    }
    this.arm();
    this.emit();
  }

  view(): ModelHealthView[] {
    const now = this.d.now();
    return [...this.cells.values()].map((c) => {
      const expired = c.state !== "ok" && c.state !== "probing" && c.resetKnown && c.until !== null && c.until <= now;
      return {
        model: c.model, state: expired ? "ok" : c.state, kind: expired ? null : c.kind, until: expired ? null : c.until, resetKnown: c.resetKnown,
        suspected: c.suspected, consecutiveFailures: c.consecutiveFailures, lastSuccessAt: c.lastSuccessAt, lastFailureAt: c.lastFailureAt, lastFailureText: c.lastFailureText,
      };
    });
  }

  dispose(): void {
    this.disarm();
  }

  private put(c: StoredHealth, emit = true): void {
    this.cells.set(c.model, c);
    try {
      this.d.repo.saveHealth(c, this.d.now());
    } catch (e) {
      this.log("model health: save failed", e);
    }
    this.arm();
    if (emit) this.emit();
  }

  private emit(): void {
    try {
      this.d.onChange();
    } catch (e) {
      this.log("model health: listener failed", e);
    }
  }

  private disarm(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** 定时器对准最早的到期时间（limited / unavailable / probing 的 until）。 */
  private arm(): void {
    this.disarm();
    let next: number | null = null;
    for (const c of this.cells.values()) if (c.state !== "ok" && c.until !== null && (next === null || c.until < next)) next = c.until;
    if (next === null) return;
    this.timer = this.setTimer(() => this.fire(), Math.min(MAX_TIMER_MS, Math.max(0, next - this.d.now())));
  }

  private fire(): void {
    this.timer = null;
    const now = this.d.now();
    const due: string[] = [];
    let changed = false;
    for (const c of [...this.cells.values()]) {
      if (c.state === "ok" || c.until === null || c.until > now) continue;
      if (c.resetKnown) {
        this.cells.set(c.model, { ...c, state: "ok", kind: null, until: null, resetKnown: false, suspected: false });
        this.save(this.cells.get(c.model)!);
        changed = true;
      } else {
        // 等探测：until 往后放一段，探测没回来也不会立刻再触发。
        const next = { ...c, state: "probing" as const, until: now + PROBE_RETRY_MS };
        this.cells.set(c.model, next);
        this.save(next);
        due.push(c.model);
        changed = true;
      }
    }
    this.arm();
    if (changed) this.emit();
    for (const m of due) {
      try {
        this.d.onProbeDue(m);
      } catch (e) {
        this.log(`model health: probe of ${m} failed to start`, e);
      }
    }
  }

  private save(c: StoredHealth): void {
    try {
      this.d.repo.saveHealth(c, this.d.now());
    } catch (e) {
      this.log("model health: save failed", e);
    }
  }
}
