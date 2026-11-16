// PR 监视看到的变化 → PR 进度的原始事件。纯函数；同一份数据每轮都会看到，去重靠 dedupeKey（pr_stage_events 的唯一约束）。
import type { StageEvent } from "../db/pr-stage-repo";
import type { PrWatchRow } from "../db/pr-watch-repo";
import { reviewerKind, type PrComment, type PrStatus, type ReviewAuthors } from "../tickets/gh";
import type { PrTarget } from "./pr-watcher";

export interface Observation { event: Omit<StageEvent, "id">; dedupeKey: string }

/**
 * prev/next 是 pr_watch 行（next 是这一轮写进去的），pr 是这一轮的 prStatus（没有 PR 或 gh 失败为 null），
 * inline 是这一轮拉到的行内评论（没拉为 []），firstCommit 是 git 或 pr 算出来的第一个 commit 的时间。
 * pr_opened、merged、closed 用 GitHub 给的时间（没有就用 now）；CI 和 push 是这一轮看到的，用 now。
 * bots：这一轮从 REST 查到的 Bot（gh pr view 的作者没有 [bot] 后缀）；没查或失败为 null，按名字认。
 * 顺序有意义：同一轮的事件 at 都是 now，derivePrStages 按 at、id 排，所以 push 要在新 sha 的 ci 之前。
 */
export function prObservations(
  t: PrTarget, prev: PrWatchRow | null, next: Omit<PrWatchRow, "deliveredKey">, pr: PrStatus | null,
  inline: PrComment[], firstCommit: number | null, now: number, bots: ReviewAuthors | null = null,
): Observation[] {
  const out: Observation[] = [];
  const add = (kind: StageEvent["kind"], at: number, key: string, data: Record<string, unknown>) =>
    out.push({
      event: { ticketKey: t.ticketKey, repoId: t.repoId, branch: t.branch, featureId: null, epicId: null, sessionId: null, kind, at, data },
      dedupeKey: `${t.repoId}:${key}`,
    });

  if (firstCommit !== null) add("first_commit", firstCommit, `first_commit:${t.branch}`, {});
  if (prev?.number == null && next.number != null) add("pr_opened", pr?.createdAt ?? now, `opened:${next.number}`, { number: next.number });
  // 这一轮看到 PR 已经合并或关闭：CI 和 push 的时间不晚于合并、关闭的时间，时间线上才排在它前面。
  const endedAt = next.state === "merged" ? pr?.mergedAt : next.state === "closed" ? pr?.closedAt : null;
  const seen = endedAt != null ? Math.min(now, endedAt) : now;
  const sha = next.headSha;
  const pushed = prev?.headSha != null && sha !== null && prev.headSha !== sha;
  if (pushed && sha !== null) add("push", seen, `push:${sha}`, { sha });
  if (next.number != null && (next.ci === "pending" || next.ci === "passing" || next.ci === "failing")) {
    if (!prev || prev.number == null || prev.ci !== next.ci || prev.headSha !== sha) add("ci", seen, `ci:${sha ?? ""}:${next.ci}`, { result: next.ci, sha });
  }
  const kindOf = (login: string, reviewId: string | null) => {
    const k = reviewerKind(login, pr?.author ?? "");
    return k === "human" && bots && ((reviewId !== null && bots.botReviewIds.has(reviewId)) || bots.botLogins.has(login.toLowerCase().replace(/\[bot\]$/, ""))) ? "bot" : k;
  };
  if (pr) {
    for (const r of pr.reviews) {
      if (r.state === "PENDING") continue;
      add("review", r.submittedAt, `review:${r.id}`, { id: r.id, author: r.author, who: kindOf(r.author, r.id), state: r.state, body: r.body });
    }
    for (const c of [...pr.comments, ...inline]) {
      add("comment", c.createdAt, `comment:${c.id}`, {
        id: c.id, reviewId: c.reviewId, author: c.author, who: kindOf(c.author, null), body: c.body, path: c.path, line: c.line, url: c.url,
      });
    }
  }
  if (next.number != null && prev?.state !== next.state) {
    if (next.state === "merged") add("merged", pr?.mergedAt ?? now, `merged:${next.number}`, { number: next.number });
    else if (next.state === "closed") add("closed", pr?.closedAt ?? now, `closed:${next.number}`, { number: next.number });
  }
  return out;
}
