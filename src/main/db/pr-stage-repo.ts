import type { Db } from "./database";

export type StageEventKind =
  | "skill" | "first_commit" | "pr_opened" | "push" | "ci" | "review" | "comment" | "merged" | "closed";

export interface StageEvent {
  id: number;
  /** ticket 层事件：ticketKey 有值。repoId 为 null 表示挂到这个 ticket 的所有仓库（多仓库 ticket 的总控）。 */
  ticketKey: string | null;
  repoId: number | null;
  /** 事件属于哪个 PR（ticket_prs.id）；skill 等不属于具体 PR 的事件为 null。 */
  prId: number | null;
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
  pr_id: number | null;
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
  id: Number(r.id), ticketKey: r.ticket_key, repoId: num(r.repo_id), prId: num(r.pr_id), branch: r.branch, featureId: num(r.feature_id),
  epicId: num(r.epic_id), sessionId: r.session_id, kind: r.kind, at: Number(r.at), data: JSON.parse(r.data) as Record<string, unknown>,
});

/** PR 进度条的原始事件；阶段由纯函数从这些事件推导。 */
export class PrStageRepo {
  constructor(private readonly db: Db) {}

  /** dedupeKey 已存在就什么都不做，返回 false。 */
  add(e: Omit<StageEvent, "id">, dedupeKey: string): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO pr_stage_events (dedupe_key, ticket_key, repo_id, pr_id, branch, feature_id, epic_id, session_id, kind, at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(dedupeKey, e.ticketKey, e.repoId, e.prId, e.branch, e.featureId, e.epicId, e.sessionId, e.kind, e.at, JSON.stringify(e.data));
    return Number(res.changes) > 0;
  }

  has(dedupeKey: string): boolean {
    return this.db.prepare(`SELECT 1 FROM pr_stage_events WHERE dedupe_key = ?`).get(dedupeKey) !== undefined;
  }

  /** 有过这种事件的 ticket（进度页的"开工过"用 first_commit，ws-b）。 */
  ticketsWith(kind: StageEventKind): Set<string> {
    const rows = this.db.prepare(`SELECT DISTINCT ticket_key FROM pr_stage_events WHERE kind = ?`).all(kind) as { ticket_key: string }[];
    return new Set(rows.map((r) => r.ticket_key));
  }

  /** 这个 ticket 的全部事件（所有 PR），按 at、id 排序。 */
  forTicket(ticketKey: string): StageEvent[] {
    return (
      this.db.prepare(`SELECT * FROM pr_stage_events WHERE ticket_key = ? ORDER BY at, id`).all(ticketKey) as unknown as Row[]
    ).map(toEvent);
  }

  /** 这个 PR 最新的 ci 事件。 */
  lastCi(prId: number): { sha: string | null; result: string } | null {
    const r = this.db
      .prepare(`SELECT data FROM pr_stage_events WHERE pr_id = ? AND kind = 'ci' ORDER BY at DESC, id DESC LIMIT 1`)
      .get(prId) as unknown as { data: string } | undefined;
    if (!r) return null;
    const d = JSON.parse(r.data) as { sha?: string | null; result?: string };
    return { sha: d.sha ?? null, result: d.result ?? "" };
  }

  /** 最早的 skill 事件时间；没有为 null。 */
  firstSkillAt(): number | null {
    const r = this.db.prepare(`SELECT MIN(at) AS at FROM pr_stage_events WHERE kind = 'skill'`).get() as unknown as { at: number | null };
    return r.at === null ? null : Number(r.at);
  }

  /** feature 层和它所在 epic 层的 design skill 事件，按 at 排序。epicId 为 null 时只看 feature。 */
  upperDesign(featureId: number, epicId: number | null): StageEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM pr_stage_events
           WHERE kind = 'skill' AND json_extract(data, '$.category') = 'design' AND ticket_key IS NULL
             AND (feature_id = ? OR (? IS NOT NULL AND epic_id = ? AND feature_id IS NULL))
           ORDER BY at, id`,
        )
        .all(featureId, epicId, epicId) as unknown as Row[]
    ).map(toEvent);
  }
}
