import { prUrlKey } from "../../shared/pr-url";
import type { PrMergeable, PrMergeState, PrReviewer, PrReviewRequest } from "../../shared/progress";
import type { WatchedPr } from "../../shared/types";
import type { CiCheck } from "../tickets/gh";
import type { Db } from "./database";

/**
 * 连续读失败至少这么多次、而且从第一次失败起已经过了 PR_READ_RETRY_MS 就放弃：之后一天才再试一次，
 * 开着的状态也不再挡着 ticket 合并 / 留在 in_review。只看次数的话，gh 离线几十分钟就会放弃所有 PR。
 */
export const PR_READ_GIVE_UP = 10;
/** 失败要持续这么久才放弃；放弃以后也隔这么久再试一次。 */
export const PR_READ_RETRY_MS = 24 * 60 * 60_000;
/**
 * GitHub 这么多次说 PR 不存在（仓库或 PR 解析不到、404），而且离这一串里第一次「不存在」过了 PR_NOT_FOUND_MIN_MS：认定它不存在，
 * 强制读也不再读。刚开的 PR 偶尔会短暂查不到，所以要几次、隔一会儿。
 */
export const PR_NOT_FOUND_GIVE_UP = 3;
export const PR_NOT_FOUND_MIN_MS = 10 * 60_000;
/**
 * 认定不存在以后隔这么久再读一次：GitHub 对当前账号看不到的私有仓库也回答「不存在」，换了账号、补了权限以后能自己恢复。
 * 又是「不存在」就再等这么久；读成功就全部清掉。
 */
export const PR_GONE_RETRY_MS = 7 * 24 * 60 * 60_000;

export type PrLinkSource = "branch" | "handoff" | "merge_gate" | "backfill";

export interface TicketPr {
  id: number;
  ticketKey: string;
  /** prUrlKey() 形式。 */
  url: string;
  slug: string;
  /** slug 对得上的 ticket 仓库；null = 不是这个 ticket 的仓库。 */
  repoId: number | null;
  number: number;
  headBranch: string | null;
  state: "open" | "merged" | "closed";
  review: WatchedPr["review"];
  ci: WatchedPr["ci"];
  /** 上一次 gh 读取失败；ci/state 仍是上一次的值。 */
  readError: boolean;
  headSha: string | null;
  failed: CiCheck[];
  openedAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  source: PrLinkSource;
  linkedAt: number;
  /** 0 = 从没读过。 */
  checkedAt: number;
  deliveredKey: string | null;
  /** CI 结论递出去的时间和收件 session（UI 重做第 1 层）；旧行和没递过的为 null。 */
  deliveredAt: number | null;
  deliveredTo: string | null;
  mergedHandledAt: number | null;
  /** 连续读失败的次数；读成功清零。 */
  readFailures: number;
  /** 这一串读失败的第一次；读成功清掉。 */
  readFailingSince: number | null;
  /** 放弃读以后下次再试的时间；null = 没放弃。 */
  readRetryAt: number | null;
  /** 读到「不存在」的次数；读成功、仓库改名改写链接时清零。 */
  readNotFound: number;
  /** 这一串「不存在」里第一次的时间；null = 没有。 */
  readNotFoundSince: number | null;
  /** 认定 PR 不存在的时间（PR_NOT_FOUND_GIVE_UP）：不再读；null = 没有。 */
  readGoneAt: number | null;
  /** 以下是 ws-b 加的（叠放树、轮到谁）；没读过时是空值。 */
  baseBranch: string | null;
  isDraft: boolean;
  title: string | null;
  author: string | null;
  labels: string[];
  reviewRequests: PrReviewRequest[];
  reviewers: PrReviewer[];
  mergeable: PrMergeable | null;
  mergeState: PrMergeState | null;
  /** 状态（state、review、CI、head、draft、合并状态、reviewer）最后一次变化的时间；没读过为 null。 */
  statusChangedAt: number | null;
}

