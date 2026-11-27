import { BACKGROUND_KINDS, type BgKind } from "../../shared/background";
import type { BackgroundRepo, BgJob } from "../db/background-repo";
import type { BackgroundScheduler, BgYieldSignal } from "./scheduler";

/**
 * 开新 session 前的内存准入（工作流 W 的 #40：MemoryAdmission.admit 同形）。放行时给 release：
 * 没开成要还回去；开成了不还，W 那边 PENDING_MS 内按刚开的扣内存。
 */
export interface SessionAdmission {
  admit(what: string): Promise<{ ok: true; release: () => void } | { ok: false; reason: string }>;
}

/** 任务说「延后」却没说到什么时候：过这么久再试（免得闸门开着时马上又被取走）。 */
export const BG_DEFER_MS = 60_000;

export type BgJobResult = { done: true } | { failed: string } | { defer: true; notBefore?: number | null; reason?: string };

export interface BgJobContext {
  id: number;
  kind: BgKind;
  payload: unknown;
  /** 上次存的检查点（没有为 null）：让路、重启以后从这里接着跑。 */
  checkpoint: unknown;
  ticketKey: string | null;
  attempts: number;
  /** 让路、取消、退出时 abort：任务看到就尽快停，返回什么都行（队列放回去）。 */
  signal: AbortSignal;
  save(checkpoint: unknown): void;
  /** 这个 session 醒着吗（休眠的返回 false）：要往里递东西的任务先看它，休眠着就延后，不要叫醒。 */
  sessionAwake(sessionId: string): boolean;
  /** 要开新 session：先问内存准入。放行后开成了调 opened()；没调就当没开成，队列替你还回去。 */
  admitSession(what: string): Promise<{ ok: true; opened: () => void } | { ok: false; reason: string }>;
}

export type BgHandler = (ctx: BgJobContext) => Promise<BgJobResult>;

export interface BackgroundQueueDeps {
  repo: BackgroundRepo;
  scheduler: Pick<BackgroundScheduler, "gate" | "subscribe" | "onYield" | "registerSource">;
  now: () => number;
  /** M 的休眠：这个 session 休眠着吗。 */
  isHibernated: (sessionId: string) => boolean;
  /** W 的内存准入（index.ts 接的是 MemoryAdmission）；没接或返回 null（单测）时一律放行。 */
  admission?: () => SessionAdmission | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  log?: (msg: string, err?: unknown) => void;
  onChange?: () => void;
  /** 这一种同时最多跑几个（设置里的，比如预审并发 preReviewConcurrency）；没给或返回 null 用 BACKGROUND_KINDS 里的。 */
  concurrency?: (kind: BgKind) => number | null;
}

/** 登记处理函数时的选项。 */
export interface BgRegisterOptions {
  /**
   * 互斥键：键相同的任务不同时跑（比如预审按 worktree：同一个目录里复跑命令、查 HEAD 会互相干扰）。
   * 返回 null 的不受限制。取任务时算一次，跑完才放开。
   */
  lockKey?: (job: BgJob) => string | null;
}

interface Live {
  job: BgJob;
  ctl: AbortController;
  /** 这个任务占着的互斥键（BgRegisterOptions.lockKey）。 */
  lock: string | null;
  /** 为什么 abort：让路（放回队列）、取消、退出。 */
  why: "yield" | "cancel" | "quit" | null;
}

/** 失败、没开成、中止时都要还；开成了不还。 */
interface AdmitSlot { release: () => void; opened: boolean }

/** 通用后台队列（设计 addendum 第 3.6 节）：D、F、G、N 的任务在这里登记处理函数，排进来的按调度器的闸门跑。 */
export class BackgroundQueue {
  private readonly handlers = new Map<BgKind, BgHandler>();
  private readonly options = new Map<BgKind, BgRegisterOptions>();
  private readonly live = new Map<number, Live>();
  private started = false;
  private timer: unknown = null;
  private unsubs: (() => void)[] = [];

  constructor(private readonly d: BackgroundQueueDeps) {}

  register(kind: BgKind, handler: BgHandler, o: BgRegisterOptions = {}): void {
    this.handlers.set(kind, handler);
    this.options.set(kind, o);
    this.pump();
  }

