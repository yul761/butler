import {
  BACKGROUND_KINDS, BG_KINDS,
  type BackgroundStatusView, type BgGate, type BgKind, type BgKindOverride, type BgKindStatus, type BgPriority, type BgWindow,
} from "../../shared/background";
import type { SpendLevel, TaskId } from "../../shared/model-routing";
import { inHours, nextHoursStart, type BgSettings } from "./bg-settings";
import { userIdle, type IdleSignal } from "./idle";

/** 30 秒看一次空闲和时段（没有「空闲满 N 分钟」这种事件）。 */
export const BG_POLL_MS = 30_000;

/** 额度（A 的配额）：某个路由任务现在的级别、所有配额里用得最多的比例（没配配额为 null）、配额周期什么时候结束。 */
export interface BgQuota {
  level(task: TaskId | null): SpendLevel;
  maxRatio(): number | null;
  until(): number | null;
}

/** 该让路了：这些种类（时段 / 额度变了），或者这个 ticket 的后台任务（熔断暂停了它）。 */
export type BgYieldSignal = { kinds: BgKind[] } | { ticketKey: string };

export type BgEventKind = "yield" | "resume";

export interface BackgroundSchedulerDeps {
  settings: () => BgSettings;
  /** 存设置（手动停一种任务时改 bgKinds）。 */
  setSetting: (key: "bgKinds", value: string) => void;
  idle: IdleSignal;
  /** 没配模型路由时为 null（额度永远 ok）。 */
  quota: () => BgQuota | null;
  /** 这个 ticket 的后台任务被成本熔断停了。 */
  costBlocked: (ticketKey: string) => boolean;
  now: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  /** 让路和恢复（H 的 recordEvent 合并后接这里，契约 4.7）。 */
  onEvent?: (kind: BgEventKind, refs: { kind: BgKind; reason?: string }) => void;
  log?: (msg: string, err?: unknown) => void;
}

/** 已登记的后台队列报告自己每种任务有几个在等、几个在跑。 */
export type BgCounts = Partial<Record<BgKind, { queued: number; running: number }>>;

const rank = (l: SpendLevel) => (l === "hard" ? 2 : l === "soft" ? 1 : 0);

/**
 * 后台调度（工作流 L，设计 addendum 第 3 节）：交互 session 优先，后台任务按优先级和时段跑，额度紧张、被熔断时让路。
 * 本身不跑任务，只回答「现在能不能跑」，状态一变就通知；自己有队列的（复盘）和通用队列（BackgroundQueue）都问它。
 */
export class BackgroundScheduler {
  private readonly listeners = new Set<() => void>();
  private readonly yielders = new Set<(s: BgYieldSignal) => void>();
  private readonly sources = new Set<() => BgCounts>();
  private last: Map<BgKind, boolean> | null = null;
  private timer: unknown = null;
  private unsubIdle: (() => void) | null = null;

  constructor(private readonly d: BackgroundSchedulerDeps) {}

  /** 开始看空闲信号和时段（index.ts 启动时调；单测直接调 tick）。 */
  start(pollMs = BG_POLL_MS): void {
    if (this.timer !== null) return;
    this.last = this.snapshot();
    this.unsubIdle = this.d.idle.subscribe(() => this.tick());
    const set = this.d.setInterval ?? ((fn, ms) => setInterval(fn, ms).unref?.());
    this.timer = set(() => this.tick(), pollMs);
  }