/** 放弃读了（失败了 PR_READ_GIVE_UP 次、持续一天，或者认定不存在）：状态只是最后一次读到的，不再当真。 */
export const prGivenUp = (p: Pick<TicketPr, "readRetryAt"> & Partial<Pick<TicketPr, "readGoneAt">>): boolean =>
  p.readRetryAt !== null || (p.readGoneAt ?? null) !== null;

/** ticket 是不是还有链接的 PR 开着：只算读过的、没放弃的。 */
export const linkedOpen = (prs: (Pick<TicketPr, "state" | "checkedAt" | "readRetryAt"> & Partial<Pick<TicketPr, "readGoneAt">>)[]): boolean =>
  prs.some((p) => p.state === "open" && p.checkedAt > 0 && !prGivenUp(p));

export interface NewPrLink {
  ticketKey: string;
  url: string;
  slug: string;
  repoId: number | null;
  number: number;
  headBranch: string | null;
  state: TicketPr["state"];
  openedAt?: number | null;
  mergedAt?: number | null;
  closedAt?: number | null;
  source: PrLinkSource;
  linkedAt: number;
  mergedHandledAt?: number | null;
}

export type TicketPrPatch = Partial<
  Pick<TicketPr, "state" | "review" | "ci" | "readError" | "headSha" | "failed" | "headBranch" | "openedAt" | "mergedAt" | "closedAt" | "checkedAt" | "readFailures" | "readFailingSince" | "readRetryAt"
    | "readNotFound" | "readNotFoundSince" | "readGoneAt"
    | "baseBranch" | "isDraft" | "title" | "author" | "labels" | "reviewRequests" | "reviewers" | "mergeable" | "mergeState" | "statusChangedAt">
>;

interface Row {
  id: number;
  ticket_key: string;
  url: string;
  slug: string;
  repo_id: number | null;
  number: number;
  head_branch: string | null;
  state: TicketPr["state"];
  review: WatchedPr["review"];
  ci: WatchedPr["ci"];
  read_error: number;
  head_sha: string | null;
  failed: string;
  opened_at: number | null;
  merged_at: number | null;
  closed_at: number | null;
  source: PrLinkSource;
  linked_at: number;
  checked_at: number;
  delivered_key: string | null;
  delivered_at: number | null;
  delivered_to: string | null;
  merged_handled_at: number | null;
  read_failures: number;
  read_failing_since: number | null;
  read_retry_at: number | null;
  read_not_found: number;
  read_not_found_since: number | null;
  read_gone_at: number | null;
  base_branch: string | null;
  is_draft: number;
  title: string | null;
  author: string | null;
  labels: string;
  review_requests: string;
  reviewers: string;
  mergeable: PrMergeable | null;
  merge_state: PrMergeState | null;
  status_changed_at: number | null;
}

