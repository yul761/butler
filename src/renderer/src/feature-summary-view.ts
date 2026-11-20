import type { Pr } from "../../shared/handoff";
import type { FeatureHandoffOutcome } from "../../shared/types";
import { S } from "./strings";

export type PrPill = "merged" | "approved" | "changes" | "pending" | "closed";

/** PR 标签的种类（feature 页 ticket 表的颜色和文字）。 */
export function prPill(pr: Pr): PrPill {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.review === "approved") return "approved";
  if (pr.review === "changes_requested") return "changes";
  return "pending";
}

/** PR 的名字：只有一个时是 #号，几个（多仓库）时带上仓库名。 */
export function prLabel(pr: { number: number; url: string }, all: { url: string }[]): string {
  const repo = all.length > 1 ? /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(pr.url)?.[1] : undefined;
  return repo ? `${repo}#${pr.number}` : `#${pr.number}`;
}

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
