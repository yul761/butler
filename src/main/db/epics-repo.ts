import type { Epic, EpicRepo } from "../../shared/types";
import { samePath } from "../tickets/ticket-service";
import type { Db } from "./database";

interface EpicRow {
  id: number;
  name: string;
  workspace_dir: string;
  created_at: number;
  archived_at: number | null;
}

interface EpicRepoRow {
  id: number;
  epic_id: number;
  repo_path: string;
  created_at: number;
}

const toRepo = (r: EpicRepoRow): EpicRepo => ({ id: Number(r.id), epicId: Number(r.epic_id), repoPath: r.repo_path });

/** epic：一组 feature 加一个规划用的工作区目录。 */
export class EpicsRepo {
  constructor(private readonly db: Db) {}

  private toEpic(r: EpicRow): Epic {
    const repos = this.db.prepare(`SELECT * FROM epic_repos WHERE epic_id = ? ORDER BY id`).all(r.id) as unknown as EpicRepoRow[];
    return {
      id: Number(r.id),
      name: r.name,
      workspaceDir: r.workspace_dir,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
      repos: repos.map(toRepo),
    };
  }

  insert(e: { name: string; workspaceDir: string; createdAt: number }): number {
    const res = this.db.prepare(`INSERT INTO epics (name, workspace_dir, created_at) VALUES (?, ?, ?)`).run(e.name, e.workspaceDir, e.createdAt);
    return Number(res.lastInsertRowid);
  }

  get(id: number): Epic | null {
    const row = this.db.prepare(`SELECT * FROM epics WHERE id = ?`).get(id) as EpicRow | undefined;
    return row ? this.toEpic(row) : null;
  }

  list(opts: { includeArchived?: boolean } = {}): Epic[] {
    const where = opts.includeArchived ? "" : "WHERE archived_at IS NULL";
    const rows = this.db.prepare(`SELECT * FROM epics ${where} ORDER BY created_at DESC, id`).all() as unknown as EpicRow[];
    return rows.map((r) => this.toEpic(r));
  }

  /** 已归档的 epic，最近归档的在前。 */
  listArchived(): Epic[] {
    const rows = this.db.prepare(`SELECT * FROM epics WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id`).all() as unknown as EpicRow[];
    return rows.map((r) => this.toEpic(r));
  }

  /** 工作区就是这个目录的未归档 epic（Windows 不分大小写）。 */
  byWorkspace(dir: string): Epic | null {
    return this.list().find((e) => samePath(e.workspaceDir, dir)) ?? null;
  }

  setName(id: number, name: string): void {
    this.db.prepare(`UPDATE epics SET name = ? WHERE id = ?`).run(name, id);
  }

  addRepo(epicId: number, repoPath: string, createdAt: number): number {
    const res = this.db.prepare(`INSERT INTO epic_repos (epic_id, repo_path, created_at) VALUES (?, ?, ?)`).run(epicId, repoPath, createdAt);
    return Number(res.lastInsertRowid);
  }

  getRepo(id: number): EpicRepo | null {
    const row = this.db.prepare(`SELECT * FROM epic_repos WHERE id = ?`).get(id) as EpicRepoRow | undefined;
    return row ? toRepo(row) : null;
  }

  removeRepo(id: number): void {
    this.db.prepare(`DELETE FROM epic_repos WHERE id = ?`).run(id);
  }

  archive(id: number, at: number): void {
    this.db.prepare(`UPDATE epics SET archived_at = ? WHERE id = ?`).run(at, id);
  }

  unarchive(id: number): void {
    this.db.prepare(`UPDATE epics SET archived_at = NULL WHERE id = ?`).run(id);
  }
}
