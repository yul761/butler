import type { Db } from "./database";
import { withTransaction } from "./database";

/** data 里只放标量：类别、子类型、来源。不放用户写的原文。 */
export type MetricData = Record<string, string | number | boolean | null>;

export interface MetricEvent {
  id: number;
  kind: string;
  at: number;
  sessionId: string | null;
  ticketKey: string | null;
  prId: number | null;
  repoSlug: string | null;
  data: MetricData;
  dedupeKey: string | null;
}

export type NewMetricEvent = Omit<MetricEvent, "id">;

export type WaitKind = "human" | "idle";

export interface WaitSpan {
  id: number;
  sessionId: string;
  ticketKey: string | null;
  kind: WaitKind;
  category: string | null;
  source: string | null;
  startedAt: number;
  endedAt: number | null;
  lastSeenAt: number;
}

export type GroupKind = "all" | "repo" | "product" | "risk";

export interface DailyRow {
  day: string;
  groupKind: GroupKind;
  groupKey: string;
  shipherd: boolean;
  metric: string;
  n: number;
  total: number;
}

export interface BaselinePr {
  slug: string;
  number: number;
  openedAt: number;
  mergedAt: number;
  firstCommitAt: number | null;
  humanComments: number;
  copilotComments: number;
  fetchedAt: number;
}

interface EventRow {
  id: number; kind: string; at: number; session_id: string | null; ticket_key: string | null; pr_id: number | null;
  repo_slug: string | null; data: string; dedupe_key: string | null;
}
interface SpanRow {
  id: number; session_id: string; ticket_key: string | null; kind: WaitKind; category: string | null; source: string | null;
  started_at: number; ended_at: number | null; last_seen_at: number;
}
interface DailyDbRow { day: string; group_kind: GroupKind; group_key: string; shipherd: number; metric: string; n: number; total: number }
interface BaselineRow {
  slug: string; number: number; opened_at: number; merged_at: number; first_commit_at: number | null;
  human_comments: number; copilot_comments: number; fetched_at: number;
}

function parseData(s: string): MetricData {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as MetricData) : {};
  } catch {
    return {};
  }
}

const toEvent = (r: EventRow): MetricEvent => ({
  id: Number(r.id), kind: r.kind, at: Number(r.at), sessionId: r.session_id, ticketKey: r.ticket_key,
  prId: r.pr_id === null ? null : Number(r.pr_id), repoSlug: r.repo_slug, data: parseData(r.data), dedupeKey: r.dedupe_key,
});
const toSpan = (r: SpanRow): WaitSpan => ({
  id: Number(r.id), sessionId: r.session_id, ticketKey: r.ticket_key, kind: r.kind, category: r.category, source: r.source,
  startedAt: Number(r.started_at), endedAt: r.ended_at === null ? null : Number(r.ended_at), lastSeenAt: Number(r.last_seen_at),
});
const toDaily = (r: DailyDbRow): DailyRow => ({
  day: r.day, groupKind: r.group_kind, groupKey: r.group_key, shipherd: Number(r.shipherd) === 1, metric: r.metric, n: Number(r.n), total: Number(r.total),
});
const toBaseline = (r: BaselineRow): BaselinePr => ({
  slug: r.slug, number: Number(r.number), openedAt: Number(r.opened_at), mergedAt: Number(r.merged_at),
  firstCommitAt: r.first_commit_at === null ? null : Number(r.first_commit_at), humanComments: Number(r.human_comments),
  copilotComments: Number(r.copilot_comments), fetchedAt: Number(r.fetched_at),
});

/** ws-h 的度量表（契约 4.7）：事件、等人时间段、每日汇总、基线 PR。 */
export class MetricsRepo {
  constructor(private readonly db: Db) {}

