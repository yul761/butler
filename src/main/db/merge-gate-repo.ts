import type { MergeEvent } from "../../shared/types";
import type { Db } from "./database";

export interface MergeHold {
  id: number;
  repoPath: string;
  branch: string;
  target: string;
  kind: "pr" | "local";
  prUrl: string | null;
  sessionId: string | null;
  ticketKey: string | null;
  createdAt: number;
}

interface HoldRow {
  id: number;
  repo_path: string;
  branch: string;
  target: string;
  kind: "pr" | "local";
  pr_url: string | null;
  session_id: string | null;
  ticket_key: string | null;
  created_at: number;
}

interface EventRow {
  id: number;
  repo_path: string;
  kind: MergeEvent["kind"];
  ticket_key: string | null;
  branch: string;
  other_ticket: string | null;
  other_branch: string | null;
  files: string;
  created_at: number;
}

const toHold = (r: HoldRow): MergeHold => ({
  id: Number(r.id), repoPath: r.repo_path, branch: r.branch, target: r.target, kind: r.kind, prUrl: r.pr_url, sessionId: r.session_id, ticketKey: r.ticket_key, createdAt: r.created_at,
});

const toEvent = (r: EventRow): MergeEvent => ({
  id: Number(r.id), repoPath: r.repo_path, kind: r.kind, ticketKey: r.ticket_key, branch: r.branch, otherTicket: r.other_ticket, otherBranch: r.other_branch, files: JSON.parse(r.files) as string[], createdAt: r.created_at,
});

/** 合并总控的占位（hold）、等待者和事件记录。 */
export class MergeGateRepo {
  constructor(private readonly db: Db) {}

  addHold(h: Omit<MergeHold, "id">): number {
    const r = this.db
      .prepare(`INSERT INTO merge_holds (repo_path, branch, target, kind, pr_url, session_id, ticket_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(h.repoPath, h.branch, h.target, h.kind, h.prUrl, h.sessionId, h.ticketKey, h.createdAt);
    return Number(r.lastInsertRowid);
  }

  activeHolds(): MergeHold[] {
    return (this.db.prepare(`SELECT * FROM merge_holds WHERE released_at IS NULL ORDER BY id`).all() as unknown as HoldRow[]).map(toHold);
  }

  activeHold(repoPath: string, branch: string): MergeHold | null {
    const r = this.db.prepare(`SELECT * FROM merge_holds WHERE released_at IS NULL AND repo_path = ? AND branch = ? ORDER BY id DESC LIMIT 1`).get(repoPath, branch) as unknown as HoldRow | undefined;
    return r ? toHold(r) : null;
  }

  /** 本地占位换成 PR 占位（同一行，等待者跟着留下）：直接 push 没成、改走 PR 合并时用。时间从这次合并算起。 */
  toPrHold(id: number, h: { prUrl: string | null; sessionId: string | null; ticketKey: string | null; createdAt: number }): void {
    this.db
      .prepare(`UPDATE merge_holds SET kind = 'pr', pr_url = ?, session_id = ?, ticket_key = COALESCE(?, ticket_key), created_at = ? WHERE id = ? AND released_at IS NULL`)
      .run(h.prUrl, h.sessionId, h.ticketKey, h.createdAt, id);
  }

  releaseHold(id: number, outcome: "merged" | "cancelled" | "expired", at: number): void {
    this.db.prepare(`UPDATE merge_holds SET released_at = ?, outcome = ? WHERE id = ?`).run(at, outcome, id);
  }

  /** 同一 hold + session 只留一条（session 为空的不去重）。 */
  addWaiter(w: { holdId: number; sessionId: string | null; ticketKey: string | null; branch: string; createdAt: number }): void {
    if (w.sessionId !== null && this.db.prepare(`SELECT 1 FROM merge_waiters WHERE hold_id = ? AND session_id = ?`).get(w.holdId, w.sessionId)) return;
    this.db
      .prepare(`INSERT INTO merge_waiters (hold_id, session_id, ticket_key, branch, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(w.holdId, w.sessionId, w.ticketKey, w.branch, w.createdAt);
  }

  waitersOf(holdId: number): { id: number; sessionId: string | null; ticketKey: string | null; branch: string }[] {
    const rows = this.db.prepare(`SELECT id, session_id, ticket_key, branch FROM merge_waiters WHERE hold_id = ? ORDER BY id`).all(holdId) as unknown as {
      id: number; session_id: string | null; ticket_key: string | null; branch: string;
    }[];
    return rows.map((r) => ({ id: Number(r.id), sessionId: r.session_id, ticketKey: r.ticket_key, branch: r.branch }));
  }

  markNotified(waiterId: number, at: number): void {
    this.db.prepare(`UPDATE merge_waiters SET notified_at = ? WHERE id = ?`).run(at, waiterId);
  }

  /** 占位已释放（合完、取消、过期都算）、等待者还没通知的，带上怎么释放的和释放时间（没有 session 的等待者没法通知，不返回）。 */
  pendingNotices(): { waiterId: number; sessionId: string; otherTicket: string | null; otherBranch: string; outcome: "merged" | "cancelled" | "expired"; releasedAt: number }[] {
    const rows = this.db
      .prepare(
        `SELECT w.id AS waiter_id, w.session_id, h.ticket_key AS other_ticket, h.branch AS other_branch, h.outcome, h.released_at
         FROM merge_waiters w JOIN merge_holds h ON h.id = w.hold_id
         WHERE h.released_at IS NOT NULL AND h.outcome IS NOT NULL AND w.notified_at IS NULL AND w.session_id IS NOT NULL ORDER BY w.id`,
      )
      .all() as unknown as { waiter_id: number; session_id: string; other_ticket: string | null; other_branch: string; outcome: "merged" | "cancelled" | "expired"; released_at: number }[];
    return rows.map((r) => ({ waiterId: Number(r.waiter_id), sessionId: r.session_id, otherTicket: r.other_ticket, otherBranch: r.other_branch, outcome: r.outcome, releasedAt: r.released_at }));
  }

  addEvent(e: Omit<MergeEvent, "id">): number {
    const r = this.db
      .prepare(`INSERT INTO merge_events (repo_path, kind, ticket_key, branch, other_ticket, other_branch, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.repoPath, e.kind, e.ticketKey, e.branch, e.otherTicket, e.otherBranch, JSON.stringify(e.files), e.createdAt);
    return Number(r.lastInsertRowid);
  }

  /** since 之后的事件，新的在前。 */
  recentEvents(sinceMs: number, limit: number): MergeEvent[] {
    return (this.db.prepare(`SELECT * FROM merge_events WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(sinceMs, limit) as unknown as EventRow[]).map(toEvent);
  }

  /** 最近一条 other_branch = branch 的 proceed_conflict：后合的一方来时用它说明冲突来自谁。 */
  lastProceedAgainst(repoPath: string, branch: string): MergeEvent | null {
    const r = this.db
      .prepare(`SELECT * FROM merge_events WHERE kind = 'proceed_conflict' AND repo_path = ? AND other_branch = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(repoPath, branch) as unknown as EventRow | undefined;
    return r ? toEvent(r) : null;
  }
}
