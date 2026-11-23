/** 度量（ws-h，契约 4.7）在主进程和界面之间共用的类型。 */

/** 事件归类：人介入、打断、返工、评论、其他。 */
export type MetricKindGroup = "intervention" | "interrupt" | "rework" | "comment" | "other";

/** 打断原因（7.4）：权限确认、选择题、缺信息、真问题、卡住。 */
export const INTERRUPT_CATEGORIES = ["permission", "choice", "missing_info", "question", "stuck"] as const;
export type InterruptCategory = (typeof INTERRUPT_CATEGORIES)[number];

export const isInterruptCategory = (v: unknown): v is InterruptCategory =>
  typeof v === "string" && (INTERRUPT_CATEGORIES as readonly string[]).includes(v);

/** 一组 PR 在一段时间里的平均值（「效果」页的四张卡）。没有 PR 或没有数据的为 null。 */
export interface MetricAverages {
  /** 合并了几个 PR。 */
  prs: number;
  /** 开 PR → 合并。 */
  cycleOpenMs: number | null;
  /** ticket 开始 → 合并。 */
  cycleTicketMs: number | null;
  commentsHuman: number | null;
  commentsCopilot: number | null;
  commentsAvoidable: number | null;
  interventions: number | null;
  /** 归到 PR 的等人时间。 */
  waitHumanMs: number | null;
  /** 加权 token。 */
  costWeighted: number | null;
  costUsd: number | null;
  /** 有用量行没算出美元价格：美元偏少。 */
  costUsdPartial: boolean;
}

/** Shipherd 之前（基线）：只有周期和评论，花费、人介入那时没记。 */
export interface BaselineAverages {
  prs: number;
  cycleOpenMs: number | null;
  /** 用第一个 commit 的时间近似 ticket 开始。 */
  cycleTicketMs: number | null;
  commentsHuman: number | null;
  commentsCopilot: number | null;
  /** 基线截止点：最早的 Shipherd session 的创建时间（没有就是开始记度量的时间）。 */
  cutoff: number;
}

/** 趋势的一格（一周或一个月），只算 Shipherd 的 PR。 */
export interface TrendPoint {
  /** 这一格第一天（本地日期 YYYY-MM-DD）。 */
  start: string;
  prs: number;
  cycleOpenMs: number | null;
  comments: number | null;
  interventions: number | null;
  costWeighted: number | null;
}

export interface InterruptShare {
  category: InterruptCategory;
  count: number;
  waitMs: number;
}

/** 一个键的次数和合计（花费构成、人介入构成、其他事件）。 */
export interface KeyCount {
  key: string;
  n: number;
  total: number;
}

export interface GroupMetrics {
  kind: "repo" | "product" | "risk";
  key: string;
  prs: number;
  cycleOpenMs: number | null;
  comments: number | null;
  interventions: number | null;
  costWeighted: number | null;
}

/** 「效果」页和总控 metrics_overview 共用的一份数据（ws-h 第 9、10 节）。 */
export interface MetricsOverview {
  /** 统计最近几天（默认 30）。 */
  days: number;
  /** 窗口第一天、最后一天（本地日期）。 */
  from: string;
  to: string;
  generatedAt: number;
  /** 上一次汇总的时间；还没汇总过为 null。 */
  rolledUpAt: number | null;
  shipherd: MetricAverages;
  /** 链接到 ticket、但不是 Shipherd session 推的 PR。 */
  other: MetricAverages;
  /** 还没回填到基线 PR 时为 null。 */
  baseline: BaselineAverages | null;
  trend: { week: TrendPoint[]; month: TrendPoint[] };
  interrupts: InterruptShare[];
  /** 自动放行的打断（interrupt_auto_resolved）。 */
  autoResolved: number;
  waitHumanMs: number;
  waitIdleMs: number;
  /** 人介入构成：kind 或 kind:子类型（mode / via / channel）。 */
  interventions: KeyCount[];
  groups: GroupMetrics[];
  spend: { byModel: KeyCount[]; byTask: KeyCount[] };
  /** Shipherd 的 PR 的返工次数。 */
  rework: { prs: number; ciFailures: number; reopens: number; reverts: number };
  /** 不算人介入、也不是打断的事件（熔断、后台让路等）。 */
  otherEvents: KeyCount[];
  /** 打断减少（ws-j 设计 6）的前后对比；还没有哪个功能生效过为 null。 */
  interruptCompare: InterruptCompare | null;
}

/** 前后对比的一边：同样长的几天。人介入、等人时间是每个合并的 PR 的平均；打断是每天的平均。 */
export interface CompareSide {
  from: string;
  to: string;
  days: number;
  prs: number;
  interventions: number | null;
  waitHumanMs: number | null;
  interruptsPerDay: Record<InterruptCategory, number>;
  autoResolved: number;
  stuckFixes: number;
}

export interface InterruptCompare {
  /** 第一个打断减少功能生效的时间。 */
  since: number;
  /** 生效那天前后各算多少天；生效当天前后都有，不算在任何一边。两边同为 null：还在生效当天，没有完整的「之后」。 */
  before: CompareSide | null;
  after: CompareSide | null;
}

export const METRICS_DAYS_DEFAULT = 30;
export const METRICS_DAYS_MAX = 365;
