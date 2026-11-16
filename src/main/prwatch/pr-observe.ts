// PR 监视看到的变化 → PR 进度的原始事件。纯函数；同一份数据每轮都会看到，去重靠 dedupeKey（pr_stage_events 的唯一约束）。
import type { StageEvent } from "../db/pr-stage-repo";
import type { PrWatchRow } from "../db/pr-watch-repo";
import { reviewerKind, type PrComment, type PrStatus } from "../tickets/gh";
import type { PrTarget } from "./pr-watcher";

export interface Observation { event: Omit<StageEvent, "id">; dedupeKey: string }

/**
 * prev/next 是 pr_watch 行（next 是这一轮写进去的），pr 是这一轮的 prStatus（没有 PR 或 gh 失败为 null），
 * inline 是这一轮拉到的行内评论（没拉为 []），firstCommit 是 git 或 pr 算出来的第一个 commit 的时间。
 * pr_opened、merged、closed 用 GitHub 给的时间（没有就用 now）；CI 和 push 是这一轮看到的，用 now。
 * 顺序有意义：同一轮的事件 at 都是 now，derivePrStages 按 at、id 排，所以 push 要在新 sha 的 ci 之前。
 */
export function prObservations(
  t: PrTarget, prev: PrWatchRow | null, next: Omit<PrWatchRow, "deliveredKey">, pr: PrStatus | null,
  inline: PrComment[], firstCommit: number | null, now: number,
): Observation[] {
  const out: Observation[] = [];
  const add = (kind: StageEvent["kind"], at: number, key: string, data: Record<string, unknown>) =>
    out.push({
      event: { ticketKey: t.ticketKey, repoId: t.repoId, branch: t.branch, featureId: null, epicId: null, sessionId: null, kind, at, data },
      dedupeKey: `${t.repoId}:${key}`,
    });

  if (firstCommit !== null) add("first_commit", firstCommit, `first_commit:${t.branch}`, {});
  if (prev?.number == null && next.number != null) add("pr_opened", pr?.createdAt ?? now, `opened:${next.number}`, { number: next.number });
  const sha = next.headSha;
  const pushed = prev?.headSha != null && sha !== null && prev.headSha !== sha;
  if (pushed && sha !== null) add("push", now, `push:${sha}`, { sha });
  if (next.number != null && (next.ci === "pending" || next.ci === "passing" || next.ci === "failing")) {
    if (!prev || prev.number == null || prev.ci !== next.ci || prev.headSha !== sha) add("ci", now, `ci:${sha ?? ""}:${next.ci}`, { result: next.ci, sha });
  }
  if (pr) {
    for (const r of pr.reviews) {
      if (r.state === "PENDING") continue;
      add("review", r.submittedAt, `review:${r.id}`, { id: r.id, author: r.author, who: reviewerKind(r.author, pr.author), state: r.state, body: r.body });
    }
    for (const c of [...pr.comments, ...inline]) {
      add("comment", c.createdAt, `comment:${c.id}`, {
        id: c.id, reviewId: c.reviewId, author: c.author, who: reviewerKind(c.author, pr.author), body: c.body, path: c.path, line: c.line, url: c.url,
      });
    }
  }
  if (next.number != null && prev?.state !== next.state) {
    if (next.state === "merged") add("merged", pr?.mergedAt ?? now, `merged:${next.number}`, { number: next.number });
    else if (next.state === "closed") add("closed", pr?.closedAt ?? now, `closed:${next.number}`, { number: next.number });
  }
  return out;
}
