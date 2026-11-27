import type { WatchedPr } from "../../shared/types";
import type { CiCheck } from "../tickets/gh";
import type { Db } from "./database";

export interface BranchWatchRow {
  repoId: number;
  ticketKey: string;
  branch: string;
  ci: WatchedPr["ci"];
  headSha: string | null;
  failed: CiCheck[];
  readError: boolean;
  checkedAt: number;
  deliveredKey: string | null;
}

interface Row {
  repo_id: number;
  ticket_key: string;
  branch: string;
  ci: WatchedPr["ci"];
  head_sha: string | null;
  failed: string;
  read_error: number;
  checked_at: number;
  delivered_key: string | null;
}

const toRow = (r: Row): BranchWatchRow => ({
  repoId: Number(r.repo_id), ticketKey: r.ticket_key, branch: r.branch, ci: r.ci, headSha: r.head_sha,
  failed: JSON.parse(r.failed) as CiCheck[], readError: Number(r.read_error) !== 0, checkedAt: Number(r.checked_at),
  deliveredKey: r.delivered_key,
});

/** 还没有 PR 的分支的 CI；每个 ticket 仓库一行。 */
export class BranchWatchRepo {
  constructor(private readonly db: Db) {}

  get(repoId: number): BranchWatchRow | null {
    const r = this.db.prepare(`SELECT * FROM branch_watch WHERE repo_id = ?`).get(repoId) as unknown as Row | undefined;
    return r ? toRow(r) : null;
  }

  /** 写入最新状态；分支没变时不动 deliveredKey，换了分支就清掉。 */
  upsert(r: Omit<BranchWatchRow, "deliveredKey">): void {
    this.db
      .prepare(
        `INSERT INTO branch_watch (repo_id, ticket_key, branch, ci, head_sha, failed, read_error, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET
           delivered_key = CASE WHEN branch_watch.branch = excluded.branch THEN branch_watch.delivered_key ELSE NULL END,
           ticket_key = excluded.ticket_key, branch = excluded.branch, ci = excluded.ci, head_sha = excluded.head_sha,
           failed = excluded.failed, read_error = excluded.read_error, checked_at = excluded.checked_at`,
      )
      .run(r.repoId, r.ticketKey, r.branch, r.ci, r.headSha, JSON.stringify(r.failed), r.readError ? 1 : 0, r.checkedAt);
  }

  setDelivered(repoId: number, key: string | null): void {
    this.db.prepare(`UPDATE branch_watch SET delivered_key = ? WHERE repo_id = ?`).run(key, repoId);
  }

  /** 这个 ticket 的分支行，按 repo_id。 */
  byTicket(ticketKey: string): BranchWatchRow[] {
    return (this.db.prepare(`SELECT * FROM branch_watch WHERE ticket_key = ? ORDER BY repo_id`).all(ticketKey) as unknown as Row[]).map(toRow);
  }

  /** byTicket() 的批量版（BTL-275）。没有的不在 Map 里。 */
  byTickets(ticketKeys: readonly string[]): Map<string, BranchWatchRow[]> {
    const out = new Map<string, BranchWatchRow[]>();
    if (ticketKeys.length === 0) return out;
    const rows = (
      this.db.prepare(`SELECT * FROM branch_watch WHERE ticket_key IN (SELECT value FROM json_each(?)) ORDER BY repo_id`).all(JSON.stringify(ticketKeys)) as unknown as Row[]
    ).map(toRow);
    for (const r of rows) {
      const list = out.get(r.ticketKey);
      if (list) list.push(r);
      else out.set(r.ticketKey, [r]);
    }
    return out;
  }

  all(): BranchWatchRow[] {
    return (this.db.prepare(`SELECT * FROM branch_watch ORDER BY repo_id`).all() as unknown as Row[]).map(toRow);
  }
}
