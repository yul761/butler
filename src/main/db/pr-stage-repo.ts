import type { Db } from "./database";

export type StageEventKind =
  | "skill" | "first_commit" | "pr_opened" | "push" | "ci" | "review" | "comment" | "merged" | "closed";

export interface StageEvent {
  id: number;
  /** ticket 层事件：ticketKey 有值。repoId 为 null 表示挂到这个 ticket 的所有仓库（多仓库 ticket 的总控）。 */
  ticketKey: string | null;
  repoId: number | null;
  /** PR 监视的事件记下当时的分支；skill 事件为 null。 */
  branch: string | null;
  /** feature 层或 epic 层的 skill 事件（只用来判断"在 feature 层完成"）。 */
  featureId: number | null;
  epicId: number | null;
  sessionId: string | null;
  kind: StageEventKind;
  at: number;
  /** 按 kind：skill {name, category}；ci {result: "pending"|"passing"|"failing", sha}；push {sha}；
   *  review {id, author, who: "copilot"|"human"|"author"|"bot", state, body}；
   *  comment {id, reviewId|null, author, who, body, path|null, line|null, url|null}；pr_opened/merged/closed {number}；first_commit {} */
  data: Record<string, unknown>;
}

interface Row {
  id: number;
  ticket_key: string | null;
  repo_id: number | null;
  branch: string | null;
  feature_id: number | null;
  epic_id: number | null;
  session_id: string | null;
  kind: StageEventKind;
  at: number;
  data: string;
}

const num = (v: number | null): number | null => (v === null ? null : Number(v));

const toEvent = (r: Row): StageEvent => ({
  id: Number(r.id), ticketKey: r.ticket_key, repoId: num(r.repo_id), branch: r.branch, featureId: num(r.feature_id),
  epicId: num(r.epic_id), sessionId: r.session_id, kind: r.kind, at: Number(r.at), data: JSON.parse(r.data) as Record<string, unknown>,
});

/** PR 进度条的原始事件；阶段由纯函数从这些事件推导。 */
export class PrStageRepo {
  constructor(private readonly db: Db) {}

  /** dedupeKey 已存在就什么都不做，返回 false。 */
  add(e: Omit<StageEvent, "id">, dedupeKey: string): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO pr_stage_events (dedupe_key, ticket_key, repo_id, branch, feature_id, epic_id, session_id, kind, at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(dedupeKey, e.ticketKey, e.repoId, e.branch, e.featureId, e.epicId, e.sessionId, e.kind, e.at, JSON.stringify(e.data));
    return Number(res.changes) > 0;
  }

  has(dedupeKey: string): boolean {
    return this.db.prepare(`SELECT 1 FROM pr_stage_events WHERE dedupe_key = ?`).get(dedupeKey) !== undefined;
  }

  /** 这个 ticket 的事件：repoId 等于 repoId 或为 null 的，PR 监视的事件只要 branch 等于 branch 的。按 at、id 排序。 */
  forRepo(ticketKey: string, repoId: number, branch: string): StageEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM pr_stage_events
           WHERE ticket_key = ? AND (repo_id IS NULL OR repo_id = ?) AND (branch IS NULL OR branch = ?)
           ORDER BY at, id`,
        )
        .all(ticketKey, repoId, branch) as unknown as Row[]
    ).map(toEvent);
  }

  /** feature 层和它所在 epic 层的 design skill 事件，按 at 排序。epicId 为 null 时只看 feature。 */
  upperDesign(featureId: number, epicId: number | null): StageEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM pr_stage_events
           WHERE kind = 'skill' AND json_extract(data, '$.category') = 'design' AND (feature_id = ? OR (? IS NOT NULL AND epic_id = ?))
           ORDER BY at, id`,
        )
        .all(featureId, epicId, epicId) as unknown as Row[]
    ).map(toEvent);
  }
}
