import { RETRYABLE_CLOSE_PR_ERRORS, type ClosePrErrorKind } from "./types";

/** 关 ticket 时没关掉的 PR：failed 是 gh 失败；skipped 是对外动作开关关着；其余是关不了（见 shared/types 的 UnclosablePrKind）。 */
export interface ClosePrError {
  url: string;
  error: string;
  kind: ClosePrErrorKind;
  /** shared、shared_branch：牵涉到的那个 ticket。 */
  ticket?: string;
}

/** 关闭框打开时列的（tickets:closePreview）：能关的逐个勾选，关不了的写明原因。 */
export interface ClosePreview {
  closable: { url: string; number: number }[];
  unclosable: ClosePrError[];
}

/** 关闭（tickets:close）和重试（tickets:closeRetry）共有的结果：关了哪些、哪些没关成、ticket 是不是半路被重新打开了。 */
export interface CloseLeftoversResult {
  closedPrs: string[];
  prErrors: ClosePrError[];
  endedSessions: string[];
  sessionErrors: { id: string; error: string }[];
  reopenedMeanwhile: boolean;
  /** ticket 本来就关着（打开关闭框以后别人先关了）：这次只关了勾的 PR、结束了勾的 session。 */
  alreadyClosed?: true;
}

export type CloseOutcome =
  /** 都处理完了（或者半路被重新打开、没什么可重试的）：关对话框，有话就提示一句。 */
  | { done: true; reopenedMeanwhile: boolean }
  /** ticket 关了，但有 PR 没关掉、session 没结束：不算完成，逐条列出原因，让用户重试或就这样。 */
  | { done: false; prErrors: ClosePrError[]; sessionErrors: { id: string; error: string }[] };

/**
 * 关闭对话框、信息流转（BTL-272）拿到结果后怎么办（BTL-270）：closeTicket 不会因为关 PR、结束 session 失败而抛错，只分项报告，
 * 所以要看每一项：有没处理完的就不算完成。半路被重新打开时剩下的不再做，也不给重试（ticket 已经不是关着的）。
 */
export function closeOutcome(r: CloseLeftoversResult): CloseOutcome {
  if (r.reopenedMeanwhile) return { done: true, reopenedMeanwhile: true };
  if (r.prErrors.length === 0 && r.sessionErrors.length === 0) return { done: true, reopenedMeanwhile: false };
  return { done: false, prErrors: r.prErrors, sessionErrors: r.sessionErrors };
}

/**
 * 打开关闭框以后别人（总控）先关了这个 ticket（BTL-270 审查）：提交时提示一句，按这次实际做了什么说（ClosedMeanwhile）。
 * 「关掉剩下的 PR」框本来就是关着的，不提示；关的时候又被重新打开了的，提示的是重新打开。不是这种情况是 null。
 * prs：关了勾的 PR；sessions：结束了 session；both：两样都做了；nothing：什么都没勾，没有要再做的；
 * failed：有勾了的没处理成（下面的框里列出来、可以重试），不说「没有要你再做的」，也不说「只关了你勾的」。
 */
export type ClosedMeanwhile = "prs" | "sessions" | "both" | "nothing" | "failed";
export function closedMeanwhile(r: CloseLeftoversResult, rest: boolean): ClosedMeanwhile | null {
  if (rest || r.alreadyClosed !== true || r.reopenedMeanwhile) return null;
  if (r.prErrors.length > 0 || r.sessionErrors.length > 0) return "failed";
  const prs = r.closedPrs.length > 0;
  const sessions = r.endedSessions.length > 0;
  return prs && sessions ? "both" : prs ? "prs" : sessions ? "sessions" : "nothing";
}

/**
 * 重试只试上次没处理完、而且再试可能成的：gh 失败的、开关关着的 PR，没结束的 session。关不了的那几类（不是这个 ticket 的分支、
 * 别的 ticket 也在用、读不到）再试也一样，不送（BTL-270 审查）。都是这种的时候是 null，重试按钮不可点。
 */
export function retryRequest(o: { prErrors: ClosePrError[]; sessionErrors: { id: string }[] }): { prUrls: string[]; sessionIds: string[] } | null {
  const prUrls = o.prErrors.filter((p) => RETRYABLE_CLOSE_PR_ERRORS.includes(p.kind)).map((p) => p.url);
  const sessionIds = o.sessionErrors.map((s) => s.id);
  return prUrls.length + sessionIds.length > 0 ? { prUrls, sessionIds } : null;
}
