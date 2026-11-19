// 按规矩的评论趋势（工作流 G 产出，F 只读）。G 合进来之前这里是同签名的桩，一律返回 null（F 不按评论趋势降级、不算这一项分）。
import type { Db } from "../db/database";

export interface TrendSide {
  prs: number;
  comments: number;
  perPr: number | null;
  byWho: { human: number; copilot: number };
}

export interface LessonCommentTrend {
  lessonId: number;
  before: TrendSide;
  after: TrendSide;
}

export interface LessonCommentTrendQuery {
  lessonId?: number;
  checkId?: number;
  /** 分界时间（ms）：之前和之后各取离它最近的 window 个 PR。 */
  since: number;
  repo?: string;
  window?: number;
}

export function lessonCommentTrend(db: Db, q: LessonCommentTrendQuery): LessonCommentTrend | null {
  void db;
  void q;
  return null;
}
