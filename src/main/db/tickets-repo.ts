import type { Ticket, TicketStatus, WorkMode } from "../../shared/types";
import type { Db } from "./database";

interface TicketRow {
  key: string;
  title: string | null;
  repo_path: string;
  work_mode: string;
  worktree_path: string | null;
  branch: string;
  status: string;
  status_manual: string | null;
  created_at: number;
  archived_at: number | null;
}

function toTicket(r: TicketRow): Ticket {
  return {
    key: r.key,
    title: r.title,
    repoPath: r.repo_path,
    workMode: r.work_mode as WorkMode,
    worktreePath: r.worktree_path,
    branch: r.branch,
    status: r.status as TicketStatus,
    statusManual: r.status_manual as TicketStatus | null,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

export class TicketsRepo {
  constructor(private readonly db: Db) {}

  insert(t: Ticket): void {
    this.db
      .prepare(
        `INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, status_manual, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.key, t.title, t.repoPath, t.workMode, t.worktreePath, t.branch, t.status, t.statusManual, t.createdAt, t.archivedAt);
  }

  get(key: string): Ticket | null {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE key = ?`).get(key) as TicketRow | undefined;
    return row ? toTicket(row) : null;
  }

  list(opts: { includeArchived?: boolean } = {}): Ticket[] {
    const where = opts.includeArchived ? "" : "WHERE archived_at IS NULL";
    const rows = this.db.prepare(`SELECT * FROM tickets ${where} ORDER BY created_at DESC, key`).all() as unknown as TicketRow[];
    return rows.map(toTicket);
  }

  /** 自动推导出的状态。只有状态真的变化时才更新 status_changed_at（UPDATE 右边读到的是旧值）。 */
  setStatus(key: string, status: TicketStatus, at: number): void {
    this.db
      .prepare(`UPDATE tickets SET status_changed_at = CASE WHEN status = ? THEN status_changed_at ELSE ? END, status = ? WHERE key = ?`)
      .run(status, at, status, key);
  }

  setStatusManual(key: string, status: TicketStatus | null, at: number | null = null): void {
    this.db.prepare(`UPDATE tickets SET status_manual = ?, status_manual_at = ? WHERE key = ?`).run(status, status ? at : null, key);
  }

  statusTimes(key: string): { changedAt: number | null; manualAt: number | null } {
    const r = this.db.prepare(`SELECT status_changed_at, status_manual_at FROM tickets WHERE key = ?`).get(key) as
      | { status_changed_at: number | null; status_manual_at: number | null }
      | undefined;
    return { changedAt: r?.status_changed_at ?? null, manualAt: r?.status_manual_at ?? null };
  }

  /** 编辑 ticket：标题、工作方式、worktree 路径和分支一起写。 */
  update(t: Pick<Ticket, "key" | "title" | "workMode" | "worktreePath" | "branch">): void {
    this.db
      .prepare(`UPDATE tickets SET title = ?, work_mode = ?, worktree_path = ?, branch = ? WHERE key = ?`)
      .run(t.title, t.workMode, t.worktreePath, t.branch, t.key);
  }

  archive(key: string, at: number): void {
    this.db.prepare(`UPDATE tickets SET archived_at = ? WHERE key = ?`).run(at, key);
  }

  unarchive(key: string): void {
    this.db.prepare(`UPDATE tickets SET archived_at = NULL WHERE key = ?`).run(key);
  }

  /** 已归档的 ticket，最近归档的在前。 */
  listArchived(): Ticket[] {
    const rows = this.db.prepare(`SELECT * FROM tickets WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, key`).all() as unknown as TicketRow[];
    return rows.map(toTicket);
  }
}