  /** 这一种同时最多跑几个（设置优先，至少 1）。 */
  concurrencyOf(kind: BgKind): number {
    let n: number | null = null;
    try {
      n = this.d.concurrency?.(kind) ?? null;
    } catch (e) {
      this.d.log?.(`background: reading the concurrency of ${kind} failed`, e);
    }
    return n !== null && Number.isFinite(n) && n >= 1 ? Math.floor(n) : BACKGROUND_KINDS[kind].concurrency;
  }

  /** 这一种在跑的任务各自占着的互斥键（任务 id → 键；没有键的不在里面）。 */
  locksOf(kind: BgKind): Map<number, string> {
    const out = new Map<number, string>();
    for (const l of this.live.values()) if (l.job.kind === kind && l.lock !== null) out.set(l.job.id, l.lock);
    return out;
  }

  /** 排队的这一个提到最前面（预审队列的「提到最前」）；within 给了时只提到这些 ticket 的最前。不在排队返回 false。 */
  moveToFront(id: number, within?: (ticketKey: string | null) => boolean): boolean {
    let ok = false;
    try {
      ok = this.d.repo.moveToFront(id, within);
    } catch (e) {
      this.d.log?.(`background: moving #${id} to the front failed`, e);
    }
    if (ok) {
      this.d.onChange?.();
      this.pump();
    }
    return ok;
  }

  enqueue(kind: BgKind, payload: unknown, o: { ticketKey?: string | null; dedupeKey?: string | null; notBefore?: number | null; priority?: number } = {}): number {
    const id = this.d.repo.enqueue({ kind, payload, ...o, now: this.d.now() });
    this.d.onChange?.();
    this.pump();
    return id;
  }

  /** 这一种延后着的马上再试一次（比如自动接活：session 结束、名额空出来了）。 */
  wake(kind: BgKind): void {
    try {
      if (this.d.repo.wake(kind) > 0) this.d.onChange?.();
    } catch (e) {
      this.d.log?.(`background: waking ${kind} jobs failed`, e);
    }
    this.pump();
  }

  cancel(id: number): boolean {
    const l = this.live.get(id);
    if (l) {
      l.why = "cancel";
      l.ctl.abort();
      return true;
    }
    const ok = this.d.repo.cancel(id, this.d.now());
    if (ok) this.d.onChange?.();
    return ok;
  }

  /** 启动时调一次：上次在跑的回到 queued，订阅调度器，开跑。 */
  start(): void {
    if (this.started) return;
    const n = this.d.repo.resetRunning();
    if (n > 0) this.d.log?.(`background: ${n} jobs were running when Shipherd quit, queued again`);
    this.started = true;
    this.unsubs.push(this.d.scheduler.subscribe(() => this.pump()));
    this.unsubs.push(this.d.scheduler.onYield((s) => this.yield(s)));
    this.unsubs.push(this.d.scheduler.registerSource(() => this.d.repo.counts()));
    this.pump();
  }

