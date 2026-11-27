import { isAutomationLevel, type AutomationLevel } from "../../shared/automation";
import type { Feature, FeatureRepo } from "../../shared/types";
import { samePath } from "../tickets/ticket-service";
import type { Db } from "./database";

interface FeatureRow {
  id: number;
  name: string;
  workspace_dir: string;
  created_at: number;
  archived_at: number | null;
  brief: string | null;
  jira_epic_key: string | null;
  automation_level: string | null;
}

interface FeatureRepoRow {
  id: number;
  feature_id: number;
  repo_path: string;
  created_at: number;
}

const toRepo = (r: FeatureRepoRow): FeatureRepo => ({ id: Number(r.id), featureId: Number(r.feature_id), repoPath: r.repo_path, createdAt: r.created_at });

/** feature（设计文档 2026-10-26）：一组 ticket 加一个工作区目录。 */
/** 有 feature_id 列、指着 epic 的表（feature_repos 除外，它跟着 epic 一起删）。有一行指着就不算空 epic。 */
export const FEATURE_REFS = [
  "tickets", "sessions", "blocks", "session_messages", "feature_handoffs", "epic_history", "epic_memory_archive",
  "inbox_items", "pr_stage_events", "stacks", "fork_discussions", "shipherd_messages",
  // BTL-273：epic 设了自己的流程也不算空（id 可能被新 epic 复用，留下的层会套到它头上）。
  "workflow_layers",
] as const;

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
      brief: r.brief,
      jiraEpicKey: r.jira_epic_key,
      automationLevel: isAutomationLevel(r.automation_level) ? r.automation_level : null,
    };
  }

  insert(f: { name: string; workspaceDir: string; createdAt: number; brief?: string | null }): number {
    const res = this.db
      .prepare(`INSERT INTO features (name, workspace_dir, created_at, brief) VALUES (?, ?, ?, ?)`)
      .run(f.name, f.workspaceDir, f.createdAt, f.brief ?? null);
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

  /** 从 Jira 接进来、对应这个 Jira epic 的未归档 epic（BTL-246 §7）。 */
  byJiraEpic(key: string): Feature | null {
    const row = this.db.prepare(`SELECT * FROM features WHERE jira_epic_key = ? AND archived_at IS NULL`).get(key) as FeatureRow | undefined;
    return row ? this.toFeature(row) : null;
  }

  setJiraEpic(id: number, key: string | null): void {
    this.db.prepare(`UPDATE features SET jira_epic_key = ? WHERE id = ?`).run(key, id);
  }

  /** 以前属于某个旧 epic 的未归档 epic（BTL-246 §3：只有一次性搬旧 epic 记忆时读 epic_id）。 */
  legacyEpics(): { featureId: number; epicId: number }[] {
    const rows = this.db.prepare(`SELECT id, epic_id FROM features WHERE archived_at IS NULL AND epic_id IS NOT NULL ORDER BY id`).all() as { id: number; epic_id: number }[];
    return rows.map((r) => ({ featureId: Number(r.id), epicId: Number(r.epic_id) }));
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

  /** 这个 epic 自己选的自动化档位（BTL-247）；null = 跟随全局。 */
  automationLevel(id: number): AutomationLevel | null {
    const row = this.db.prepare(`SELECT automation_level FROM features WHERE id = ?`).get(id) as { automation_level: string | null } | undefined;
    return row && isAutomationLevel(row.automation_level) ? row.automation_level : null;
  }

  setAutomationLevel(id: number, level: AutomationLevel | null): void {
    this.db.prepare(`UPDATE features SET automation_level = ? WHERE id = ?`).run(level, id);
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

  /**
   * 刚建出来就没用上的 epic（BTL-248）：FEATURE_REFS 里没有一行指着它时连仓库行一起删，返回删没删。
   */
  deleteIfEmpty(id: number): boolean {
    const used = this.db
      .prepare(`SELECT ${FEATURE_REFS.map((t) => `EXISTS (SELECT 1 FROM ${t} WHERE feature_id = ?)`).join(" OR ")} AS used`)
      .get(...FEATURE_REFS.map(() => id)) as { used: number };
    if (used.used) return false;
    this.db.exec("SAVEPOINT delete_empty_epic");
    try {
      this.db.prepare(`DELETE FROM feature_repos WHERE feature_id = ?`).run(id);
      const res = this.db.prepare(`DELETE FROM features WHERE id = ?`).run(id);
      this.db.exec("RELEASE delete_empty_epic");
      return Number(res.changes) > 0;
    } catch {
      this.db.exec("ROLLBACK TO delete_empty_epic; RELEASE delete_empty_epic");
      return false;
    }
  }

  archive(id: number, at: number): void {
    this.db.prepare(`UPDATE features SET archived_at = ? WHERE id = ?`).run(at, id);
  }

  /** 同一个 Jira epic 已经有新的未归档 epic 时（归档后又接进来过），恢复出来的这个不再对应它。 */
  unarchive(id: number): void {
    this.db
      .prepare(`UPDATE features SET jira_epic_key = NULL WHERE id = ? AND jira_epic_key IN (SELECT jira_epic_key FROM features WHERE archived_at IS NULL AND jira_epic_key IS NOT NULL)`)
      .run(id);
    this.db.prepare(`UPDATE features SET archived_at = NULL WHERE id = ?`).run(id);
  }
}
