import type { Ticket, TicketRepo, TicketStatus, WorkMode } from "../../shared/types";
import { withTransaction, type Db } from "./database";

/**
 * tickets 表上的 repo_path / work_mode / worktree_path / branch 是单仓库时代的列（迁移 5 把它们搬进了 ticket_repos）：
 * SQLite 改列约束要重建表，而别的表有外键指向 tickets，所以保留，不再读；新 ticket 写入占位值。
 */
interface TicketRow {
  key: string;
  title: string | null;
  status: string;
  status_manual: string | null;
  created_at: number;
  archived_at: number | null;
}

interface RepoRow {
  id: number;
  ticket_key: string;
  repo_path: string;
  work_mode: string;
  worktree_path: string | null;
  branch: string;
  created_at: number;
}

function toRepo(r: RepoRow): TicketRepo {
  return {
    id: Number(r.id),
    ticketKey: r.ticket_key,
    repoPath: r.repo_path,
    workMode: r.work_mode as WorkMode,
    worktreePath: r.worktree_path,
    branch: r.branch,
    createdAt: r.created_at,
  };
}

export type NewTicket = Omit<Ticket, "repos">;
export type NewRepo = Omit<TicketRepo, "id">;

export class TicketsRepo {
  constructor(private readonly db: Db) {}

  private toTicket(r: TicketRow): Ticket {
    return {
      key: r.key,
      title: r.title,
      repos: this.listRepos(r.key),
      status: r.status as TicketStatus,
      statusManual: r.status_manual as TicketStatus | null,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
    };
  }

  /** 新 ticket，连同它的第一个仓库（可以没有）。返回仓库的 id。 */
  insert(t: NewTicket, repo?: NewRepo): number | null {
    return withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO tickets (key, title, repo_path, work_mode, worktree_path, branch, status, status_manual, created_at, archived_at)
           VALUES (?, ?, '', 'branch', NULL, '', ?, ?, ?, ?)`,
        )
        .run(t.key, t.title, t.status, t.statusManual, t.createdAt, t.archivedAt);
      return repo ? this.addRepo(repo) : null;
    });
  }

  get(key: string): Ticket | null {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE key = ?`).get(key) as TicketRow | undefined;
    return row ? this.toTicket(row) : null;
  }

  list(opts: { includeArchived?: boolean } = {}): Ticket[] {
    const where = opts.includeArchived ? "" : "WHERE archived_at IS NULL";
    const rows = this.db.prepare(`SELECT * FROM tickets ${where} ORDER BY created_at DESC, key`).all() as unknown as TicketRow[];
    return rows.map((r) => this.toTicket(r));
  }

  setTitle(key: string, title: string | null): void {
    this.db.prepare(`UPDATE tickets SET title = ? WHERE key = ?`).run(title, key);
  }

  addRepo(r: NewRepo): number {
    const res = this.db
      .prepare(`INSERT INTO ticket_repos (ticket_key, repo_path, work_mode, worktree_path, branch, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.ticketKey, r.repoPath, r.workMode, r.worktreePath, r.branch, r.createdAt);
    return Number(res.lastInsertRowid);
  }

  getRepo(id: number): TicketRepo | null {
    const row = this.db.prepare(`SELECT * FROM ticket_repos WHERE id = ?`).get(id) as RepoRow | undefined;
    return row ? toRepo(row) : null;
  }

  listRepos(ticketKey: string): TicketRepo[] {
    const rows = this.db.prepare(`SELECT * FROM ticket_repos WHERE ticket_key = ? ORDER BY id`).all(ticketKey) as unknown as RepoRow[];
    return rows.map(toRepo);
  }

  /** 改一个仓库的工作方式、worktree 路径和分支。 */
  updateRepo(r: Pick<TicketRepo, "id" | "workMode" | "worktreePath" | "branch">): void {
    this.db.prepare(`UPDATE ticket_repos SET work_mode = ?, worktree_path = ?, branch = ? WHERE id = ?`).run(r.workMode, r.worktreePath, r.branch, r.id);
  }

  /** 解除仓库和 ticket 的关联（磁盘上的东西不动）。为它开过的 session 留着，只是不再算在这个仓库名下。 */
  removeRepo(id: number): void {
    withTransaction(this.db, () => {
      this.db.prepare(`UPDATE sessions SET repo_id = NULL WHERE repo_id = ?`).run(id);
      this.db.prepare(`DELETE FROM ticket_repos WHERE id = ?`).run(id);
    });
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

  archive(key: string, at: number): void {
    this.db.prepare(`UPDATE tickets SET archived_at = ? WHERE key = ?`).run(at, key);
  }

  unarchive(key: string): void {
    this.db.prepare(`UPDATE tickets SET archived_at = NULL WHERE key = ?`).run(key);
  }

  /** 已归档的 ticket，最近归档的在前。 */
  listArchived(): Ticket[] {
    const rows = this.db.prepare(`SELECT * FROM tickets WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, key`).all() as unknown as TicketRow[];
    return rows.map((r) => this.toTicket(r));
  }
}
