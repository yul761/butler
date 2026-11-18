import type { TaskId } from "./model-routing";

/** 后台任务的优先级（工作流 L）：high 不受时段限制，只在额度 hard 和熔断时让路。 */
export const BG_PRIORITIES = ["high", "normal", "low"] as const;
export type BgPriority = (typeof BG_PRIORITIES)[number];

/** 后台任务什么时候跑：随时、只在空闲时、只在这些小时内、空闲或在这些小时内。 */
export const BG_WINDOWS = ["anytime", "idle", "hours", "idle_or_hours"] as const;
export type BgWindow = (typeof BG_WINDOWS)[number];

/** 该让路时：跑着的跑完再停（finish），或可打断的马上停、放回队列（interrupt）。 */
export const BG_YIELDS = ["finish", "interrupt"] as const;
export type BgYield = (typeof BG_YIELDS)[number];

/** 额度紧张时先停低优先级的后台任务（pause_first），还是先交给路由器降档（downgrade_first）。 */
export const BG_QUOTA_ORDERS = ["pause_first", "downgrade_first"] as const;
export type BgQuotaOrder = (typeof BG_QUOTA_ORDERS)[number];

export const BG_KINDS = ["lesson_analyze", "lesson_backfill", "lesson_admission", "backtest", "pre_review", "repo_scan", "intake"] as const;
export type BgKind = (typeof BG_KINDS)[number];

export function isBgKind(v: unknown): v is BgKind {
  return typeof v === "string" && (BG_KINDS as readonly string[]).includes(v);
}

export interface BgKindDef {
  kind: BgKind;
  /** 哪个工作流的（说明用）。 */
  owner: string;
  priority: BgPriority;
  /** 可以按时段（空闲 / 这些小时）调度；false 的不看时段，只看额度和熔断。 */
  idleEligible: boolean;
  /** 跑到一半可以停下（放回队列）。 */
  interruptible: boolean;
  /** 停下以后能接着跑（从检查点或重跑这一项），进度不丢。 */
  resumable: boolean;
  /** 跑的时候要开一个新的 Claude session（要过内存准入）。 */
  opensSession: boolean;
  /** 走模型路由的任务 id（契约 4.1），算额度级别用；不调模型的为 null。 */
  task: TaskId | null;
  /** 同时最多跑几个（通用队列用；复盘队列有自己的并发）。 */
  concurrency: number;
}

const def = (kind: BgKind, owner: string, priority: BgPriority, task: TaskId | null, o: Partial<BgKindDef> = {}): BgKindDef => ({
  kind, owner, priority, task,
  idleEligible: o.idleEligible ?? true,
  interruptible: o.interruptible ?? true,
  resumable: o.resumable ?? true,
  opensSession: o.opensSession ?? false,
  concurrency: o.concurrency ?? 1,
});

/** 后台任务登记表（设计 addendum 第 3.1 节）。新的后台任务在这里加一条，再用 BackgroundQueue.register 接上处理函数。 */
export const BACKGROUND_KINDS: Record<BgKind, BgKindDef> = {
  lesson_analyze: def("lesson_analyze", "C", "normal", "lesson_analyze", { concurrency: 2 }),
  lesson_backfill: def("lesson_backfill", "C", "low", "lesson_analyze", { concurrency: 2 }),
  lesson_admission: def("lesson_admission", "D", "normal", "lesson_classify"),
  backtest: def("backtest", "F", "low", "backtest_judge"),
  pre_review: def("pre_review", "G", "normal", "pre_review"),
  repo_scan: def("repo_scan", "wizard", "low", "repo_scan_infer"),
  intake: def("intake", "N", "high", "intake_classify", { idleEligible: false, interruptible: false, opensSession: true }),
};

/** 用户按种类改的（设置 bgKinds）：优先级、时段（不写跟全局）、停用。 */
export interface BgKindOverride {
  priority?: BgPriority;
  window?: BgWindow;
  paused?: boolean;
}

/** 闸门不放行的原因。 */
export type BgBlockReason = "manual" | "cost" | "quota" | "user_active" | "outside_hours" | "memory";

export type BgGate = { run: true } | { run: false; reason: BgBlockReason; until: number | null };

/** 设置页上每种后台任务一行。 */
export interface BgKindStatus {
  kind: BgKind;
  owner: string;
  priority: BgPriority;
  window: BgWindow;
  /** 用户改过的（没改为 null，用默认 / 全局）。 */
  override: BgKindOverride | null;
  idleEligible: boolean;
  interruptible: boolean;
  gate: BgGate;
  /** 在队列里等着的（复盘队列 / 通用队列）。 */
  queued: number;
  running: number;
}

export interface BackgroundStatusView {
  window: BgWindow;
  hours: string;
  idleMinutes: number;
  yieldMode: BgYield;
  quotaOrder: BgQuotaOrder;
  plentifulPercent: number | null;
  /** 现在用户空闲吗，系统多久没输入（秒），屏幕锁着吗。 */
  idle: { idle: boolean; idleSeconds: number; locked: boolean };
  /** 现在在不在「这些小时」里。 */
  inHours: boolean;
  /** 额度：每个配额用了多少（比例），最高级别。没配配额为空数组。 */
  quota: { level: "ok" | "soft" | "hard"; plentiful: boolean };
  kinds: BgKindStatus[];
}
