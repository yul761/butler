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

  setStatusManual(key: string, status: TicketStatus | null): void {
    this.db.prepare(`UPDATE tickets SET status_manual = ? WHERE key = ?`).run(status, key);
  }

  archive(key: string, at: number): void {
    this.db.prepare(`UPDATE tickets SET archived_at = ? WHERE key = ?`).run(at, key);
  }
}
