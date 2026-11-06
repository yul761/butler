import type { WatchedPr } from "../../shared/types";
import type { CiCheck } from "../tickets/gh";
import type { Db } from "./database";

export interface PrWatchRow extends WatchedPr {
  failed: CiCheck[];
  deliveredKey: string | null;
}

interface Row {
  repo_id: number;
  ticket_key: string;
  repo_path: string;
  branch: string;
  number: number | null;
  url: string | null;
  state: WatchedPr["state"];
  review: WatchedPr["review"];
  ci: WatchedPr["ci"];
  head_sha: string | null;
  failed: string;
  checked_at: number;
  delivered_key: string | null;
}

const toRow = (r: Row): PrWatchRow => ({
  ticketKey: r.ticket_key, repoId: Number(r.repo_id), repoPath: r.repo_path, branch: r.branch,
  number: r.number === null ? null : Number(r.number), url: r.url, state: r.state, review: r.review, ci: r.ci, headSha: r.head_sha,
  checkedAt: Number(r.checked_at), failed: JSON.parse(r.failed) as CiCheck[], deliveredKey: r.delivered_key,
});

/** 被监视的 PR 状态；每个 ticket 仓库一行。 */
export class PrWatchRepo {
  constructor(private readonly db: Db) {}

  /** 写入最新状态；不动 deliveredKey。 */
  upsert(r: Omit<PrWatchRow, "deliveredKey">): void {
    this.db
      .prepare(
        `INSERT INTO pr_watch (repo_id, ticket_key, repo_path, branch, number, url, state, review, ci, head_sha, failed, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET ticket_key = excluded.ticket_key, repo_path = excluded.repo_path, branch = excluded.branch,
           number = excluded.number, url = excluded.url, state = excluded.state, review = excluded.review, ci = excluded.ci,
           head_sha = excluded.head_sha, failed = excluded.failed, checked_at = excluded.checked_at`,
      )
      .run(r.repoId, r.ticketKey, r.repoPath, r.branch, r.number, r.url, r.state, r.review, r.ci, r.headSha, JSON.stringify(r.failed), r.checkedAt);
  }

  get(repoId: number): PrWatchRow | null {
    const r = this.db.prepare(`SELECT * FROM pr_watch WHERE repo_id = ?`).get(repoId) as unknown as Row | undefined;
    return r ? toRow(r) : null;
  }

  byTicket(ticketKey: string): PrWatchRow[] {
    return (this.db.prepare(`SELECT * FROM pr_watch WHERE ticket_key = ? ORDER BY repo_id`).all(ticketKey) as unknown as Row[]).map(toRow);
  }

  all(): PrWatchRow[] {
    return (this.db.prepare(`SELECT * FROM pr_watch ORDER BY repo_id`).all() as unknown as Row[]).map(toRow);
  }

  setDelivered(repoId: number, key: string): void {
    this.db.prepare(`UPDATE pr_watch SET delivered_key = ? WHERE repo_id = ?`).run(key, repoId);
  }

  remove(repoId: number): void {
    this.db.prepare(`DELETE FROM pr_watch WHERE repo_id = ?`).run(repoId);
  }
}
