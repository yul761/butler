// 「效果」页「Review 效果」区块的数据（工作流 G，设计 §11.3）。只有数，没有评论正文。

export interface ReviewGroupStats {
  prs: number;
  /** 平均每个 PR 的人评论数。 */
  humanComments: number | null;
  rounds: number | null;
  firstReviewMs: number | null;
  submitToMergeMs: number | null;
}

export interface ReviewEffectWeek {
  /** 这一周开始（UTC 周一 0 点，毫秒）。 */
  weekStart: number;
  prs: number;
  avoidable: number;
  /** 平均每 PR 可避免评论数；没有 PR 为 null。 */
  perPr: number | null;
}

export interface ReviewEffectLesson {
  lessonId: number;
  text: string;
  confirmedAt: number;
  before: { prs: number; perPr: number | null };
  after: { prs: number; perPr: number | null };
}

export interface ReviewEffectView {
  days: number;
  /** Butler 的 PR，最近 12 周。 */
  weeks: ReviewEffectWeek[];
  butler: ReviewGroupStats;
  others: ReviewGroupStats;
  /** Butler 的 PR 里带简报 / 不带简报的。 */
  withBrief: ReviewGroupStats;
  withoutBrief: ReviewGroupStats;
  /** 最近确认的规矩，上线后至少 3 个 PR 的，按变化排。 */
  lessons: ReviewEffectLesson[];
  /** 窗口里合并的 PR 上的评论落点。 */
  landing: { confirmedBefore: number; notYet: number; unattributed: number };
}

/** 小于这么多个 PR 的组显示「样本太少」。 */
export const REVIEW_EFFECT_MIN_SAMPLE = 5;
