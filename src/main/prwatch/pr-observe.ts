// PR 监视看到的变化 → PR 进度的原始事件。纯函数；同一份数据每轮都会看到，去重靠 dedupeKey（pr_stage_events 的唯一约束）。
import type { StageEvent } from "../db/pr-stage-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import { reviewerKind, type PrComment, type PrStatus, type ReviewAuthors } from "../tickets/gh";
import type { BranchTarget } from "./pr-schedule";

export interface Observation { event: Omit<StageEvent, "id">; dedupeKey: string }

/**
 * 一个 PR 行的事件归属。scope 是 dedupe_key 的前缀：ticket 仓库的 PR 用仓库 id（和迁移前的事件同一个格式，不会重复记），
 * 不是 ticket 仓库的 PR 用 `${ticketKey}@${slug}`（两个 ticket 链接同一个 PR 时各记各的）。
 */
export interface ObsScope { ticketKey: string; prId: number | null; repoId: number | null; scope: string; branch: string | null }

/** prObservations 要看的 PR 行字段：上一轮存下的（checkedAt 为 0 = 还没读过）和这一轮读到的。 */
export type PrSnapshot = Pick<TicketPr, "number" | "state" | "review" | "ci" | "headSha" | "failed" | "checkedAt">;

export const scopeOf = (ticketKey: string, repoId: number | null, slug: string): string => (repoId !== null ? String(repoId) : `${ticketKey}@${slug}`);

type KeyScope = Pick<ObsScope, "scope" | "branch">;
/** pr_stage_events 的 dedupe_key：都带 scope 和分支，同一个 sha、同一个 PR 号换了分支（ticket 改过分支）是新事件。watcher 查"看过没有"也用这几个。 */
export const stageKey = {
  /** afterPrId：这个分支上一个结束了的 PR；之后的第一个 commit 是下一个 PR 的开始。 */
  firstCommit: (t: KeyScope, afterPrId: number | null = null) => `${t.scope}:first_commit:${t.branch}${afterPrId === null ? "" : `:after:${afterPrId}`}`,
  opened: (t: KeyScope, number: number) => `${t.scope}:opened:${t.branch}:${number}`,
  /** state 在 key 里：同一个 review 后来被撤销（DISMISSED）是新的一条。 */
  review: (t: KeyScope, id: string, state: string) => `${t.scope}:review:${t.branch}:${id}:${state}`,
};

/** 分支上第一个 commit（主要由分支检查记下；分支上有开着的 PR、分支不查时由 PR 的读取补上，同一个 key）。 */
export function firstCommitObservation(t: Pick<BranchTarget, "ticketKey" | "repoId" | "branch">, at: number, afterPrId: number | null): Observation {
  return {
    event: { ticketKey: t.ticketKey, repoId: t.repoId, prId: null, branch: t.branch, featureId: null, sessionId: null, kind: "first_commit", at, data: {} },
    dedupeKey: stageKey.firstCommit({ scope: String(t.repoId), branch: t.branch }, afterPrId),
  };
}

/**
 * prev 是这个 PR 行上一轮存下的（还没读过时 checkedAt 为 0；null 也当作第一次读），next 是这一轮读到的，pr 是这一轮的 prStatus
 * （mergedAt 已经补上了行里存的时间，例如合并占位释放的时间）。inline 是这一轮拉到的行内评论（没拉为 []）。
 * pr_opened、merged、closed 用 GitHub 给的时间（没有就用 now，且不晚于 now）；CI 和 push 是这一轮看到的，用 now。
 * review：第一次读用 min(submittedAt, now)，之后用看到的时间（GitHub 的钟和本机的钟不一定对得上，后看到的不能排到已经记下的事件前面）。
 * CI 只和这个 PR 最后一条 ci 事件（lastCi）比：gh 某一轮失败（行上的 ci 留着）不会让同一个结论再记一次。
 * bots：这一轮从 REST 查到的 Bot（gh pr view 的作者没有 [bot] 后缀）；没查或失败为 null，按名字认。
 * firstCommit：给了就用 PR 的 commit 里最早的作者时间补记分支的第一个 commit（key 和分支检查的一样，谁先记都只有一条）；
 * afterPrId 是这个分支上一个结束了的 PR。只给 ticket 仓库的 PR。
 * 顺序有意义：同一轮的事件 at 都是 now，derivePrStages 按 at、id 排，所以 push 要在新 sha 的 ci 之前。
 */
