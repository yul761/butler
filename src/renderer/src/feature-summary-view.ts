import type { FeatureHandoffOutcome } from "../../shared/types";
import { S } from "./strings";

/** “立即更新”的结果，用人话说。 */
export function summaryOutcomeMessage(o: FeatureHandoffOutcome): string {
  if (o.status === "stored") return o.degraded ? S.featureSummaryStoredDegraded : S.featureSummaryStored;
  if (o.status === "skipped") return S.featureSummarySkipped[o.reason] ?? o.reason;
  return S.featureSummaryFailed(o.message);
}

/**
 * “立即更新”的结果要不要按错误显示：失败、被限流、存下的是 degraded 时是；
 * nothing_to_summarize 只是告诉用户还没东西可写，按普通提示显示。
 */
export function summaryOutcomeIsError(o: FeatureHandoffOutcome): boolean {
  if (o.status === "stored") return o.degraded;
  if (o.status === "skipped") return o.reason === "rate_limited";
  return true;
}
