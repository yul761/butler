// 回测、影子模式自动升级、自动降级（工作流 F）的共享类型：主进程和页面都用。

export type BacktestStatus = "done" | "skipped" | "failed";
/** 跳过的原因：没有本地 clone、gh 不能用、run_command（不在历史上跑命令）、没有可用的素材。 */
export type BacktestSkipReason = "not_cloned" | "no_gh" | "run_command" | "no_material";
export const BACKTEST_SKIP_REASONS: readonly BacktestSkipReason[] = ["not_cloned", "no_gh", "run_command", "no_material"];

export interface BacktestSample {
  pr: number;
  path: string;
  line: number;
  text: string;
  /** 模型的判断（没判的是 null，按误报算）。 */
  verdict: "violation" | "false_positive" | null;
  reason: string | null;
}

export interface BacktestCaught {
  pr: number;
  path: string;
  line: number | null;
}

/** 一个仓库上的一次回测结果。 */
export interface BacktestResult {
  id: number;
  defHash: string;
  slug: string;
  lessonId: number | null;
  checkKey: string | null;
  status: BacktestStatus;
  skipReason: BacktestSkipReason | null;
  prs: number;
  hits: number;
  matchedHits: number;
  judged: number;
  judgedFp: number;
  falsePositives: number;
  /** false_positives / hits；hits = 0 时为空。 */
  fpRate: number | null;
  comments: number;
  commentsMatched: number;
  /** comments_matched / comments；comments = 0 时为空。 */
  recall: number | null;
  /** 当前代码里的存量违规（E2 的存量扫描）；还没跑是空。 */
  legacy: number | null;
  legacyScanId: number | null;
  samples: { falsePositives: BacktestSample[]; caught: BacktestCaught[] };
  createdAt: number;
}

/** 几个仓库合起来（产品层的检查）。 */
export interface BacktestSummary {
  tested: boolean;
  /** 没回测的仓库和原因。 */
  skipped: { slug: string; reason: BacktestSkipReason }[];
  prs: number;
  hits: number;
  falsePositives: number;
  fpRate: number | null;
  comments: number;
  commentsMatched: number;
  recall: number | null;
  legacy: number | null;
  samples: BacktestSample[];
  at: number | null;
}

export type CheckLifecycleReason = "bypassed" | "no_reduction";

export interface CheckLifecycleView {
  needsReview: boolean;
  reason: CheckLifecycleReason | null;
  /** 原因的数字（页面拼句子）。 */
  data: LifecycleReasonData;
  /** cleared：人清除了复查标记，从那一刻重新看。 */
  lastAction: "promote" | "demote" | "flag" | "cleared" | null;
  lastBatchId: number | null;
  at: number;
}

export type LifecycleReasonData =
  | { kind: "bypassed"; bypasses: number; ignored: number; blocked: number; rate: number; max: number; how: Partial<Record<BypassHow, number>> }
  | { kind: "no_reduction"; beforePerPr: number; afterPerPr: number; afterPrs: number }
  | { kind: "none" };

export type BypassHow = "suppress" | "no_verify" | "hooks_off" | "tamper";
export const BYPASS_HOWS: readonly BypassHow[] = ["suppress", "no_verify", "hooks_off", "tamper"];

/** 影子运行到升级还差什么（页面上的进度）。 */
export interface PromotionProgress {
  eligible: boolean;
  /** 不满足的条件（按顺序）。 */
  blockers: PromotionBlocker[];
  since: number;
  prs: number;
  minPrs: number;
  days: number;
  minDays: number;
  fails: number;
  minHits: number;
  adoption: number | null;
  minAdoption: number;
  fpRate: number | null;
  maxFpRate: number;
  score: number | null;
  admitLine: number;
}

export type PromotionBlocker =
  | "auto_off" | "not_shadow" | "disabled" | "warn" | "untested" | "no_backtest" | "score" | "time" | "hits" | "fp" | "adoption" | "needs_review";

export interface CheckScoreView {
  score: number | null;
  /** 分项（0..1），没有的不在里面。 */
  parts: Partial<Record<"verifiability" | "performance" | "composite" | "cap" | "adoption" | "precision" | "bypass" | "trend", number>>;
  scoredAt: number;
}

/** 检查页上一条检查的 F 部分。 */
export interface CheckF {
  checkId: number;
  backtest: BacktestSummary | null;
  score: CheckScoreView | null;
  lifecycle: CheckLifecycleView | null;
  progress: PromotionProgress | null;
  bypassed: number;
  ignored: number;
}

export interface ThresholdReviewView {
  id: number;
  at: number;
  key: string;
  current: number;
  suggested: number;
  basis: { samples: number; agreeNow: number; agreeSuggested: number; note: string };
  status: "open" | "applied" | "dismissed";
}

export interface CheckCalibrationStats {
  promotions: number;
  promotionsUndone: number;
  demotions: number;
  demotionsUndone: number;
}

export interface BacktestView {
  checks: CheckF[];
  reviews: ThresholdReviewView[];
  calibration: CheckCalibrationStats;
  /** 正在回测（排队或在跑）的检查 id。 */
  running: number[];
}

export type BacktestAction =
  | { op: "rerun"; checkId: number }
  | { op: "clearReview"; checkId: number }
  | { op: "undo"; batchId: number }
  | { op: "dismissNotice"; eventId: number }
  | { op: "applyThreshold"; id: number }
  | { op: "dismissThreshold"; id: number };

export type BacktestActResult = { ok: true; batchId?: number | null } | { ok: false; error: string };
