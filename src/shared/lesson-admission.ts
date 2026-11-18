/** 规矩准入（工作流 D）在主进程和页面之间共用的类型。 */

export type AdmissionScope = { kind: "repo"; slug: string } | { kind: "product"; productId: number } | { kind: "all" };
export type AdmissionVerdictKind = "admit" | "merged" | "shelved" | "covered" | "unfinished";

/** 抽查里一条规矩的结论（batch_reviews.verdicts）。reviewed = false：这条没拿到复核结论。 */
export interface SampleVerdict {
  lessonId: number;
  reviewed: boolean;
  pass: boolean;
  reasonable: boolean;
  follows: boolean;
  scopeOk: boolean;
  note: string;
}

export interface ShelvedShares {
  /** 拿到结论的候选（推荐 + 搁置 + 已覆盖；合并的和没做完的不算）。 */
  judged: number;
  shelved: number;
  share: number | null;
  /** 每个搁置原因占拿到结论的候选的比例。 */
  byReason: Record<string, number>;
}

export type BatchMetricKey = "sampleReviewed" | "samplePassRate" | "shelvedShare" | "coverage" | "backtestRecall" | "backtestFalsePositiveRate";

export interface BatchMetricView {
  key: BatchMetricKey;
  value: number;
  floor: number;
  /** min：值至少是线；max：值最多是线。 */
  bound: "min" | "max";
  past: boolean;
  /** 越线越多越大（相对线的距离）；没越线是 0。 */
  distance: number;
}

export interface BatchReviewView {
  id: number;
  batchId: number;
  sampleSize: number;
  reviewed: number;
  passRate: number | null;
  /** 复核用的是产出这批规矩的同一个模型（没有别的模型可换）。 */
  sameModelReview: boolean;
  shelved: ShelvedShares;
  /** 覆盖率、回测：F 提供之前是 null（「未回测」）。 */
  coverage: number | null;
  backtestRecall: number | null;
  metrics: BatchMetricView[];
  /** 有指标越线：不显示「全部接受」。 */
  blocked: boolean;
  weakest: BatchMetricKey | null;
  verdicts: SampleVerdict[];
  createdAt: number;
}

// ------------------------------------------------------------------ 初始化向导（addendum 第 8 节）

export type WizardState = "scanning" | "extracting" | "generating" | "judging" | "awaiting_accept" | "accepted" | "cancelled" | "failed";
export const WIZARD_LIVE_STATES: readonly WizardState[] = ["scanning", "extracting", "generating", "judging", "awaiting_accept"];

/** 向导里的提示（页面按 kind 翻译）。 */
export type WizardNote =
  | { kind: "scanUnavailable" }
  | { kind: "notBacktested" }
  | { kind: "noGh" }
  | { kind: "uncloned"; slug: string }
  | { kind: "ghFailed"; slug: string }
  | { kind: "legacyViolations"; slug: string; count: number }
  | { kind: "noLint"; slug: string };

export interface WizardSummary {
  prs: { total: number; analysed: number; failed: number; skipped: number };
  candidates: number;
  admitted: { prose: number; checks: number };
  merged: number;
  /** 按搁置原因数。 */
  shelved: Record<string, number>;
  covered: number;
  unfinished: number;
  passRate: number | null;
  sameModelReview: boolean;
  /** 回测（F）之前一直是 false：总结写「未回测」。 */
  backtested: boolean;
  calls: number;
}

export interface WizardVerdict {
  lessonId: number;
  verdict: AdmissionVerdictKind;
  reason: string | null;
  ref: number | null;
  score: number | null;
}

export interface WizardFailedItem {
  kind: string;
  key: string;
  attempts: number;
  /** 下次自动重试的时间；null = 不再自动重试（要手动重试）。 */
  retryAt: number | null;
  error: string | null;
}

export interface WizardRunView {
  id: number;
  scope: AdmissionScope;
  state: WizardState;
  progress: { prs: { done: number; total: number }; enrich: { done: number; total: number } };
  calls: number;
  notes: WizardNote[];
  summary: WizardSummary | null;
  review: BatchReviewView | null;
  verdicts: WizardVerdict[];
  failed: WizardFailedItem[];
  planBatch: number | null;
  acceptBatch: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface WizardEstimate {
  /** setUp：这个仓库被一次接受了的向导覆盖过（它自己、它的产品或「全部」）。 */
  repos: { slug: string; cloned: boolean; merged: number | null; analysed: number; setUp: boolean }[];
  pendingLessons: number;
  enrichNeeding: number;
  expectedCalls: number;
  /** 按以前分析一个 PR 的平均时长估的；没有记录时为 null。 */
  expectedMs: number | null;
  /** 这个范围已经有一次没结束的向导：开始就是回到它。 */
  liveRunId: number | null;
}

export type WizardAction =
  | { op: "start"; scope: AdmissionScope }
  | { op: "recalculate"; runId: number }
  | { op: "retry"; runId: number }
  | { op: "accept"; runId: number }
  | { op: "cancel"; runId: number }
  /** 把搁置的一条（或一组）拉回来：逐条确认，每条记一个校准样本。 */
  | { op: "pullBack"; runId: number; lessonIds: number[] }
  | { op: "rejectGroup"; runId: number; lessonIds: number[] };

export type WizardActResult = { ok: true; runId?: number; batchId?: number | null; affected?: number } | { ok: false; reason: string };

// ------------------------------------------------------------------ 校准页（addendum 第 9 节）

export type CalibrationBand = "high" | "mid" | "low";
export type CalibrationMark = "good" | "bad" | "skip";
/** 按分数和线，流水线会给的结论。 */
export type CalibrationAuto = "admit" | "shelve" | "reject";

export interface CalibrationItem {
  lessonId: number;
  band: CalibrationBand;
  score: number;
  auto: CalibrationAuto;
}

export interface CalibrationSample {
  drawnAt: number;
  items: CalibrationItem[];
}

export interface CalibrationBandStats {
  band: CalibrationBand;
  marked: number;
  good: number;
}

export interface CalibrationStats {
  /** 这次抽样里（drawnAt 以后在校准页上判的）。 */
  latest: { bands: CalibrationBandStats[]; agreement: number | null; marked: number };
  /** 全部样本：校准页上判的加上人推翻流水线时自动记的。 */
  all: { agreement: number | null; marked: number; review: number; override: number };
  calibratedAt: string | null;
}

export type CalibrationAction = { op: "mark"; lessonId: number; mark: CalibrationMark; since: number } | { op: "markCalibrated" };

/** 规矩准入（向导、校准、原则）的页面状态：一次取齐。 */
export interface AdmissionPageState {
  runs: WizardRunView[];
  /** 打开着 lessonsPrinciples 时才有意义；按钮总在。 */
  principles: { count: number; running: boolean };
}

export type CalibrationStatsView = CalibrationStats & { marks: Record<number, CalibrationMark> };
export type CalibrationActResult = { ok: true; calibratedAt?: string } | { ok: false; reason: string };
export interface RegroupResult { batchId: number | null; principles: number; lessons: number; failed: number }
