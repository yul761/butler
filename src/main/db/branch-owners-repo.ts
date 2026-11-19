import type { Db } from "./database";

/** 一个分支是谁的：最近一次推这个分支、或者在上面开 PR 的 session（hook 看到的 git push / gh pr create）。 */
export interface BranchOwner {
  ticketKey: string;
  repoId: number;
  branch: string;
  /** 记下时的 session id（BUTLER_SESSION，/clear 之后用 head 找现在的那个）。 */
  sessionId: string;
  /** 推的时候在哪个目录（worktree 或仓库本身）：在这里跑 gh 列这个分支的 PR。 */
  dir: string;
  at: number;
}

interface Row { ticket_key: string; repo_id: number; branch: string; session_id: string; dir: string; at: number }

const toOwner = (r: Row): BranchOwner => ({
  ticketKey: r.ticket_key, repoId: Number(r.repo_id), branch: r.branch, sessionId: r.session_id, dir: r.dir, at: Number(r.at),
});

/** 每个 (ticket, 仓库, 分支) 一行，最新的推送为准。仓库删掉时一起删掉。 */
export class BranchOwnersRepo {
  constructor(private readonly db: Db) {}

  record(o: BranchOwner): void {
    this.db
      .prepare(
        `INSERT INTO branch_owners (ticket_key, repo_id, branch, session_id, dir, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (ticket_key, repo_id, branch) DO UPDATE SET session_id = excluded.session_id, dir = excluded.dir, at = excluded.at`,
      )
      .run(o.ticketKey, o.repoId, o.branch, o.sessionId, o.dir, o.at);
  }

  get(ticketKey: string, repoId: number, branch: string): BranchOwner | null {
    const r = this.db.prepare(`SELECT * FROM branch_owners WHERE ticket_key = ? AND repo_id = ? AND branch = ?`).get(ticketKey, repoId, branch) as unknown as Row | undefined;
    return r ? toOwner(r) : null;
  }

  /** 推过这个分支的（任何 ticket、任何仓库），新的在前（工作流 K：栈的层是不是 Butler 的）。 */
  byBranch(branch: string): BranchOwner[] {
    return (this.db.prepare(`SELECT * FROM branch_owners WHERE branch = ? ORDER BY at DESC`).all(branch) as unknown as Row[]).map(toOwner);
  }

  /** at >= since 的，新的在前。 */
  since(since: number): BranchOwner[] {
    return (this.db.prepare(`SELECT * FROM branch_owners WHERE at >= ? ORDER BY at DESC`).all(since) as unknown as Row[]).map(toOwner);
  }
}
