import type { Pr } from "../../shared/handoff";

/**
 * 一个 ticket 的几个 PR（多仓库 ticket 每个仓库一个）合起来看：
 * - 被关掉（没合并）的 PR 不算，除非全都关了；
 * - 还有打开的就是 open，review 取最需要处理的那个（要求修改 > 等 review > 已批准）；
 * - 没有打开的、至少合了一个，就是 merged。
 * 没有 PR 时返回 null。
 */
export function combinedPr(prs: Pr[]): { state: Pr["state"]; review: Pr["review"] } | null {
  if (prs.length === 0) return null;
  const live = prs.filter((p) => p.state !== "closed");
  const open = live.filter((p) => p.state === "open");
  if (open.length > 0) {
    const review = open.some((p) => p.review === "changes_requested")
      ? "changes_requested"
      : open.some((p) => p.review === "pending")
        ? "pending"
        : open.every((p) => p.review === "approved")
          ? "approved"
          : null;
    return { state: "open", review };
  }
  if (live.length > 0) return { state: "merged", review: null };
  return { state: "closed", review: null };
}

/** 简报条目用的 key 后缀：只有一个 PR 时是 PR 号（和以前一样，已有的标记不失效），几个 PR 时带上仓库路径。 */
export function prKey(pr: Pr, all: Pr[]): string {
  if (all.length <= 1) return String(pr.number);
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url);
  return `${m ? m[1] : pr.url}#${pr.number}`;
}