  /** 退出：在跑的都停下（下次启动 resetRunning 放回队列）。 */
  dispose(): void {
    for (const l of this.live.values()) {
      l.why = "quit";
      l.ctl.abort();
    }
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.timer !== null) (this.d.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer);
    this.timer = null;
    this.started = false;
  }

  private yield(s: BgYieldSignal): void {
    for (const l of this.live.values()) {
      if (!BACKGROUND_KINDS[l.job.kind].interruptible) continue;
      const hit = "kinds" in s ? s.kinds.includes(l.job.kind) : l.job.ticketKey === s.ticketKey;
      if (!hit) continue;
      l.why = "yield";
      l.ctl.abort();
    }
  }

  private running(kind: BgKind): number {
    let n = 0;
    for (const l of this.live.values()) if (l.job.kind === kind) n++;
    return n;
  }

  pump(): void {
    if (!this.started) return;
    const now = this.d.now();
    for (const [kind, handler] of this.handlers) {
      const max = this.concurrencyOf(kind);
      const lockKey = this.options.get(kind)?.lockKey;
      while (this.running(kind) < max) {
        if (!this.d.scheduler.gate(kind).run) break;
        let job: BgJob | null;
        // 互斥键：取的时候算，被占着的跳过（后面键不同的照样能跑）；取到的那个的键记下，跑完才放开。
        const held = new Set(this.locksOf(kind).values());
        const keys = new Map<number, string | null>();
        const keyOf = (j: BgJob): string | null => {
          if (!lockKey) return null;
          if (!keys.has(j.id)) {
            let k: string | null = null;
            try {
              k = lockKey(j);
            } catch (e) {
              this.d.log?.(`background: the lock key of ${kind} #${j.id} failed`, e);
            }
            keys.set(j.id, k);
          }
          return keys.get(j.id) ?? null;
        };
        try {
          job = this.d.repo.take(
            kind, now, (key) => this.d.scheduler.gate(kind, { ticketKey: key }).run,
            lockKey ? (j) => { const k = keyOf(j); return k === null || !held.has(k); } : undefined,
          );
        } catch (e) {
          this.d.log?.(`background: taking the next ${kind} job failed`, e);
          break;
        }
        if (!job) break;
        this.run(job, handler, keyOf(job));
      }
    }
    this.armTimer(now);
  }

  /** 有延后到将来的：到点再 pump 一次。 */
  private armTimer(now: number): void {
    if (this.timer !== null) (this.d.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer);
    this.timer = null;
    let next: number | null = null;
    try {
      next = this.d.repo.nextNotBefore(now);
    } catch (e) {
      this.d.log?.("background: reading the next wake-up failed", e);
    }
    if (next === null) return;
    const set = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
    this.timer = set(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, next - now));
  }

  private run(job: BgJob, handler: BgHandler, lock: string | null = null): void {
    const ctl = new AbortController();
    const l: Live = { job, ctl, why: null, lock };
    this.live.set(job.id, l);
    const slots: AdmitSlot[] = [];
    const ctx: BgJobContext = {
      id: job.id, kind: job.kind, payload: job.payload, checkpoint: job.checkpoint, ticketKey: job.ticketKey, attempts: job.attempts, signal: ctl.signal,
      save: (cp) => {
        try {
          this.d.repo.saveCheckpoint(job.id, cp);
          job.checkpoint = cp;
        } catch (e) {
          this.d.log?.(`background: saving the checkpoint of ${job.kind} #${job.id} failed`, e);
        }
      },
      sessionAwake: (id) => !this.d.isHibernated(id),
      admitSession: async (what) => {
        const gate = this.d.admission?.() ?? null;
        if (!gate) return { ok: true, opened: () => undefined };
        const a = await gate.admit(what);
        if (!a.ok) return a;
        const slot: AdmitSlot = { release: a.release, opened: false };
        slots.push(slot);
        if (ctl.signal.aborted) {
          // 刚放行就被叫停：不会去开了，马上还。
          slot.opened = true;
          a.release();
          return { ok: false, reason: "aborted" };
        }
        return { ok: true, opened: () => { slot.opened = true; } };
      },
    };
    this.d.onChange?.();
    let result: BgJobResult;
    void (async () => {
      try {
        result = await handler(ctx);
      } catch (e) {
        result = { failed: e instanceof Error ? e.message : String(e) };
        if (!ctl.signal.aborted) this.d.log?.(`background: ${job.kind} #${job.id} failed`, e);
      }
      for (const s of slots) if (!s.opened) s.release();
      this.settle(l, result);
    })();
  }

  private settle(l: Live, r: BgJobResult): void {
    const now = this.d.now();
    const { job } = l;
    try {
      if (l.why === "cancel") this.d.repo.finish(job.id, "cancelled", now);
      else if ("done" in r) this.d.repo.finish(job.id, "done", now);
      else if (l.why === "yield" || l.why === "quit") this.d.repo.requeue(job.id, null);
      else if ("defer" in r) this.d.repo.requeue(job.id, r.notBefore ?? now + BG_DEFER_MS, r.reason ?? null);
      else this.d.repo.finish(job.id, "failed", now, r.failed);
    } catch (e) {
      this.d.log?.(`background: settling ${job.kind} #${job.id} failed`, e);
    } finally {
      this.live.delete(job.id);
    }
    this.d.onChange?.();
    if (l.why !== "quit") this.pump();
  }
}