/** JSON 列：坏了就当作空的（不让一行坏数据挡住整个列表）。 */
function jsonList<T>(text: string | null): T[] {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

const num = (v: number | null): number | null => (v === null ? null : Number(v));

const toPr = (r: Row): TicketPr => ({
  id: Number(r.id), ticketKey: r.ticket_key, url: r.url, slug: r.slug, repoId: num(r.repo_id), number: Number(r.number),
  headBranch: r.head_branch, state: r.state, review: r.review, ci: r.ci, readError: Number(r.read_error) !== 0, headSha: r.head_sha,
  failed: JSON.parse(r.failed) as CiCheck[], openedAt: num(r.opened_at), mergedAt: num(r.merged_at), closedAt: num(r.closed_at),
  source: r.source, linkedAt: Number(r.linked_at), checkedAt: Number(r.checked_at), deliveredKey: r.delivered_key, deliveredAt: num(r.delivered_at), deliveredTo: r.delivered_to ?? null,
  mergedHandledAt: num(r.merged_handled_at), readFailures: Number(r.read_failures), readFailingSince: num(r.read_failing_since), readRetryAt: num(r.read_retry_at),
  readNotFound: Number(r.read_not_found ?? 0), readNotFoundSince: num(r.read_not_found_since ?? null), readGoneAt: num(r.read_gone_at ?? null),
  baseBranch: r.base_branch, isDraft: Number(r.is_draft) !== 0, title: r.title, author: r.author, labels: jsonList<string>(r.labels),
  reviewRequests: jsonList<PrReviewRequest>(r.review_requests), reviewers: jsonList<PrReviewer>(r.reviewers),
  mergeable: r.mergeable, mergeState: r.merge_state, statusChangedAt: num(r.status_changed_at),
});

/** 每个 (ticket, PR 链接) 一行：PR 的状态、CI、评审和已经交付给会话的 CI。 */
export class TicketPrsRepo {
  constructor(private readonly db: Db) {}

  /**
   * 链接一个 PR。已存在时只补空的 repo_id / head_branch / opened_at / merged_at / closed_at；
   * 从没读过（checked_at = 0）的行才采用新报告的 state。created 表示这是新行。
   */
  link(input: NewPrLink): { pr: TicketPr; created: boolean } {
    const l = { ...input, url: prUrlKey(input.url) };
    const existed = this.db.prepare(`SELECT 1 FROM ticket_prs WHERE ticket_key = ? AND url = ?`).get(l.ticketKey, l.url) !== undefined;
    this.db
      .prepare(
        `INSERT INTO ticket_prs (ticket_key, url, slug, repo_id, number, head_branch, state, opened_at, merged_at, closed_at, source, linked_at, merged_handled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ticket_key, url) DO UPDATE SET
           repo_id = COALESCE(ticket_prs.repo_id, excluded.repo_id),
           head_branch = COALESCE(ticket_prs.head_branch, excluded.head_branch),
           opened_at = COALESCE(ticket_prs.opened_at, excluded.opened_at),
           merged_at = COALESCE(ticket_prs.merged_at, excluded.merged_at),
           closed_at = COALESCE(ticket_prs.closed_at, excluded.closed_at),
           state = CASE WHEN ticket_prs.checked_at = 0 THEN excluded.state ELSE ticket_prs.state END`,
      )
      .run(
        l.ticketKey, l.url, l.slug, l.repoId, l.number, l.headBranch, l.state, l.openedAt ?? null, l.mergedAt ?? null, l.closedAt ?? null,
        l.source, l.linkedAt, l.mergedHandledAt ?? null,
      );
    const row = this.db.prepare(`SELECT * FROM ticket_prs WHERE ticket_key = ? AND url = ?`).get(l.ticketKey, l.url) as unknown as Row;
    return { pr: toPr(row), created: !existed };
  }

  get(id: number): TicketPr | null {
    const r = this.db.prepare(`SELECT * FROM ticket_prs WHERE id = ?`).get(id) as unknown as Row | undefined;
    return r ? toPr(r) : null;
  }

  /** 新的在前。 */
  byTicket(ticketKey: string): TicketPr[] {
    return (
      this.db
        .prepare(`SELECT * FROM ticket_prs WHERE ticket_key = ? ORDER BY COALESCE(opened_at, linked_at) DESC, id DESC`)
        .all(ticketKey) as unknown as Row[]
    ).map(toPr);
  }

  byUrl(url: string): TicketPr[] {
    return (this.db.prepare(`SELECT * FROM ticket_prs WHERE url = ? ORDER BY id`).all(prUrlKey(url)) as unknown as Row[]).map(toPr);
  }

  /**
   * 要读的：还开着的，和从没读过的。包括放弃了的（read_retry_at）：停到什么时候由调用方看，强制读不管它。
   * 认定不存在的（read_gone_at）不给，除非已经过了 PR_GONE_RETRY_MS（每隔这么久再试一次），或者 includeGone（调用方自己挑：用户点了刷新的照读）。
   */
  needingRead(now: number = Date.now(), o: { includeGone?: boolean } = {}): TicketPr[] {
    return (
      this.db
        .prepare(`SELECT * FROM ticket_prs WHERE (state = 'open' OR checked_at = 0) AND (? OR read_gone_at IS NULL OR read_gone_at <= ?) ORDER BY id`)
        .all(o.includeGone ? 1 : 0, now - PR_GONE_RETRY_MS) as unknown as Row[]
    ).map(toPr);
  }

  /** 已合并但 onMerged 还没处理完的。只算读过的：链接时说已合并、还没读过的，等读到 GitHub 的合并时间再判断是不是早就合并了。 */
  pendingMerged(): TicketPr[] {
    return (
      this.db.prepare(`SELECT * FROM ticket_prs WHERE state = 'merged' AND merged_handled_at IS NULL AND checked_at > 0 ORDER BY id`).all() as unknown as Row[]
    ).map(toPr);
  }

  update(id: number, p: TicketPrPatch): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null): void => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (p.state !== undefined) set("state", p.state);
    if (p.review !== undefined) set("review", p.review);
    if (p.ci !== undefined) set("ci", p.ci);
    if (p.readError !== undefined) set("read_error", p.readError ? 1 : 0);
    if (p.headSha !== undefined) set("head_sha", p.headSha);
    if (p.failed !== undefined) set("failed", JSON.stringify(p.failed));
    if (p.headBranch !== undefined) set("head_branch", p.headBranch);
    if (p.openedAt !== undefined) set("opened_at", p.openedAt);
    if (p.mergedAt !== undefined) set("merged_at", p.mergedAt);
    if (p.closedAt !== undefined) set("closed_at", p.closedAt);
    if (p.checkedAt !== undefined) set("checked_at", p.checkedAt);
    if (p.readFailures !== undefined) set("read_failures", p.readFailures);
    if (p.readFailingSince !== undefined) set("read_failing_since", p.readFailingSince);
    if (p.readRetryAt !== undefined) set("read_retry_at", p.readRetryAt);
    if (p.readNotFound !== undefined) set("read_not_found", p.readNotFound);
    if (p.readNotFoundSince !== undefined) set("read_not_found_since", p.readNotFoundSince);
    if (p.readGoneAt !== undefined) set("read_gone_at", p.readGoneAt);
    if (p.baseBranch !== undefined) set("base_branch", p.baseBranch);
    if (p.isDraft !== undefined) set("is_draft", p.isDraft ? 1 : 0);
    if (p.title !== undefined) set("title", p.title);
    if (p.author !== undefined) set("author", p.author);
    if (p.labels !== undefined) set("labels", JSON.stringify(p.labels));
    if (p.reviewRequests !== undefined) set("review_requests", JSON.stringify(p.reviewRequests));
    if (p.reviewers !== undefined) set("reviewers", JSON.stringify(p.reviewers));
    if (p.mergeable !== undefined) set("mergeable", p.mergeable);
    if (p.mergeState !== undefined) set("merge_state", p.mergeState);
    if (p.statusChangedAt !== undefined) set("status_changed_at", p.statusChangedAt);
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE ticket_prs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  /**
   * 一次读失败：记 read_error；从没读成功过的 checked_at 留 0（还算第一次读），读过的记成 now。
   * count（默认）时失败次数加一、记下这一串失败的开始；失败到 PR_READ_GIVE_UP 次而且已经失败了 PR_READ_RETRY_MS，
   * 停 PR_READ_RETRY_MS（之后每次失败再停一次）。count: false（整轮都读失败，像是 gh 离线）只记 read_error。
   * notFound（GitHub 说没有这个 PR）一定计数，另外 read_not_found 加一（第一次记下 read_not_found_since）；到 PR_NOT_FOUND_GIVE_UP 次、
   * 离第一次「不存在」已经 PR_NOT_FOUND_MIN_MS，记 read_gone_at。已经认定了的：到了每周再试的时候（隔了 PR_GONE_RETRY_MS）又是「不存在」，
   * read_gone_at 记成 now，再等一周；不到一周的强制读（用户刷新、session 停下）不往后推，不然常有人碰的 ticket 永远等不到每周那一次。
   * 别的失败不清 read_not_found（gh 离线一会儿不说明 PR 回来了），读成功才清。
   * 返回新的失败次数，和这一次是不是刚放弃（之前没停着；认定不存在也算）。
   */
  noteReadFailure(id: number, now: number, o: { count?: boolean; notFound?: boolean } = {}): { failures: number; gaveUp: boolean; gone: boolean } {
    const before = this.get(id);
    if (!before) return { failures: 0, gaveUp: false, gone: false };
    if (o.notFound) {
      const nf = before.readNotFound + 1;
      const since = before.readNotFoundSince ?? now;
      const gone = before.readGoneAt !== null || (nf >= PR_NOT_FOUND_GIVE_UP && now - since >= PR_NOT_FOUND_MIN_MS);
      this.db
        .prepare(`UPDATE ticket_prs SET read_not_found = ?, read_not_found_since = ?, read_gone_at = ? WHERE id = ?`)
        .run(nf, since, !gone ? null : before.readGoneAt !== null && now - before.readGoneAt < PR_GONE_RETRY_MS ? before.readGoneAt : now, id);
    }
    const count = o.notFound ? true : (o.count ?? true);
    const r = this.db
      .prepare(
        `UPDATE ticket_prs SET read_error = 1,
           checked_at = CASE WHEN checked_at = 0 THEN 0 ELSE :now END,
           read_failures = read_failures + :inc,
           read_failing_since = CASE WHEN :inc = 1 THEN COALESCE(read_failing_since, :now) ELSE read_failing_since END,
           read_retry_at = CASE WHEN :inc = 1 AND read_failures + 1 >= :limit AND :now - COALESCE(read_failing_since, :now) >= :span
             THEN :now + :span ELSE read_retry_at END
         WHERE id = :id RETURNING read_failures, read_retry_at`,
      )
      .get({ now, inc: count ? 1 : 0, limit: PR_READ_GIVE_UP, span: PR_READ_RETRY_MS, id }) as { read_failures: number; read_retry_at: number | null };
    const gone = before.readGoneAt === null && this.get(id)?.readGoneAt != null;
    return { failures: Number(r.read_failures), gaveUp: (before.readRetryAt === null && r.read_retry_at !== null) || gone, gone };
  }

  /** key 为 null 或没给 to 时，delivered_at 和 delivered_to 写 null。 */
  setDelivered(id: number, key: string | null, to?: { sessionId: string; at: number }): void {
    const t = key === null ? undefined : to;
    this.db.prepare(`UPDATE ticket_prs SET delivered_key = ?, delivered_at = ?, delivered_to = ? WHERE id = ?`).run(key, t?.at ?? null, t?.sessionId ?? null, id);
  }

  setMergedHandled(id: number, at: number): void {
    this.db.prepare(`UPDATE ticket_prs SET merged_handled_at = ? WHERE id = ?`).run(at, id);
  }

  /**
   * 仓库换了分支：删掉旧分支找到的、还开着的行（branch / backfill 来源）。合并的、关闭的（连同它们的进度事件）和 handoff 来源的留着。
   * 有 session 推过的分支（branch_owners）不算旧分支：worktree 里、checkout -b 开的分支上的 PR 留着。
   * 返回删了几行。
   */
  pruneStale(repoId: number, currentBranch: string): number {
    const res = this.db
      .prepare(
        `DELETE FROM ticket_prs WHERE repo_id = ? AND source IN ('branch','backfill') AND head_branch IS NOT ? AND state = 'open'
           AND NOT EXISTS (SELECT 1 FROM branch_owners o WHERE o.ticket_key = ticket_prs.ticket_key AND o.repo_id = ticket_prs.repo_id AND o.branch = ticket_prs.head_branch)`,
      )
      .run(repoId, currentBranch);
    return Number(res.changes);
  }

  /** 全部 PR（度量的每日 gh 任务用）。 */
  all(): TicketPr[] {
    return (this.db.prepare(`SELECT * FROM ticket_prs ORDER BY id`).all() as unknown as Row[]).map(toPr);
  }

  slugs(): string[] {
    return (this.db.prepare(`SELECT DISTINCT slug FROM ticket_prs ORDER BY slug`).all() as unknown as { slug: string }[]).map((r) => r.slug);
  }
}