export function prObservations(
  s: ObsScope, prev: PrSnapshot | null, next: PrSnapshot, pr: PrStatus | null,
  inline: PrComment[], now: number, bots: ReviewAuthors | null, lastCi: { sha: string | null; result: string } | null,
  firstCommit: { afterPrId: number | null } | null = null,
): Observation[] {
  const out: Observation[] = [];
  const add = (kind: StageEvent["kind"], at: number, key: string, data: Record<string, unknown>) =>
    out.push({
      event: { ticketKey: s.ticketKey, repoId: s.repoId, prId: s.prId, branch: s.branch, featureId: null, sessionId: null, kind, at, data },
      dedupeKey: key,
    });
  const first = prev === null || prev.checkedAt === 0;
  const p = s.scope;
  const b = s.branch;

  if (firstCommit && s.repoId !== null && b !== null && pr?.firstCommitAt != null) {
    out.push(firstCommitObservation({ ticketKey: s.ticketKey, repoId: s.repoId, branch: b }, Math.min(pr.firstCommitAt, now), firstCommit.afterPrId));
  }
  // 每轮都给：key 去重；迁移前就有、但没记过 pr_opened 的 PR 也补上。
  if (pr) add("pr_opened", Math.min(pr.createdAt ?? now, now), stageKey.opened(s, next.number), { number: next.number });
  // 这一轮看到 PR 已经合并或关闭：CI 和 push 的时间不晚于合并、关闭的时间，时间线上才排在它前面。
  const endedAt = next.state === "merged" ? pr?.mergedAt : next.state === "closed" ? pr?.closedAt : null;
  const seen = endedAt != null ? Math.min(now, endedAt) : now;
  const sha = next.headSha;
  const pushed = prev?.headSha != null && sha !== null && prev.headSha !== sha;
  if (pushed && sha !== null) add("push", seen, `${p}:push:${b}:${sha}`, { sha });
  // key 带上看到的时间：同一个 sha 上重跑出的同一结果（中间有过别的结论）也是新的一条。
  if (next.ci === "pending" || next.ci === "passing" || next.ci === "failing") {
    if (lastCi === null || lastCi.sha !== sha || lastCi.result !== next.ci) add("ci", seen, `${p}:ci:${b}:${sha ?? ""}:${next.ci}:${seen}`, { result: next.ci, sha });
  }
  const kindOf = (login: string, reviewId: string | null) => {
    const k = reviewerKind(login, pr?.author ?? "");
    return k === "human" && bots && ((reviewId !== null && bots.botReviewIds.has(reviewId)) || bots.botLogins.has(login.toLowerCase().replace(/\[bot\]$/, ""))) ? "bot" : k;
  };
  if (pr) {
    for (const r of pr.reviews) {
      if (r.state === "PENDING") continue;
      // DISMISSED 保留 GitHub 原来的 submittedAt，回放时会排到被撤销的 review 那个时间，改写之后的历史：用看到的时间。
      const at = r.state !== "DISMISSED" && first ? Math.min(r.submittedAt, seen) : seen;
      add("review", at, stageKey.review(s, r.id, r.state), { id: r.id, author: r.author, who: kindOf(r.author, r.id), state: r.state, body: r.body });
    }
    for (const c of [...pr.comments, ...inline]) {
      add("comment", c.createdAt, `${p}:comment:${b}:${c.id}`, {
        id: c.id, reviewId: c.reviewId, author: c.author, who: kindOf(c.author, null), body: c.body, path: c.path, line: c.line, url: c.url,
      });
    }
  }
  if (first || prev?.state !== next.state) {
    if (next.state === "merged") add("merged", Math.min(pr?.mergedAt ?? now, now), `${p}:merged:${b}:${next.number}`, { number: next.number });
    else if (next.state === "closed") add("closed", Math.min(pr?.closedAt ?? now, now), `${p}:closed:${b}:${next.number}`, { number: next.number });
  }
  return out;
}
