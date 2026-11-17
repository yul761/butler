export type LimitKind = "usage_limit" | "rate_limit" | "overloaded" | "model_unavailable";

export interface LimitHit {
  kind: LimitKind;
  /** 额度恢复的时间（毫秒时间戳）；不知道为 null。 */
  resetsAt: number | null;
  message: string;
}

export interface AvailabilityHit extends LimitHit {
  at: number;
  source: "headless" | "session";
  job: string | null;
  sessionId: string | null;
}
export type LessonsPauseReason = "limit" | "model" | "manual";
export interface LessonsPause {
  reason: LessonsPauseReason;
  since: number;
  /** 自动恢复的时间；手动暂停为 null。 */
  until: number | null;
}
export interface AvailabilityView {
  state: "ok" | "limited" | "model_unavailable";
  current: AvailabilityHit | null;
  lastHit: AvailabilityHit | null;
  retryAt: number | null;
  lessonsPause: LessonsPause | null;
}
export type AvailabilityAction = { op: "resumeLessons" } | { op: "pauseLessons" };
