import { prUrlKey } from "../../shared/pr-url";
import type { WatchedPr } from "../../shared/types";
import type { CiCheck } from "../tickets/gh";
import type { Db } from "./database";

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
  mergedHandledAt: number | null;
}

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
  Pick<TicketPr, "state" | "review" | "ci" | "readError" | "headSha" | "failed" | "headBranch" | "openedAt" | "mergedAt" | "closedAt" | "checkedAt">
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
  merged_handled_at: number | null;
}

const num = (v: number | null): number | null => (v === null ? null : Number(v));

const toPr = (r: Row): TicketPr => ({
  id: Number(r.id), ticketKey: r.ticket_key, url: r.url, slug: r.slug, repoId: num(r.repo_id), number: Number(r.number),
  headBranch: r.head_branch, state: r.state, review: r.review, ci: r.ci, readError: Number(r.read_error) !== 0, headSha: r.head_sha,
  failed: JSON.parse(r.failed) as CiCheck[], openedAt: num(r.opened_at), mergedAt: num(r.merged_at), closedAt: num(r.closed_at),
  source: r.source, linkedAt: Number(r.linked_at), checkedAt: Number(r.checked_at), deliveredKey: r.delivered_key,
  mergedHandledAt: num(r.merged_handled_at),
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

  /** 要读的：还开着的，和从没读过的。 */
  needingRead(): TicketPr[] {
    return (
      this.db.prepare(`SELECT * FROM ticket_prs WHERE state = 'open' OR checked_at = 0 ORDER BY id`).all() as unknown as Row[]
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
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE ticket_prs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  setDelivered(id: number, key: string | null): void {
    this.db.prepare(`UPDATE ticket_prs SET delivered_key = ? WHERE id = ?`).run(key, id);
  }

  setMergedHandled(id: number, at: number): void {
    this.db.prepare(`UPDATE ticket_prs SET merged_handled_at = ? WHERE id = ?`).run(at, id);
  }

  /** 仓库换了分支：删掉旧分支找到的、还没合并的行（branch / backfill 来源）。合并的和 handoff 来源的留着。返回删了几行。 */
  pruneStale(repoId: number, currentBranch: string): number {
    const res = this.db
      .prepare(
        `DELETE FROM ticket_prs WHERE repo_id = ? AND source IN ('branch','backfill') AND head_branch IS NOT ? AND state != 'merged'`,
      )
      .run(repoId, currentBranch);
    return Number(res.changes);
  }

  slugs(): string[] {
    return (this.db.prepare(`SELECT DISTINCT slug FROM ticket_prs ORDER BY slug`).all() as unknown as { slug: string }[]).map((r) => r.slug);
  }
}
