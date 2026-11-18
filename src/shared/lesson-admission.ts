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

export type BatchMetricKey = "samplePassRate" | "shelvedShare" | "coverage" | "backtestRecall" | "backtestFalsePositiveRate";

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
