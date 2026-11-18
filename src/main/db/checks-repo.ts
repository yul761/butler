import type { Db } from "./database";
import type {
  CheckHitView, CheckInput, CheckLogRecord, CheckMode, CheckOutcome, CheckRow, CheckScope, CheckSeverity, CheckStage, CheckStats, CheckType, CheckVerdict,
} from "../../shared/checks";

interface Row {
  id: number; key: string; scope_kind: string; product_id: number | null; repo_slug: string | null; type: string; name: string; params: string;
  globs: string; exclude_globs: string; severity: string; mode: string; enabled: number; message: string; lesson_id: number | null;
  batch_id: number | null; created_at: number; updated_at: number;
}

interface HitRow {
  id: number; check_id: number | null; check_key: string; repo_slug: string | null; file: string; line: number | null; stage: string; mode: string;
  severity: string; outcome: string; blocked: number; detail: string; session_id: string | null; verdict: string | null; at: number;
}

const json = <T>(raw: string, fallback: T): T => {
  try {
    const v = JSON.parse(raw) as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
};
const strs = (raw: string): string[] => {
  const v = json<unknown>(raw, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

function toScope(r: Pick<Row, "scope_kind" | "product_id" | "repo_slug">): CheckScope {
  return r.scope_kind === "product" ? { kind: "product", productId: Number(r.product_id) } : r.scope_kind === "repo" ? { kind: "repo", slug: String(r.repo_slug) } : { kind: "global" };
}

function toRow(r: Row): CheckRow {
  const params = json<unknown>(r.params, {});
  return {
    id: Number(r.id), key: r.key, scope: toScope(r), type: r.type as CheckType, name: r.name,
    params: typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {},
    globs: strs(r.globs), excludeGlobs: strs(r.exclude_globs), severity: r.severity as CheckSeverity, mode: r.mode as CheckMode,
    enabled: r.enabled === 1, message: r.message, lessonId: r.lesson_id === null ? null : Number(r.lesson_id),
    batchId: r.batch_id === null ? null : Number(r.batch_id), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

function toHit(r: HitRow): CheckHitView {
  return {
    id: Number(r.id), checkId: r.check_id === null ? null : Number(r.check_id), checkKey: r.check_key, repoSlug: r.repo_slug, file: r.file,
    line: r.line === null ? null : Number(r.line), stage: r.stage as CheckStage, mode: r.mode as CheckMode, severity: r.severity as CheckSeverity,
    outcome: r.outcome as CheckOutcome, blocked: r.blocked === 1, detail: r.detail, sessionId: r.session_id, verdict: (r.verdict ?? null) as CheckVerdict | null,
    at: Number(r.at),
  };
}

export const where = (s: CheckScope): [string, (string | number)[]] =>
  s.kind === "global"
    ? [`scope_kind = 'global'`, []]
    : s.kind === "product"
      ? [`scope_kind = 'product' AND product_id = ?`, [s.productId]]
      : [`scope_kind = 'repo' AND repo_slug = ?`, [s.slug]];

export const emptyStats = (): CheckStats => ({
  fails: 0, blocked: 0, resolved: 0, timeouts: 0, unavailable: 0, errors: 0, falsePositives: 0, truePositives: 0, sessions: 0, lastHitAt: null, lastUnavailable: null,
});

/** 命中记录最多保留这么久（毫秒）。 */
export const HIT_RETENTION_MS = 365 * 24 * 3600 * 1000;

/** checks 和 check_hits 的读写（契约 4.5）。批次由调用方（ChecksService）开。 */
export class ChecksRepo {
  constructor(private readonly db: Db) {}

  all(): CheckRow[] {
    return (this.db.prepare(`SELECT * FROM checks ORDER BY id`).all() as unknown as Row[]).map(toRow);
  }

  inLayer(s: CheckScope): CheckRow[] {
    const [w, args] = where(s);
    return (this.db.prepare(`SELECT * FROM checks WHERE ${w} ORDER BY id`).all(...args) as unknown as Row[]).map(toRow);
  }

  get(id: number): CheckRow | null {
    const r = this.db.prepare(`SELECT * FROM checks WHERE id = ?`).get(id) as Row | undefined;
    return r ? toRow(r) : null;
  }

  byKey(s: CheckScope, key: string): CheckRow | null {
    const [w, args] = where(s);
    const r = this.db.prepare(`SELECT * FROM checks WHERE ${w} AND key = ?`).get(...args, key) as Row | undefined;
    return r ? toRow(r) : null;
  }

  /** 某个产品的检查（删产品前要记进批次）。 */
  idsOfProduct(productId: number): number[] {
    return (this.db.prepare(`SELECT id FROM checks WHERE scope_kind = 'product' AND product_id = ?`).all(productId) as { id: number }[]).map((r) => Number(r.id));
  }

  /** 从这条规矩生成的检查。 */
  idsOfLesson(lessonId: number): number[] {
    return (this.db.prepare(`SELECT id FROM checks WHERE lesson_id = ?`).all(lessonId) as { id: number }[]).map((r) => Number(r.id));
  }

  insert(s: CheckScope, key: string, c: CheckInput, extra: { lessonId?: number | null; now: number }): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO checks (key, scope_kind, product_id, repo_slug, type, name, params, globs, exclude_globs, severity, mode, enabled, message, lesson_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key, s.kind, s.kind === "product" ? s.productId : null, s.kind === "repo" ? s.slug : null, c.type, c.name, JSON.stringify(c.params),
          JSON.stringify(c.globs), JSON.stringify(c.excludeGlobs), c.severity, c.mode, c.enabled ? 1 : 0, c.message, extra.lessonId ?? null, extra.now, extra.now,
        ).lastInsertRowid,
    );
  }

  update(id: number, c: CheckInput, now: number): void {
    this.db
      .prepare(`UPDATE checks SET type = ?, name = ?, params = ?, globs = ?, exclude_globs = ?, severity = ?, mode = ?, enabled = ?, message = ?, updated_at = ? WHERE id = ?`)
      .run(c.type, c.name, JSON.stringify(c.params), JSON.stringify(c.globs), JSON.stringify(c.excludeGlobs), c.severity, c.mode, c.enabled ? 1 : 0, c.message, now, id);
  }

  setFields(id: number, patch: { enabled?: boolean; mode?: CheckMode; severity?: CheckSeverity }, now: number): void {
    const sets: string[] = [];
    const args: (string | number)[] = [];
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      args.push(patch.enabled ? 1 : 0);
    }
    if (patch.mode) {
      sets.push("mode = ?");
      args.push(patch.mode);
    }
    if (patch.severity) {
      sets.push("severity = ?");
      args.push(patch.severity);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE checks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, now, id);
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM checks WHERE id = ?`).run(id);
  }

  enabledCount(): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM checks WHERE enabled = 1`).get() as { n: number }).n);
  }

  // ---------------------------------------------------------------- 命中

  /** 写入命中（ingest_key 重复的忽略）；返回新写入的行数。 */
  insertHits(rows: { key: string; rec: Extract<CheckLogRecord, { kind: "hit" }> }[]): number {
    const known = this.db.prepare(`SELECT 1 FROM checks WHERE id = ?`);
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO check_hits (check_id, check_key, repo_slug, file, line, stage, mode, severity, outcome, blocked, detail, session_id, at, ingest_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    for (const { key, rec } of rows) {
      const checkId = known.get(rec.checkId) ? rec.checkId : null;
      const r = ins.run(
        checkId, rec.checkKey, rec.slug || null, rec.file, rec.line, rec.stage, rec.mode, rec.severity, rec.outcome, rec.blocked ? 1 : 0,
        rec.detail.slice(0, 2000), rec.session, rec.at, key,
      );
      n += Number(r.changes);
    }
    return n;
  }

  /** 每个 key 的原始命中数据。 */
  stats(): Map<string, CheckStats> {
    const out = new Map<string, CheckStats>();
    const rows = this.db
      .prepare(
        `SELECT check_key,
           SUM(outcome = 'fail') AS fails, SUM(outcome = 'fail' AND blocked = 1) AS blocked, SUM(outcome = 'resolved') AS resolved,
           SUM(outcome = 'timeout') AS timeouts, SUM(outcome = 'unavailable') AS unavailable, SUM(outcome = 'error') AS errors,
           SUM(verdict = 'false_positive') AS fp, SUM(verdict = 'true_positive') AS tp,
           COUNT(DISTINCT session_id) AS sessions, MAX(at) AS last
         FROM check_hits GROUP BY check_key`,
      )
      .all() as Record<string, number | string | null>[];
    for (const r of rows) {
      out.set(String(r.check_key), {
        fails: Number(r.fails ?? 0), blocked: Number(r.blocked ?? 0), resolved: Number(r.resolved ?? 0), timeouts: Number(r.timeouts ?? 0),
        unavailable: Number(r.unavailable ?? 0), errors: Number(r.errors ?? 0), falsePositives: Number(r.fp ?? 0), truePositives: Number(r.tp ?? 0),
        sessions: Number(r.sessions ?? 0), lastHitAt: r.last === null ? null : Number(r.last), lastUnavailable: null,
      });
    }
    const un = this.db
      .prepare(`SELECT check_key, at, detail FROM check_hits h WHERE outcome = 'unavailable' AND at = (SELECT MAX(at) FROM check_hits WHERE check_key = h.check_key AND outcome = 'unavailable')`)
      .all() as { check_key: string; at: number; detail: string }[];
    for (const u of un) {
      const s = out.get(u.check_key);
      if (s) s.lastUnavailable = { at: Number(u.at), detail: u.detail };
    }
    return out;
  }

  hits(q: { checkKey?: string; sessionIds?: string[]; limit?: number }): CheckHitView[] {
    const conds: string[] = [];
    const args: (string | number)[] = [];
    if (q.checkKey !== undefined) {
      conds.push("check_key = ?");
      args.push(q.checkKey);
    }
    if (q.sessionIds) {
      if (!q.sessionIds.length) return [];
      conds.push(`session_id IN (${q.sessionIds.map(() => "?").join(", ")})`);
      args.push(...q.sessionIds);
    }
    const sql = `SELECT * FROM check_hits ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, Math.min(q.limit ?? 200, 5000)) as unknown as HitRow[]).map(toHit);
  }

  setVerdict(hitId: number, verdict: CheckVerdict | null, now: number): boolean {
    return Number(this.db.prepare(`UPDATE check_hits SET verdict = ?, verdict_at = ? WHERE id = ?`).run(verdict, verdict ? now : null, hitId).changes) > 0;
  }

  pruneHits(before: number): number {
    return Number(this.db.prepare(`DELETE FROM check_hits WHERE at < ?`).run(before).changes);
  }
}
