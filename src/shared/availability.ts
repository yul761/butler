export type LimitKind = "usage_limit" | "rate_limit" | "overloaded" | "model_unavailable";

export interface LimitHit {
  kind: LimitKind;
  /** 额度恢复的时间（毫秒时间戳）；不知道为 null。 */
  resetsAt: number | null;
  message: string;
}
