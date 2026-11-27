import { RETRYABLE_CLOSE_PR_ERRORS, type ClosePrErrorKind } from "../../shared/types";

/** 关 ticket 时没关掉的 PR：failed 是 gh 失败；skipped 是对外动作开关关着；其余是关不了（见 shared/types 的 UnclosablePrKind）。 */
export interface ClosePrError {
  url: string;
  error: string;
  kind: ClosePrErrorKind;
  /** shared：也挂着它的那个 ticket。 */
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
}

export type CloseOutcome =
  /** 都处理完了（或者半路被重新打开、没什么可重试的）：关对话框，有话就提示一句。 */
  | { done: true; reopenedMeanwhile: boolean }
  /** ticket 关了，但有 PR 没关掉、session 没结束：不算完成，逐条列出原因，让用户重试或就这样。 */
  | { done: false; prErrors: ClosePrError[]; sessionErrors: { id: string; error: string }[] };

/**
 * 关闭对话框拿到结果后怎么办（BTL-270）：closeTicket 不会因为关 PR、结束 session 失败而抛错，只分项报告，
 * 所以要看每一项：有没处理完的就不算完成。半路被重新打开时剩下的不再做，也不给重试（ticket 已经不是关着的）。
 */
export function closeOutcome(r: CloseLeftoversResult): CloseOutcome {
  if (r.reopenedMeanwhile) return { done: true, reopenedMeanwhile: true };
  if (r.prErrors.length === 0 && r.sessionErrors.length === 0) return { done: true, reopenedMeanwhile: false };
  return { done: false, prErrors: r.prErrors, sessionErrors: r.sessionErrors };
}

/** 预览里关不了、但再试可能成的（关之前核对 head 失败）：也能勾，关的时候再核对一次（BTL-270 审查）。 */
export const retryableInPreview = (preview: ClosePreview | null): ClosePrError[] =>
  (preview?.unclosable ?? []).filter((p) => RETRYABLE_CLOSE_PR_ERRORS.includes(p.kind));

/**
 * 关闭框提交时要关哪些 PR：只关勾了的、而且是这次列出来能勾的（能关的，和核对失败、再试可能成的）。一个都没勾就不要求关 PR（BTL-270 审查）：
 * 关不了的那些预览里已经写明了原因，用户看过了，提交后不再当作「没处理完的」列一遍；只是没勾能关的，也不算没处理完。
 * 勾了的才报：主进程只报点名了的这些（没勾的关不了的不算没处理完）。
 */
export function closePrsRequest(preview: ClosePreview | null, picked: ReadonlySet<string>): { closePrs: boolean; prUrls: string[] } {
  const prUrls = [...(preview?.closable ?? []), ...retryableInPreview(preview)].map((p) => p.url).filter((u) => picked.has(u));
  return { closePrs: prUrls.length > 0, prUrls };
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