  /** 记一条事件；dedupeKey 已有的不记，返回 false。 */
  addEvent(e: NewMetricEvent): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO metrics_events (kind, at, session_id, ticket_key, pr_id, repo_slug, data, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.kind, e.at, e.sessionId, e.ticketKey, e.prId, e.repoSlug, JSON.stringify(e.data), e.dedupeKey);
    return Number(r.changes) > 0;
  }

  hasEvent(dedupeKey: string): boolean {
    return this.db.prepare(`SELECT 1 FROM metrics_events WHERE dedupe_key = ?`).get(dedupeKey) !== undefined;
  }

  /** at >= since 的事件，按时间先后；kinds 给了就只要这些。 */
  events(since: number, kinds?: readonly string[]): MetricEvent[] {
    const rows = this.db.prepare(`SELECT * FROM metrics_events WHERE at >= ? ORDER BY at, id`).all(since) as unknown as EventRow[];
    const all = rows.map(toEvent);
    return kinds ? all.filter((e) => kinds.includes(e.kind)) : all;
  }

  /** 开一个等待段，返回 id。 */
  openSpan(s: Omit<WaitSpan, "id" | "endedAt" | "lastSeenAt">): number {
    const r = this.db
      .prepare(
        `INSERT INTO metrics_wait_spans (session_id, ticket_key, kind, category, source, started_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.sessionId, s.ticketKey, s.kind, s.category, s.source, s.startedAt, s.startedAt);
    return Number(r.lastInsertRowid);
  }

  touchSpan(id: number, at: number): void {
    this.db.prepare(`UPDATE metrics_wait_spans SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL`).run(at, id);
  }

  setSpanCategory(id: number, category: string): void {
    this.db.prepare(`UPDATE metrics_wait_spans SET category = ? WHERE id = ?`).run(category, id);
  }

  closeSpan(id: number, at: number): void {
    this.db.prepare(`UPDATE metrics_wait_spans SET ended_at = MAX(?, started_at), last_seen_at = MAX(?, started_at) WHERE id = ? AND ended_at IS NULL`).run(at, at, id);
  }

  openSpans(): WaitSpan[] {
    return (this.db.prepare(`SELECT * FROM metrics_wait_spans WHERE ended_at IS NULL ORDER BY id`).all() as unknown as SpanRow[]).map(toSpan);
  }

  /** 启动时：上次没关的段按最后看到的时间关掉（Shipherd 没在跑的那段不算）。返回关了几个。 */
  closeStale(): number {
    return Number(this.db.prepare(`UPDATE metrics_wait_spans SET ended_at = last_seen_at WHERE ended_at IS NULL`).run().changes);
  }

  /** 和 [since, ∞) 有交集的段。 */
  spans(since: number): WaitSpan[] {
    return (
      this.db.prepare(`SELECT * FROM metrics_wait_spans WHERE COALESCE(ended_at, last_seen_at) >= ? ORDER BY started_at, id`).all(since) as unknown as SpanRow[]
    ).map(toSpan);
  }

  /** fromDay（含）之后的汇总整体换成 rows：一个事务里先删后插。 */
  replaceDaily(fromDay: string, rows: readonly DailyRow[]): void {
    withTransaction(this.db, () => {
      this.db.prepare(`DELETE FROM metrics_daily WHERE day >= ?`).run(fromDay);
      const ins = this.db.prepare(
        `INSERT INTO metrics_daily (day, group_kind, group_key, shipherd, metric, n, total) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, group_kind, group_key, shipherd, metric) DO UPDATE SET n = n + excluded.n, total = total + excluded.total`,
      );
      for (const r of rows) ins.run(r.day, r.groupKind, r.groupKey, r.shipherd ? 1 : 0, r.metric, r.n, r.total);
    });
  }

  /** beforeDay 之前的汇总行删掉（超出重算窗口、不会再更新的）。返回删了几行。 */
  pruneDaily(beforeDay: string): number {
    return Number(this.db.prepare(`DELETE FROM metrics_daily WHERE day < ?`).run(beforeDay).changes);
  }

  /** fromDay（含）之后的汇总行。 */
  daily(fromDay: string): DailyRow[] {
    return (this.db.prepare(`SELECT * FROM metrics_daily WHERE day >= ? ORDER BY day`).all(fromDay) as unknown as DailyDbRow[]).map(toDaily);
  }

  upsertBaseline(b: BaselinePr): void {
    this.db
      .prepare(
        `INSERT INTO metrics_baseline_prs (slug, number, opened_at, merged_at, first_commit_at, human_comments, copilot_comments, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slug, number) DO UPDATE SET opened_at = excluded.opened_at, merged_at = excluded.merged_at,
           first_commit_at = excluded.first_commit_at, human_comments = excluded.human_comments,
           copilot_comments = excluded.copilot_comments, fetched_at = excluded.fetched_at`,
      )
      .run(b.slug, b.number, b.openedAt, b.mergedAt, b.firstCommitAt, b.humanComments, b.copilotComments, b.fetchedAt);
  }

  hasBaseline(slug: string, number: number): boolean {
    return this.db.prepare(`SELECT 1 FROM metrics_baseline_prs WHERE slug = ? AND number = ?`).get(slug, number) !== undefined;
  }

  baselinePrs(): BaselinePr[] {
    return (this.db.prepare(`SELECT * FROM metrics_baseline_prs ORDER BY merged_at`).all() as unknown as BaselineRow[]).map(toBaseline);
  }
}
