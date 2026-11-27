import { RETRYABLE_CLOSE_PR_ERRORS, type ClosePrErrorKind } from "../../shared/types";

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

/** 预览里能勾的有几个（能关的，和核对失败、再试可能成的）：关着的 ticket 有这些才给「关掉剩下的 PR」入口（BTL-270 审查）。 */
export const pickableInPreview = (preview: ClosePreview | null): number => (preview?.closable.length ?? 0) + retryableInPreview(preview).length;

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

/** 关着的 ticket 页上「关掉剩下的 PR」看的数记多久：预览要跑 gh（每个能关的 PR 一次），不每次打开 ticket 页都跑。 */
export const REST_PREVIEW_TTL_MS = 2 * 60_000;

/** 关闭框关掉了 PR 以后，最多等多久后台监视的记录跟上（stamp 里没有这些 PR 了）再预览：读不到也不一直等。 */
export const REST_SETTLE_MS = 20_000;

/**
 * 每个 ticket 最近一次预览出的能勾的数（BTL-270 审查）：TTL 内再打开 ticket 页直接用。
 * stamp 是预览时这个 ticket 开着的 PR（restStamp）：总控关了 PR、PR 在网页上被关了，stamp 就对不上，不再用。
 * 关闭框关上以后（settle）、ticket 被重新打开时 drop 掉。预览要等 gh：开始时记下 begin() 的代数，
 * 回来时代数变了（中间 drop 过）就不写，免得晚到的旧结果又写回去。
 * 关闭框关掉了 PR（settle 给了链接）：后台监视的记录要过一会儿才跟上，stamp 会再变一次。这段时间里 waiting() 不为 0，
 * 先不预览，等 stamp 里没有这些 PR 了（或者等到 REST_SETTLE_MS）再预览一次，不在 stamp 变前后各跑一次（BTL-270 审查）。
 */
export function restPreviewCache(now: () => number = () => Date.now()) {
  const seen = new Map<string, { at: number; n: number; stamp: string }>();
  const gens = new Map<string, number>();
  const settling = new Map<string, { urls: string[]; until: number }>();
  const drop = (key: string): void => {
    seen.delete(key);
    gens.set(key, (gens.get(key) ?? 0) + 1);
  };
  return {
    get(key: string, stamp: string): number | undefined {
      const e = seen.get(key);
      return e && e.stamp === stamp && now() - e.at < REST_PREVIEW_TTL_MS ? e.n : undefined;
    },
    /** 开始一次预览：返回现在的代数，回来时交给 set。 */
    begin(key: string): number {
      return gens.get(key) ?? 0;
    },
    /** 写下预览出的数；gen 是 begin() 给的，之后 drop 过就不写（返回 false）。 */
    set(key: string, n: number, stamp: string, gen: number): boolean {
      if ((gens.get(key) ?? 0) !== gen) return false;
      seen.set(key, { at: now(), n, stamp });
      return true;
    },
    drop(key: string): void {
      settling.delete(key);
      drop(key);
    },
    /**
     * 关闭框关上了：drop，关掉了 PR 的（closedUrls）记下来，等监视记录跟上再预览（waiting）。
     * 上一次的还没等完又 settle（连着关了两回）：两次的 PR 合起来等，到期取较晚的；这次没关掉 PR 的不缩短上一次的等待。
     */
    settle(key: string, closedUrls: readonly string[]): void {
      drop(key);
      const t = now();
      const prev = settling.get(key);
      const live = prev && prev.until > t ? prev : undefined;
      const urls = [...new Set([...(live?.urls ?? []), ...closedUrls])];
      if (urls.length === 0) {
        settling.delete(key);
        return;
      }
      const until = Math.max(live?.until ?? 0, closedUrls.length > 0 ? t + REST_SETTLE_MS : 0);
      settling.set(key, { urls, until });
    },
    /**
     * 还要等多少毫秒再预览：stamp 里还有刚关掉的 PR、也没等到头时是剩下的时间，否则是 0（同时忘掉这次等待）。
     * stamp 是 null（监视记录读不到）不等。
     */
    waiting(key: string, stamp: string | null): number {
      const w = settling.get(key);
      if (!w) return 0;
      const left = w.until - now();
      const open = stamp === null ? [] : stamp.split("\n");
      if (left > 0 && w.urls.some((u) => open.includes(u))) return left;
      settling.delete(key);
      return 0;
    },
  };
}

/**
 * 一个 ticket 现在开着的 PR（后台监视的记录，不跑 gh）：restPreviewCache 的 stamp。
 * 读不到（"failed"）是 null：照常预览，只是不缓存（对不上的时候发现不了）。还没读到的不在这里（调用方等着）。
 */
export function restStamp(watched: readonly { ticketKey: string; url: string | null; state: string | null }[] | "failed", key: string): string | null {
  if (watched === "failed") return null;
  return watched.filter((p) => p.ticketKey === key && p.url !== null && p.state === "open").map((p) => p.url!).sort().join("\n");
}

export const restPreviews = restPreviewCache();

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
