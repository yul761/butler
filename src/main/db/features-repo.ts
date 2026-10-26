import type { Feature, FeatureRepo } from "../../shared/types";
import { samePath } from "../tickets/ticket-service";
import type { Db } from "./database";

interface FeatureRow {
  id: number;
  name: string;
  workspace_dir: string;
  created_at: number;
  archived_at: number | null;
}

interface FeatureRepoRow {
  id: number;
  feature_id: number;
  repo_path: string;
  created_at: number;
}

const toRepo = (r: FeatureRepoRow): FeatureRepo => ({ id: Number(r.id), featureId: Number(r.feature_id), repoPath: r.repo_path, createdAt: r.created_at });

/** feature（设计文档 2026-10-26）：一组 ticket 加一个工作区目录。 */
export class FeaturesRepo {
  constructor(private readonly db: Db) {}

  private toFeature(r: FeatureRow): Feature {
    const repos = this.db.prepare(`SELECT * FROM feature_repos WHERE feature_id = ? ORDER BY id`).all(r.id) as unknown as FeatureRepoRow[];
    return {
      id: Number(r.id),
      name: r.name,
      workspaceDir: r.workspace_dir,
      repos: repos.map(toRepo),
      createdAt: r.created_at,
      archivedAt: r.archived_at,
    };
  }

  insert(f: { name: string; workspaceDir: string; createdAt: number }): number {
    const res = this.db.prepare(`INSERT INTO features (name, workspace_dir, created_at) VALUES (?, ?, ?)`).run(f.name, f.workspaceDir, f.createdAt);
    return Number(res.lastInsertRowid);
  }

  get(id: number): Feature | null {
    const row = this.db.prepare(`SELECT * FROM features WHERE id = ?`).get(id) as FeatureRow | undefined;
    return row ? this.toFeature(row) : null;
  }

  list(opts: { includeArchived?: boolean } = {}): Feature[] {
    const where = opts.includeArchived ? "" : "WHERE archived_at IS NULL";
    const rows = this.db.prepare(`SELECT * FROM features ${where} ORDER BY created_at DESC, id`).all() as unknown as FeatureRow[];
    return rows.map((r) => this.toFeature(r));
  }

  /** 已归档的 feature，最近归档的在前。 */
  listArchived(): Feature[] {
    const rows = this.db.prepare(`SELECT * FROM features WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id`).all() as unknown as FeatureRow[];
    return rows.map((r) => this.toFeature(r));
  }

  /** 工作区就是这个目录的未归档 feature（Windows 不分大小写）。 */
  byWorkspace(dir: string): Feature | null {
    return this.list().find((f) => samePath(f.workspaceDir, dir)) ?? null;
  }

  setName(id: number, name: string): void {
    this.db.prepare(`UPDATE features SET name = ? WHERE id = ?`).run(name, id);
  }

  addRepo(featureId: number, repoPath: string, createdAt: number): number {
    const res = this.db.prepare(`INSERT INTO feature_repos (feature_id, repo_path, created_at) VALUES (?, ?, ?)`).run(featureId, repoPath, createdAt);
    return Number(res.lastInsertRowid);
  }

  getRepo(id: number): FeatureRepo | null {
    const row = this.db.prepare(`SELECT * FROM feature_repos WHERE id = ?`).get(id) as FeatureRepoRow | undefined;
    return row ? toRepo(row) : null;
  }

  /** 只影响以后在这个 feature 下建 ticket 时的选项；已有 ticket 的仓库不动。 */
  removeRepo(id: number): void {
    this.db.prepare(`DELETE FROM feature_repos WHERE id = ?`).run(id);
  }

  archive(id: number, at: number): void {
    this.db.prepare(`UPDATE features SET archived_at = ? WHERE id = ?`).run(at, id);
  }

  unarchive(id: number): void {
    this.db.prepare(`UPDATE features SET archived_at = NULL WHERE id = ?`).run(id);
  }
}