  dispose(): void {
    if (this.timer !== null) (this.d.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)))(this.timer);
    this.timer = null;
    this.unsubIdle?.();
    this.unsubIdle = null;
  }

  private override(kind: BgKind, s: BgSettings): BgKindOverride {
    return s.kinds[kind] ?? {};
  }

  priorityOf(kind: BgKind, s = this.d.settings()): BgPriority {
    return this.override(kind, s).priority ?? BACKGROUND_KINDS[kind].priority;
  }

  windowOf(kind: BgKind, s = this.d.settings()): BgWindow {
    return this.override(kind, s).window ?? s.window;
  }

  /** 这种任务（这个 ticket 的）现在能不能跑；不能时说为什么、大概什么时候能（知道的话）。 */
  gate(kind: BgKind, ctx: { ticketKey?: string | null } = {}): BgGate {
    const s = this.d.settings();
    const def = BACKGROUND_KINDS[kind];
    const ov = this.override(kind, s);
    if (ov.paused) return { run: false, reason: "manual", until: null };
    if (ctx.ticketKey && this.d.costBlocked(ctx.ticketKey)) return { run: false, reason: "cost", until: null };
    const priority = this.priorityOf(kind, s);
    const quota = this.d.quota();
    if (quota) {
      const level = rank(quota.level(def.task));
      // pause_first：soft 停 low，hard 停 low 和 normal；downgrade_first：soft 交给路由器降档，hard 才停 low。high 只在熔断时停。
      const stopAt: Record<BgPriority, number> = s.quotaOrder === "pause_first" ? { low: 1, normal: 2, high: 3 } : { low: 2, normal: 3, high: 3 };
      if (level >= stopAt[priority]) return { run: false, reason: "quota", until: quota.until() };
    }
    const window = this.windowOf(kind, s);
    if (window === "anytime" || priority === "high" || !def.idleEligible) return { run: true };
    if (s.plentifulPercent !== null && quota) {
      const r = quota.maxRatio();
      if (r !== null && r < s.plentifulPercent / 100) return { run: true };
    }
    const now = this.d.now();
    const idle = userIdle(this.d.idle, s.idleMinutes);
    const hours = inHours(s.hours, now);
    if (window === "idle") return idle ? { run: true } : { run: false, reason: "user_active", until: null };
    if (window === "hours") return hours ? { run: true } : { run: false, reason: "outside_hours", until: nextHoursStart(s.hours, now) };
    return idle || hours ? { run: true } : { run: false, reason: "user_active", until: nextHoursStart(s.hours, now) };
  }

  /** 状态变了的回调（空闲、时段、设置、额度）：队列重新取。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 要让路的回调：可打断的任务停下放回队列。 */
  onYield(fn: (s: BgYieldSignal) => void): () => void {
    this.yielders.add(fn);
    return () => this.yielders.delete(fn);
  }

  registerSource(fn: () => BgCounts): () => void {
    this.sources.add(fn);
    return () => this.sources.delete(fn);
  }

  private snapshot(): Map<BgKind, boolean> {
    return new Map(BG_KINDS.map((k) => [k, this.gate(k).run]));
  }

  /** 重新看一遍（定时器、空闲事件、设置改了、花费变了都调它）；有种类翻转了就通知。 */
  tick(): void {
    let next: Map<BgKind, boolean>;
    try {
      next = this.snapshot();
    } catch (e) {
      this.d.log?.("background: checking the schedule failed", e);
      return;
    }
    const prev = this.last;
    this.last = next;
    if (prev === null) return;
    const stopped: BgKind[] = [];
    let changed = false;
    for (const k of BG_KINDS) {
      const was = prev.get(k);
      const is = next.get(k);
      if (was === is) continue;
      changed = true;
      if (was && !is) {
        stopped.push(k);
        const g = this.gate(k);
        this.d.onEvent?.("yield", { kind: k, reason: g.run ? undefined : g.reason });
        this.d.log?.(`background: ${k} yields (${g.run ? "?" : g.reason})`);
      } else {
        this.d.onEvent?.("resume", { kind: k });
        this.d.log?.(`background: ${k} may run again`);
      }
    }
    if (!changed) return;
    const s = this.d.settings();
    const interrupt = stopped.filter((k) => BACKGROUND_KINDS[k].interruptible);
    if (s.yieldMode === "interrupt" && interrupt.length > 0) this.emitYield({ kinds: interrupt });
    this.emit();
  }

  /** 成本熔断停了这个 ticket 的后台任务：不管让路方式，可打断的都马上停。 */
  yieldTicket(ticketKey: string): void {
    this.emitYield({ ticketKey });
    this.emit();
  }

  private emitYield(sig: BgYieldSignal): void {
    for (const fn of [...this.yielders]) {
      try {
        fn(sig);
      } catch (e) {
        this.d.log?.("background: a yield handler failed", e);
      }
    }
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        this.d.log?.("background: a listener failed", e);
      }
    }
  }

  /** 设置页的「停用这种任务」。 */
  setKindPaused(kind: BgKind, paused: boolean): void {
    const kinds = { ...this.d.settings().kinds };
    const cur = { ...(kinds[kind] ?? {}) };
    if (paused) cur.paused = true;
    else delete cur.paused;
    if (Object.keys(cur).length > 0) kinds[kind] = cur;
    else delete kinds[kind];
    this.d.setSetting("bgKinds", Object.keys(kinds).length > 0 ? JSON.stringify(kinds) : "");
    this.tick();
  }

  status(): BackgroundStatusView {
    const s = this.d.settings();
    const counts: BgCounts = {};
    for (const src of this.sources) {
      try {
        for (const [k, c] of Object.entries(src()) as [BgKind, { queued: number; running: number }][]) {
          const cur = counts[k] ?? { queued: 0, running: 0 };
          counts[k] = { queued: cur.queued + c.queued, running: cur.running + c.running };
        }
      } catch (e) {
        this.d.log?.("background: counting a queue failed", e);
      }
    }
    const quota = this.d.quota();
    const ratio = quota?.maxRatio() ?? null;
    let level: SpendLevel = "ok";
    if (quota) for (const k of BG_KINDS) if (rank(quota.level(BACKGROUND_KINDS[k].task)) > rank(level)) level = quota.level(BACKGROUND_KINDS[k].task);
    const kinds: BgKindStatus[] = BG_KINDS.map((k) => {
      const def = BACKGROUND_KINDS[k];
      return {
        kind: k, owner: def.owner, priority: this.priorityOf(k, s), window: this.windowOf(k, s),
        override: s.kinds[k] ?? null, idleEligible: def.idleEligible, interruptible: def.interruptible,
        gate: this.gate(k), queued: counts[k]?.queued ?? 0, running: counts[k]?.running ?? 0,
      };
    });
    return {
      window: s.window, hours: s.hoursText, idleMinutes: s.idleMinutes, yieldMode: s.yieldMode, quotaOrder: s.quotaOrder, plentifulPercent: s.plentifulPercent,
      idle: { idle: userIdle(this.d.idle, s.idleMinutes), idleSeconds: this.d.idle.idleSeconds(), locked: this.d.idle.locked() },
      inHours: inHours(s.hours, this.d.now()),
      quota: { level, plentiful: s.plentifulPercent !== null && ratio !== null && ratio < s.plentifulPercent / 100 },
      kinds,
    };
  }
}
