// 工作流 F 的表：回测素材（backtest_prs / backtest_comments / backtest_files）、回测结果（check_backtests）、
// 绕过记录（check_bypasses）、检查的综合分（check_scores）、降级 / 待复审（check_lifecycle）、自动升降级的事件、阈值复查。
import { withTransaction, type Db } from "./database";
import type {
  BacktestCaught, BacktestResult, BacktestSample, BacktestSkipReason, BacktestStatus, BypassHow, CheckLifecycleReason, CheckLifecycleView, LifecycleReasonData,
  ThresholdReviewView,
} from "../../shared/backtest";
import type { CommentAnchor, FileAt } from "../backtest/gh-backtest";
import type { CheckLogRecord } from "../../shared/checks";

const json = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== "string") return fallback;
  try {
    return (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** 一个 PR 最多重试几次拿 diff / 评论。 */
export const MAX_FETCH_ATTEMPTS = 3;
/** 每个（定义, 仓库）留几次结果。 */
const KEEP_RESULTS = 5;

export interface NewBacktestResult {
  defHash: string;
  sourcesHash: string;
  materialKey: string;
  lessonId: number | null;
  checkKey: string | null;
  slug: string;
  status: BacktestStatus;
  skipReason: BacktestSkipReason | null;
  prs: number;
  hits: number;
  matchedHits: number;
  judged: number;
  judgedFp: number;
  falsePositives: number;
  fpRate: number | null;
  comments: number;
  commentsMatched: number;
  recall: number | null;
  samples: { falsePositives: BacktestSample[]; caught: BacktestCaught[] };
  at: number;
}

interface ResultRow {
  id: number; def_hash: string; sources_hash: string; material_key: string; lesson_id: number | null; check_key: string | null; repo_slug: string; status: string;
  skip_reason: string | null; prs: number; hits: number; matched_hits: number; judged: number; judged_fp: number; false_positives: number; fp_rate: number | null;
  comments: number; comments_matched: number; recall: number | null; legacy: number | null; legacy_scan_id: number | null; samples: string; created_at: number;
}

export interface StoredResult extends BacktestResult {
  sourcesHash: string;
  materialKey: string;
}

function toResult(r: ResultRow): StoredResult {
  const s = json<{ falsePositives?: BacktestSample[]; caught?: BacktestCaught[] }>(r.samples, {});
  return {
    id: Number(r.id), defHash: r.def_hash, sourcesHash: r.sources_hash, materialKey: r.material_key, slug: r.repo_slug, lessonId: numOrNull(r.lesson_id), checkKey: r.check_key,
    status: r.status as BacktestStatus, skipReason: (r.skip_reason ?? null) as BacktestSkipReason | null, prs: Number(r.prs), hits: Number(r.hits),
    matchedHits: Number(r.matched_hits), judged: Number(r.judged), judgedFp: Number(r.judged_fp), falsePositives: Number(r.false_positives), fpRate: numOrNull(r.fp_rate),
    comments: Number(r.comments), commentsMatched: Number(r.comments_matched), recall: numOrNull(r.recall), legacy: numOrNull(r.legacy), legacyScanId: numOrNull(r.legacy_scan_id),
    samples: { falsePositives: s.falsePositives ?? [], caught: s.caught ?? [] }, createdAt: Number(r.created_at),
  };
}

export interface BypassRecord {
  checkId: number | null;
  checkKey: string;
  slug: string | null;
  file: string;
  line: number | null;
  how: BypassHow;
  detail: string;
  sessionId: string | null;
  at: number;
  ingestKey: string;
}

export interface LifecycleEvent {
  id: number;
  kind: "promote" | "demote" | "flag";
  batchId: number | null;
  checks: { id: number; name: string; reason?: CheckLifecycleReason | null }[];
  at: number;
  dismissedAt: number | null;
  undoneAt: number | null;
}

export interface RepoMaterialState {
  status: "ok" | "no_gh" | "failed";
  attempts: number;
  /** 最近一次拿到的窗口（最近合并的 PR 号）。 */
  window: number[];
  fetchedAt: number;
  error: string | null;
}

export class BacktestRepo {
  constructor(private readonly db: Db) {}

  /** 已经在事务里时用 SAVEPOINT（BTL-267：手写的 BEGIN 嵌套会抛错）。 */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  // ------------------------------------------------------------ 素材

  /** 这个仓库上次拿素材的结果；没拿过为 null。 */
  repoState(slug: string): RepoMaterialState | null {
    const r = this.db.prepare(`SELECT status, attempts, window, fetched_at, error FROM backtest_repos WHERE repo_slug = ?`).get(slug) as
      | { status: string; attempts: number; window: string; fetched_at: number; error: string | null }
      | undefined;
    return r ? { status: r.status as RepoMaterialState["status"], attempts: Number(r.attempts), window: json<number[]>(r.window, []), fetchedAt: Number(r.fetched_at), error: r.error } : null;
  }

  /** ok：清零重试次数、记下窗口；no_gh / failed：次数加一。 */
  /** attempts 给了就直接设成它（gh 没装：一次就当放弃）。 */
  setRepoState(slug: string, status: RepoMaterialState["status"], window: readonly number[] | null, now: number, error: string | null = null, attempts?: number): void {
    const fixed = attempts ?? null;
    this.db
      .prepare(`INSERT INTO backtest_repos (repo_slug, status, attempts, window, fetched_at, error) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (repo_slug) DO UPDATE SET status = excluded.status, fetched_at = excluded.fetched_at, error = excluded.error,
                  attempts = CASE WHEN excluded.status = 'ok' THEN 0 WHEN ${fixed === null ? "0" : "1"} THEN excluded.attempts ELSE backtest_repos.attempts + 1 END,
                  window = CASE WHEN excluded.status = 'ok' THEN excluded.window ELSE backtest_repos.window END`)
      .run(slug, status, status === "ok" ? 0 : (fixed ?? 1), JSON.stringify(window ?? []), now, error);
  }

  /** 最近合并的 PR（窗口里的）：没有的行加上，等着拿 diff。 */
  upsertPrs(slug: string, prs: { number: number; mergedAt: number | null }[]): void {
    const ins = this.db.prepare(
      `INSERT INTO backtest_prs (repo_slug, pr_number, merged_at, status) VALUES (?, ?, ?, 'pending')
       ON CONFLICT (repo_slug, pr_number) DO UPDATE SET merged_at = COALESCE(excluded.merged_at, backtest_prs.merged_at)`,
    );
    for (const p of prs) ins.run(slug, p.number, p.mergedAt);
  }

  /** 只要评论的 PR（规矩出处所在、可能不在窗口里）：没有就加一行（不拿 diff）。 */
  ensurePr(slug: string, n: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO backtest_prs (repo_slug, pr_number, status) VALUES (?, ?, 'pending')`).run(slug, n);
  }

  /** 窗口里还要拿 diff 的。 */
  diffsToFetch(slug: string, window: readonly number[]): number[] {
    if (!window.length) return [];
    const rows = this.db
      .prepare(`SELECT pr_number FROM backtest_prs WHERE repo_slug = ? AND pr_number IN (${window.map(() => "?").join(",")}) AND (status = 'pending' OR (status = 'failed' AND attempts < ?)) ORDER BY pr_number`)
      .all(slug, ...window, MAX_FETCH_ATTEMPTS) as { pr_number: number }[];
    return rows.map((r) => Number(r.pr_number));
  }

  setDiff(slug: string, n: number, diff: string | null, now: number): void {
    this.db
      .prepare(`UPDATE backtest_prs SET status = ?, diff = ?, fetched_at = ?, attempts = attempts + ? WHERE repo_slug = ? AND pr_number = ?`)
      .run(diff === null ? "failed" : "ok", diff, now, diff === null ? 1 : 0, slug, n);
  }

  /** 掉出窗口的：diff 清掉（评论留着，召回还要用）。 */
  dropOutside(slug: string, window: readonly number[]): void {
    const keep = window.length ? `AND pr_number NOT IN (${window.map(() => "?").join(",")})` : "";
    this.db.prepare(`UPDATE backtest_prs SET diff = NULL, status = 'pending' WHERE repo_slug = ? AND diff IS NOT NULL ${keep}`).run(slug, ...window);
  }

  /** 窗口里有 diff 的 PR，新的在前。 */
  diffs(slug: string, window: readonly number[]): { number: number; diff: string }[] {
    if (!window.length) return [];
    const rows = this.db
      .prepare(`SELECT pr_number, diff FROM backtest_prs WHERE repo_slug = ? AND status = 'ok' AND diff IS NOT NULL AND pr_number IN (${window.map(() => "?").join(",")}) ORDER BY COALESCE(merged_at, 0) DESC, pr_number DESC`)
      .all(slug, ...window) as { pr_number: number; diff: string }[];
    return rows.map((r) => ({ number: Number(r.pr_number), diff: r.diff }));
  }

  /** 还没拿评论的 PR（失败的最多试 MAX_FETCH_ATTEMPTS 次，次数记在 attempts 里和 diff 共用）。 */
  commentsToFetch(slug: string, prs: readonly number[]): number[] {
    if (!prs.length) return [];
    const rows = this.db
      .prepare(`SELECT pr_number FROM backtest_prs WHERE repo_slug = ? AND pr_number IN (${prs.map(() => "?").join(",")}) AND comments_at IS NULL AND attempts < ? ORDER BY pr_number`)
      .all(slug, ...prs, MAX_FETCH_ATTEMPTS) as { pr_number: number }[];
    return rows.map((r) => Number(r.pr_number));
  }

  setComments(slug: string, n: number, anchors: CommentAnchor[] | null, now: number): void {
    this.transaction(() => {
      if (anchors === null) {
        this.db.prepare(`UPDATE backtest_prs SET attempts = attempts + 1 WHERE repo_slug = ? AND pr_number = ?`).run(slug, n);
        return;
      }
      this.db.prepare(`DELETE FROM backtest_comments WHERE repo_slug = ? AND pr_number = ?`).run(slug, n);
      const ins = this.db.prepare(
        `INSERT INTO backtest_comments (repo_slug, pr_number, comment_id, author, path, line, original_line, original_commit, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of anchors) ins.run(slug, n, a.id, a.author, a.path, a.line, a.originalLine, a.originalCommit, now);
      this.db.prepare(`UPDATE backtest_prs SET comments_at = ? WHERE repo_slug = ? AND pr_number = ?`).run(now, slug, n);
    });
  }

  /** 拿过评论的 PR。 */
  commentsFetched(slug: string, prs: readonly number[]): Set<number> {
    if (!prs.length) return new Set();
    const rows = this.db
      .prepare(`SELECT pr_number FROM backtest_prs WHERE repo_slug = ? AND pr_number IN (${prs.map(() => "?").join(",")}) AND comments_at IS NOT NULL`)
      .all(slug, ...prs) as { pr_number: number }[];
    return new Set(rows.map((r) => Number(r.pr_number)));
  }

  /** 拿评论用完了重试次数的 PR（这些 PR 上的出处算拿不到素材）。 */
  commentsGaveUp(slug: string, prs: readonly number[]): Set<number> {
    if (!prs.length) return new Set();
    const rows = this.db
      .prepare(`SELECT pr_number FROM backtest_prs WHERE repo_slug = ? AND pr_number IN (${prs.map(() => "?").join(",")}) AND comments_at IS NULL AND attempts >= ?`)
      .all(slug, ...prs, MAX_FETCH_ATTEMPTS) as { pr_number: number }[];
    return new Set(rows.map((r) => Number(r.pr_number)));
  }

  comments(slug: string, prs: readonly number[]): Map<number, CommentAnchor[]> {
    const out = new Map<number, CommentAnchor[]>();
    if (!prs.length) return out;
    const rows = this.db
      .prepare(`SELECT pr_number, comment_id, author, path, line, original_line, original_commit FROM backtest_comments WHERE repo_slug = ? AND pr_number IN (${prs.map(() => "?").join(",")})`)
      .all(slug, ...prs) as { pr_number: number; comment_id: number; author: string | null; path: string | null; line: number | null; original_line: number | null; original_commit: string | null }[];
    for (const r of rows) {
      const list = out.get(Number(r.pr_number)) ?? [];
      list.push({ id: Number(r.comment_id), author: r.author ?? "", path: r.path, line: numOrNull(r.line), originalLine: numOrNull(r.original_line), originalCommit: r.original_commit });
      out.set(Number(r.pr_number), list);
    }
    return out;
  }

  file(slug: string, sha: string, path: string): FileAt | null {
    const r = this.db.prepare(`SELECT status, content FROM backtest_files WHERE repo_slug = ? AND sha = ? AND path = ?`).get(slug, sha, path) as { status: string; content: string | null } | undefined;
    return r ? { status: r.status as FileAt["status"], content: r.content } : null;
  }

  putFile(slug: string, sha: string, path: string, f: FileAt, now: number): void {
    this.db
      .prepare(`INSERT INTO backtest_files (repo_slug, sha, path, status, content, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (repo_slug, sha, path) DO UPDATE SET status = excluded.status, content = excluded.content, fetched_at = excluded.fetched_at`)
      .run(slug, sha, path, f.status, f.content, now);
  }

  /** 素材的指纹：窗口、有 diff 的 PR 和最近一次拿取的时间。变了，回测结果就要重算。 */
  materialKey(slug: string): string {
    const st = this.repoState(slug);
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(pr_number), 0) AS top, COALESCE(MAX(fetched_at), 0) AS f, COALESCE(MAX(comments_at), 0) AS c FROM backtest_prs WHERE repo_slug = ? AND status = 'ok'`)
      .get(slug) as { n: number; top: number; f: number; c: number };
    return `${(st?.window ?? []).join(",")}|${r.n}:${r.top}:${r.f}:${r.c}`;
  }

  // ------------------------------------------------------------ 结果

  insertResult(r: NewBacktestResult): number {
    const res = this.db
      .prepare(
        `INSERT INTO check_backtests (def_hash, sources_hash, material_key, lesson_id, check_key, repo_slug, status, skip_reason, prs, hits, matched_hits, judged, judged_fp,
           false_positives, fp_rate, comments, comments_matched, recall, samples, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.defHash, r.sourcesHash, r.materialKey, r.lessonId, r.checkKey, r.slug, r.status, r.skipReason, r.prs, r.hits, r.matchedHits, r.judged, r.judgedFp,
        r.falsePositives, r.fpRate, r.comments, r.commentsMatched, r.recall, JSON.stringify(r.samples), r.at);
    const id = Number(res.lastInsertRowid);
    const old = this.db
      .prepare(`SELECT id FROM check_backtests WHERE def_hash = ? AND repo_slug = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`)
      .all(r.defHash, r.slug, KEEP_RESULTS) as { id: number }[];
    for (const o of old) this.db.prepare(`DELETE FROM check_backtests WHERE id = ?`).run(o.id);
    return id;
  }

  result(id: number): StoredResult | null {
    const r = this.db.prepare(`SELECT * FROM check_backtests WHERE id = ?`).get(id) as ResultRow | undefined;
    return r ? toResult(r) : null;
  }

  /** 这个定义在这个仓库上最新的结果。 */
  latest(defHash: string, slug: string): StoredResult | null {
    const r = this.db.prepare(`SELECT * FROM check_backtests WHERE def_hash = ? AND repo_slug = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(defHash, slug) as ResultRow | undefined;
    return r ? toResult(r) : null;
  }

  /** 这个定义有过结果的仓库，各取最新的一条。 */
  latestAll(defHash: string): StoredResult[] {
    const rows = this.db
      .prepare(`SELECT * FROM check_backtests b WHERE def_hash = ? AND id = (SELECT id FROM check_backtests x WHERE x.def_hash = b.def_hash AND x.repo_slug = b.repo_slug ORDER BY created_at DESC, id DESC LIMIT 1)`)
      .all(defHash) as unknown as ResultRow[];
    return rows.map(toResult);
  }

  /** 草稿存成检查以后：把结果挂到检查的 key 上。 */
  linkCheck(defHash: string, checkKey: string): void {
    this.db.prepare(`UPDATE check_backtests SET check_key = ? WHERE def_hash = ? AND check_key IS NULL`).run(checkKey, defHash);
  }

  setLegacy(id: number, count: number | null, scanId: number | null): void {
    this.db.prepare(`UPDATE check_backtests SET legacy = ?, legacy_scan_id = ? WHERE id = ?`).run(count, scanId, id);
  }

  // ------------------------------------------------------------ 绕过

  insertBypasses(rs: readonly BypassRecord[]): number {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO check_bypasses (check_id, check_key, repo_slug, file, line, how, detail, session_id, at, ingest_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    for (const r of rs) n += Number(ins.run(r.checkId, r.checkKey, r.slug, r.file, r.line, r.how, r.detail.slice(0, 300), r.sessionId, r.at, r.ingestKey).changes);
    return n;
  }

  /** hook 写的绕过记录（HitIngest）：检查已经删了就 check_id 记空，按 key 还数得到。 */
  insertBypassLogs(rows: readonly { key: string; rec: Extract<CheckLogRecord, { kind: "bypass" }> }[]): number {
    const known = this.db.prepare(`SELECT 1 FROM checks WHERE id = ?`);
    return this.insertBypasses(
      rows.map(({ key, rec }) => ({
        checkId: known.get(rec.checkId) ? rec.checkId : null, checkKey: rec.checkKey, slug: rec.slug || null, file: rec.file, line: rec.line, how: rec.how,
        detail: rec.detail, sessionId: rec.session, at: rec.at, ingestKey: key,
      })),
    );
  }

  bypasses(checkId: number, since: number): { total: number; how: Partial<Record<BypassHow, number>> } {
    const rows = this.db.prepare(`SELECT how, COUNT(*) AS n FROM check_bypasses WHERE check_id = ? AND at >= ? GROUP BY how`).all(checkId, since) as { how: BypassHow; n: number }[];
    const how: Partial<Record<BypassHow, number>> = {};
    let total = 0;
    for (const r of rows) {
      how[r.how] = Number(r.n);
      total += Number(r.n);
    }
    return { total, how };
  }

  bypassTotals(): Map<number, number> {
    const rows = this.db.prepare(`SELECT check_id, COUNT(*) AS n FROM check_bypasses WHERE check_id IS NOT NULL GROUP BY check_id`).all() as { check_id: number; n: number }[];
    return new Map(rows.map((r) => [Number(r.check_id), Number(r.n)]));
  }

  // ------------------------------------------------------------ 分数

  setScore(checkId: number, score: number | null, parts: Record<string, number>, at: number, policyVersion: number | null): void {
    this.db
      .prepare(`INSERT INTO check_scores (check_id, score, score_parts, scored_at, policy_version) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (check_id) DO UPDATE SET score = excluded.score, score_parts = excluded.score_parts, scored_at = excluded.scored_at, policy_version = excluded.policy_version`)
      .run(checkId, score, JSON.stringify(parts), at, policyVersion);
  }

  score(checkId: number): { score: number | null; parts: Record<string, number>; scoredAt: number } | null {
    const r = this.db.prepare(`SELECT score, score_parts, scored_at FROM check_scores WHERE check_id = ?`).get(checkId) as { score: number | null; score_parts: string; scored_at: number } | undefined;
    return r ? { score: numOrNull(r.score), parts: json(r.score_parts, {}), scoredAt: Number(r.scored_at) } : null;
  }

  // ------------------------------------------------------------ 降级 / 待复审

  lifecycle(checkId: number): CheckLifecycleView | null {
    const r = this.db.prepare(`SELECT * FROM check_lifecycle WHERE check_id = ?`).get(checkId) as
      | { needs_review: number; reason: string | null; reason_data: string; last_action: string | null; last_batch_id: number | null; updated_at: number }
      | undefined;
    if (!r) return null;
    return {
      needsReview: Number(r.needs_review) === 1, reason: (r.reason ?? null) as CheckLifecycleReason | null, data: json<LifecycleReasonData>(r.reason_data, { kind: "none" }),
      lastAction: (r.last_action ?? null) as CheckLifecycleView["lastAction"], lastBatchId: numOrNull(r.last_batch_id), at: Number(r.updated_at),
    };
  }

  setLifecycle(checkId: number, v: { needsReview: boolean; reason: CheckLifecycleReason | null; data: LifecycleReasonData; lastAction: CheckLifecycleView["lastAction"]; lastBatchId: number | null }, now: number): void {
    this.db
      .prepare(`INSERT INTO check_lifecycle (check_id, needs_review, reason, reason_data, last_action, last_batch_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (check_id) DO UPDATE SET needs_review = excluded.needs_review, reason = excluded.reason, reason_data = excluded.reason_data,
                  last_action = excluded.last_action, last_batch_id = excluded.last_batch_id, updated_at = excluded.updated_at`)
      .run(checkId, v.needsReview ? 1 : 0, v.reason, JSON.stringify(v.data), v.lastAction, v.lastBatchId, now);
  }

  clearLifecycle(checkId: number): void {
    this.db.prepare(`DELETE FROM check_lifecycle WHERE check_id = ?`).run(checkId);
  }

  // ------------------------------------------------------------ 事件（Now 上的通知）

  addEvent(kind: LifecycleEvent["kind"], batchId: number | null, checks: LifecycleEvent["checks"], at: number): number {
    return Number(this.db.prepare(`INSERT INTO check_lifecycle_events (kind, batch_id, checks, at) VALUES (?, ?, ?, ?)`).run(kind, batchId, JSON.stringify(checks), at).lastInsertRowid);
  }

  /** 还要显示的：没关掉、没撤回，最近 since 以后的。 */
  openEvents(since: number): LifecycleEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM check_lifecycle_events WHERE dismissed_at IS NULL AND undone_at IS NULL AND at >= ? ORDER BY at DESC, id DESC LIMIT 20`)
      .all(since) as { id: number; kind: string; batch_id: number | null; checks: string; at: number; dismissed_at: number | null; undone_at: number | null }[];
    return rows.map((r) => ({
      id: Number(r.id), kind: r.kind as LifecycleEvent["kind"], batchId: numOrNull(r.batch_id), checks: json(r.checks, []), at: Number(r.at),
      dismissedAt: numOrNull(r.dismissed_at), undoneAt: numOrNull(r.undone_at),
    }));
  }

  dismissEvent(id: number, now: number): boolean {
    return Number(this.db.prepare(`UPDATE check_lifecycle_events SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`).run(now, id).changes) > 0;
  }

  markUndone(batchId: number, now: number): void {
    this.db.prepare(`UPDATE check_lifecycle_events SET undone_at = ? WHERE batch_id = ? AND undone_at IS NULL`).run(now, batchId);
  }

  eventCounts(): { promote: number; promoteUndone: number; demote: number; demoteUndone: number } {
    const rows = this.db.prepare(`SELECT kind, COUNT(*) AS n, SUM(CASE WHEN undone_at IS NOT NULL THEN 1 ELSE 0 END) AS u FROM check_lifecycle_events WHERE batch_id IS NOT NULL GROUP BY kind`).all() as
      { kind: string; n: number; u: number }[];
    const get = (k: string) => rows.find((r) => r.kind === k);
    return { promote: Number(get("promote")?.n ?? 0), promoteUndone: Number(get("promote")?.u ?? 0), demote: Number(get("demote")?.n ?? 0), demoteUndone: Number(get("demote")?.u ?? 0) };
  }

  // ------------------------------------------------------------ 阈值复查

  addReview(r: { key: string; current: number; suggested: number; basis: ThresholdReviewView["basis"]; at: number }): number {
    // 同一个键还开着的建议换成新的。
    this.db.prepare(`UPDATE threshold_reviews SET status = 'dismissed', decided_at = ? WHERE key = ? AND status = 'open'`).run(r.at, r.key);
    return Number(this.db.prepare(`INSERT INTO threshold_reviews (at, key, current, suggested, basis, status) VALUES (?, ?, ?, ?, ?, 'open')`).run(r.at, r.key, r.current, r.suggested, JSON.stringify(r.basis)).lastInsertRowid);
  }

  reviews(limit = 20): ThresholdReviewView[] {
    const rows = this.db.prepare(`SELECT * FROM threshold_reviews ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, at DESC, id DESC LIMIT ?`).all(limit) as
      { id: number; at: number; key: string; current: number; suggested: number; basis: string; status: string }[];
    return rows.map((r) => ({
      id: Number(r.id), at: Number(r.at), key: r.key, current: Number(r.current), suggested: Number(r.suggested),
      basis: json(r.basis, { samples: 0, agreeNow: 0, agreeSuggested: 0, note: "" }), status: r.status as ThresholdReviewView["status"],
    }));
  }

  review(id: number): ThresholdReviewView | null {
    return this.reviews(1000).find((r) => r.id === id) ?? null;
  }

  decideReview(id: number, status: "applied" | "dismissed", batchId: number | null, now: number): boolean {
    return Number(this.db.prepare(`UPDATE threshold_reviews SET status = ?, batch_id = ?, decided_at = ? WHERE id = ? AND status = 'open'`).run(status, batchId, now, id).changes) > 0;
  }

  lastReviewAt(): number | null {
    const r = this.db.prepare(`SELECT MAX(at) AS at FROM threshold_reviews`).get() as { at: number | null };
    return numOrNull(r.at);
  }
}
