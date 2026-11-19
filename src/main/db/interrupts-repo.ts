import type {
  AutoChoice, AutoChoiceSource, ChoiceDefault, NotificationLogEntry, NotifyEvent, NotifyStatus, ProfileRule, ProfileSource, ProfileStatus,
} from "../../shared/interrupts";
import type { Db } from "./database";

/** 权限档案（ws-j 设计 2.4）：每个仓库每条规则用户的决定。安全检查在 service 里（isSafeRule），这里只存。 */
export class PermissionProfileRepo {
  constructor(private readonly db: Db) {}

  all(): ProfileRule[] {
    return (this.db.prepare(`SELECT * FROM permission_profiles ORDER BY slug, rule`).all() as unknown as Row[]).map(toRule);
  }

  bySlug(slug: string): ProfileRule[] {
    return (this.db.prepare(`SELECT * FROM permission_profiles WHERE slug = ? ORDER BY rule`).all(slug) as unknown as Row[]).map(toRule);
  }

  get(slug: string, rule: string): ProfileRule | null {
    const r = this.db.prepare(`SELECT * FROM permission_profiles WHERE slug = ? AND rule = ?`).get(slug, rule) as Row | undefined;
    return r ? toRule(r) : null;
  }

  /** 这些仓库确认过的规则。 */
  confirmed(slugs: readonly string[]): string[] {
    if (slugs.length === 0) return [];
    const q = slugs.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT DISTINCT rule FROM permission_profiles WHERE status = 'confirmed' AND slug IN (${q}) ORDER BY rule`).all(...slugs) as { rule: string }[];
    return rows.map((r) => r.rule);
  }

  set(r: { slug: string; rule: string; status: ProfileStatus; source: ProfileSource; runs?: number; sessions?: number; at: number }): void {
    this.db
      .prepare(
        `INSERT INTO permission_profiles (slug, rule, status, source, runs, sessions, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug, rule) DO UPDATE SET status = excluded.status, source = excluded.source, runs = excluded.runs, sessions = excluded.sessions, decided_at = excluded.decided_at`,
      )
      .run(r.slug, r.rule, r.status, r.source, r.runs ?? 0, r.sessions ?? 0, r.at);
  }

  remove(slug: string, rule: string): boolean {
    return Number(this.db.prepare(`DELETE FROM permission_profiles WHERE slug = ? AND rule = ?`).run(slug, rule).changes) > 0;
  }

  /** 最早确认的时间（Effect 页前后对比的起点之一）。 */
  firstConfirmedAt(): number | null {
    const r = this.db.prepare(`SELECT MIN(decided_at) AS t FROM permission_profiles WHERE status = 'confirmed'`).get() as { t: number | null };
    return r.t ?? null;
  }
}

interface Row {
  slug: string;
  rule: string;
  status: ProfileStatus;
  source: ProfileSource;
  runs: number;
  sessions: number;
  decided_at: number;
}

const toRule = (r: Row): ProfileRule => ({ slug: r.slug, rule: r.rule, status: r.status, source: r.source, runs: r.runs, sessions: r.sessions, decidedAt: r.decided_at });

interface ChoiceRow {
  id: number;
  source: AutoChoiceSource;
  session_id: string | null;
  ticket_key: string | null;
  text: string;
  created_at: number;
  reviewed_at: number | null;
}

const toChoice = (r: ChoiceRow): AutoChoice => ({
  id: r.id, source: r.source, sessionId: r.session_id, ticketKey: r.ticket_key, text: r.text, createdAt: r.created_at, reviewedAt: r.reviewed_at,
});

/** 自动做的选择（ws-j 设计 3）：事后复查用。正文最多 4000 字符。 */
export class AutoChoicesRepo {
  constructor(private readonly db: Db) {}

  add(c: { source: AutoChoiceSource; sessionId: string | null; ticketKey: string | null; decisionId?: number | null; defaultId?: number | null; text: string; at: number }): number {
    const r = this.db
      .prepare(`INSERT INTO auto_choices (source, session_id, ticket_key, decision_id, default_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(c.source, c.sessionId, c.ticketKey, c.decisionId ?? null, c.defaultId ?? null, c.text.slice(0, 4000), c.at);
    return Number(r.lastInsertRowid);
  }

  list(limit = 200): AutoChoice[] {
    return (this.db.prepare(`SELECT * FROM auto_choices ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit) as unknown as ChoiceRow[]).map(toChoice);
  }

  unreviewed(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM auto_choices WHERE reviewed_at IS NULL`).get() as { n: number }).n;
  }

  /** 标成看过；ids 为 null 表示全部。返回改了几条。 */
  review(ids: readonly number[] | null, at: number): number {
    if (ids === null) return Number(this.db.prepare(`UPDATE auto_choices SET reviewed_at = ? WHERE reviewed_at IS NULL`).run(at).changes);
    let n = 0;
    const st = this.db.prepare(`UPDATE auto_choices SET reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL`);
    for (const id of ids) n += Number(st.run(at, id).changes);
    return n;
  }
}

interface DefaultRow {
  id: number;
  pattern: string;
  answer: string;
  enabled: number;
  created_at: number;
}

const toDefault = (r: DefaultRow): ChoiceDefault => ({ id: r.id, pattern: r.pattern, answer: r.answer, enabled: r.enabled === 1, createdAt: r.created_at });

/** 默认答案（ws-j 设计 3）。 */
export class ChoiceDefaultsRepo {
  constructor(private readonly db: Db) {}

  list(): ChoiceDefault[] {
    return (this.db.prepare(`SELECT * FROM choice_defaults ORDER BY id`).all() as unknown as DefaultRow[]).map(toDefault);
  }

  /** id 为 null 新建；返回 id。 */
  save(d: { id: number | null; pattern: string; answer: string; enabled: boolean; at: number }): number {
    if (d.id !== null) {
      this.db.prepare(`UPDATE choice_defaults SET pattern = ?, answer = ?, enabled = ? WHERE id = ?`).run(d.pattern, d.answer, d.enabled ? 1 : 0, d.id);
      return d.id;
    }
    return Number(this.db.prepare(`INSERT INTO choice_defaults (pattern, answer, enabled, created_at) VALUES (?, ?, ?, ?)`).run(d.pattern, d.answer, d.enabled ? 1 : 0, d.at).lastInsertRowid);
  }

  delete(id: number): boolean {
    return Number(this.db.prepare(`DELETE FROM choice_defaults WHERE id = ?`).run(id).changes) > 0;
  }
}

interface LogRow {
  id: number;
  ts: number;
  event: NotifyEvent;
  count: number;
  status: NotifyStatus;
  host: string | null;
  payload: string | null;
  error: string | null;
}

/** 外部通知的记录（ws-j 设计 7）：每次决定发、不发都记。 */
export class NotificationLogRepo {
  constructor(private readonly db: Db) {}

  insert(e: Omit<NotificationLogEntry, "id">): number {
    return Number(
      this.db
        .prepare(`INSERT INTO notification_log (ts, event, count, status, host, payload, error) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(e.ts, e.event, e.count, e.status, e.host, e.payload?.slice(0, 2000) ?? null, e.error?.slice(0, 500) ?? null).lastInsertRowid,
    );
  }

  recent(limit = 100): NotificationLogEntry[] {
    return this.db.prepare(`SELECT * FROM notification_log ORDER BY ts DESC, id DESC LIMIT ?`).all(limit) as unknown as LogRow[];
  }

  prune(before: number): number {
    return Number(this.db.prepare(`DELETE FROM notification_log WHERE ts < ?`).run(before).changes);
  }
}
