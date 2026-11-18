import type {
  Lesson, LessonAdmission, LessonCheckability, LessonOrigin, LessonProductView, LessonScope, LessonScoreParts, LessonSource, LessonStatus, LessonStrength,
} from "../../shared/lessons";
import { withTransaction, type Db } from "./database";
import { capHead, RUN_CAPS } from "./lesson-runs-repo";

export interface LessonRepoRow {
  slug: string;
  localPath: string;
  mergedCursor: string | null;
  backfilledAt: number | null;
  lastAnalyzedAt: number | null;
  analyzedCount: number;
}
export interface QueueItem { id: number; slug: string; prNumber: number; origin: LessonOrigin; attempts: number }
export interface LessonQueueRow {
  id: number;
  prNumber: number;
  origin: QueueItem["origin"];
  status: "queued" | "running" | "done" | "skipped" | "failed";
  error: string | null;
  errorMessage: string | null;
  attempts: number;
  lastRunId: number | null;
  enqueuedAt: number;
  finishedAt: number | null;
  notBefore: number | null;
}
export interface LessonQueueCounts { queued: number; running: number; failed: number; skipped: number; cancelled: number }
/** 出处的评论细节（工作流 D）：谁留的、在哪个文件哪一行、评论原文（只在本机，不导出、不送页面）。 */
export interface SourceDetails { reviewer?: string | null; path?: string | null; line?: number | null; excerpt?: string | null }
export interface NewLessonSource extends SourceDetails { prNumber: number; url: string | null; slug: string; runId: number | null }
/** 给模型看的一条出处：带评论原文。 */
export interface SourceWithExcerpt extends LessonSource { excerpt: string | null }
/** 评论原文最多存这么长。 */
export const EXCERPT_MAX = 2000;
export interface NewLesson {
  scope: LessonScope;
  text: string;
  why: string;
  at: number;
  source: NewLessonSource;
}

interface RepoRow {
  slug: string;
  local_path: string;
  merged_cursor: string | null;
  backfilled_at: number | null;
  last_analyzed_at: number | null;
  analyzed_count: number;
}
interface LessonRow {
  id: number;
  repo_slug: string | null;
  product_id: number | null;
  text: string;
  why: string;
  status: LessonStatus;
  hits: number;
  last_seen_at: number;
  created_at: number;
  scope_globs: string;
  scope_lang: string | null;
  scope_layer: string | null;
  strength: LessonStrength | null;
  checkability: LessonCheckability | null;
  admission: LessonAdmission;
  shelved_reason: string | null;
  shelved_ref: number | null;
  batch_id: number | null;
  merged_into: number | null;
  score: number | null;
  score_parts: string | null;
  scored_at: number | null;
  score_policy_version: number | null;
  degraded: number;
  degraded_from: string | null;
  enriched_at: number | null;
  checkability_reason: string | null;
  shelved_note: string | null;
  principle_id: number | null;
  confirmed_at: number | null;
}
/** 从导出文件来的一条规矩。 */
export interface ImportedLesson {
  scope: LessonScope;
  text: string;
  why: string;
  status: LessonStatus;
  admission: LessonAdmission;
  hits: number;
  lastSeenAt: number;
  createdAt: number;
  now: number;
  scopeGlobs: string[];
  scopeLang: string | null;
  scopeLayer: string | null;
  strength: LessonStrength | null;
  checkability: LessonCheckability | null;
  sources: { prNumber: number; url: string | null; slug: string | null; at: number }[];
}
/** 流水线（D）回填或改写的字段；没给的不动。 */
export interface LessonFieldsPatch {
  scopeGlobs?: string[];
  scopeLang?: string | null;
  scopeLayer?: string | null;
  strength?: LessonStrength | null;
  checkability?: LessonCheckability | null;
  admission?: LessonAdmission;
  shelvedReason?: string | null;
  shelvedRef?: number | null;
  batchId?: number | null;
  score?: number | null;
  scoreParts?: LessonScoreParts | null;
  scoredAt?: number | null;
  scorePolicyVersion?: number | null;
  degraded?: boolean;
  degradedFrom?: string | null;
  enrichedAt?: number | null;
  checkabilityReason?: string | null;
  shelvedNote?: string | null;
  principleId?: number | null;
}
const PATCH_COLUMNS: Record<keyof LessonFieldsPatch, [string, (v: never) => string | number | null]> = {
  scopeGlobs: ["scope_globs", (v: string[]) => JSON.stringify(v)],
  scopeLang: ["scope_lang", (v: string | null) => v],
  scopeLayer: ["scope_layer", (v: string | null) => v],
  strength: ["strength", (v: string | null) => v],
  checkability: ["checkability", (v: string | null) => v],
  admission: ["admission", (v: string) => v],
  shelvedReason: ["shelved_reason", (v: string | null) => v],
  shelvedRef: ["shelved_ref", (v: number | null) => v],
  batchId: ["batch_id", (v: number | null) => v],
  score: ["score", (v: number | null) => v],
  scoreParts: ["score_parts", (v: LessonScoreParts | null) => (v === null ? null : JSON.stringify(v))],
  scoredAt: ["scored_at", (v: number | null) => v],
  scorePolicyVersion: ["score_policy_version", (v: number | null) => v],
  degraded: ["degraded", (v: boolean) => (v ? 1 : 0)],
  degradedFrom: ["degraded_from", (v: string | null) => v],
  enrichedAt: ["enriched_at", (v: number | null) => v],
  checkabilityReason: ["checkability_reason", (v: string | null) => v],
  shelvedNote: ["shelved_note", (v: string | null) => v],
  principleId: ["principle_id", (v: number | null) => v],
};
interface SourceRow {
  id: number; lesson_id: number; pr_number: number; url: string | null; at: number; repo_slug: string | null; run_id: number | null;
  reviewer: string | null; path: string | null; line: number | null; excerpt: string | null;
}

const num = (v: number | null): number | null => (v === null ? null : Number(v));

const toRepo = (r: RepoRow): LessonRepoRow => ({
  slug: r.slug, localPath: r.local_path, mergedCursor: r.merged_cursor, backfilledAt: num(r.backfilled_at),
  lastAnalyzedAt: num(r.last_analyzed_at), analyzedCount: Number(r.analyzed_count),
});
const toSource = (r: SourceRow): LessonSource => ({
  id: Number(r.id), prNumber: Number(r.pr_number), url: r.url, at: Number(r.at), slug: r.repo_slug, runId: num(r.run_id),
  reviewer: r.reviewer ?? null, path: r.path ?? null, line: num(r.line ?? null),
});
const cut = (v: string | null | undefined): string | null => (v === undefined || v === null || v === "" ? null : v.slice(0, EXCERPT_MAX));
function jsonOr<T>(raw: string | null, fallback: T, ok: (v: unknown) => boolean): T {
  if (raw === null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return ok(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
const isStringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
const toLesson = (r: LessonRow, sources: LessonSource[]): Lesson => ({
  id: Number(r.id),
  scope: r.repo_slug !== null ? { kind: "repo", slug: r.repo_slug } : { kind: "product", productId: Number(r.product_id) },
  text: r.text, why: r.why, status: r.status, hits: Number(r.hits), lastSeenAt: Number(r.last_seen_at),
  createdAt: Number(r.created_at), sources,
  scopeGlobs: jsonOr<string[]>(r.scope_globs, [], isStringArray),
  scopeLang: r.scope_lang, scopeLayer: r.scope_layer, strength: r.strength, checkability: r.checkability,
  admission: r.admission, shelvedReason: r.shelved_reason, shelvedRef: num(r.shelved_ref),
  batchId: num(r.batch_id), mergedInto: num(r.merged_into),
  score: r.score === null ? null : Number(r.score),
  scoreParts: jsonOr<LessonScoreParts | null>(r.score_parts, null, isObject),
  scoredAt: num(r.scored_at), scorePolicyVersion: num(r.score_policy_version),
  degraded: Number(r.degraded) === 1, degradedFrom: r.degraded_from,
  enrichedAt: num(r.enriched_at ?? null), checkabilityReason: r.checkability_reason ?? null, shelvedNote: r.shelved_note ?? null,
  principleId: num(r.principle_id ?? null), confirmedAt: num(r.confirmed_at ?? null),
});

/** 复盘规矩：仓库、产品、规矩、出处和待分析的 PR 队列。 */
export class LessonsRepo {
  constructor(private readonly db: Db) {}

  /** 把多次写入包在一个事务里；已经在事务中时 withTransaction 会用 SAVEPOINT，嵌套不会抛错。 */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  // ---- 仓库 ----
  upsertRepo(slug: string, localPath: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET local_path = excluded.local_path`,
      )
      .run(slug, localPath, now);
  }

  repos(): LessonRepoRow[] {
    return (this.db.prepare(`SELECT * FROM lesson_repos ORDER BY slug`).all() as unknown as RepoRow[]).map(toRepo);
  }

  repo(slug: string): LessonRepoRow | null {
    const r = this.db.prepare(`SELECT * FROM lesson_repos WHERE slug = ?`).get(slug) as unknown as RepoRow | undefined;
    return r ? toRepo(r) : null;
  }

  setBackfilled(slug: string, at: number): void {
    this.db.prepare(`UPDATE lesson_repos SET backfilled_at = ? WHERE slug = ?`).run(at, slug);
  }

  /** 只往后推：ISO 时间字符串可以直接比较。 */
  advanceCursor(slug: string, mergedAt: string): void {
    this.db
      .prepare(`UPDATE lesson_repos SET merged_cursor = ? WHERE slug = ? AND (merged_cursor IS NULL OR merged_cursor < ?)`)
      .run(mergedAt, slug, mergedAt);
  }

  // ---- 产品 ----
  createProduct(name: string, slugs: string[], now: number): number {
    return withTransaction(this.db, () => {
      const res = this.db.prepare(`INSERT INTO lesson_products (name, created_at) VALUES (?, ?)`).run(name, now);
      const id = Number(res.lastInsertRowid);
      for (const slug of slugs) this.addToProduct(id, slug);
      return id;
    });
  }

  deleteProduct(id: number): void {
    this.db.prepare(`DELETE FROM lesson_products WHERE id = ?`).run(id);
  }

  addToProduct(id: number, slug: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO lesson_product_repos (product_id, repo_slug) VALUES (?, ?)`).run(id, slug);
  }

  removeFromProduct(id: number, slug: string): void {
    this.db.prepare(`DELETE FROM lesson_product_repos WHERE product_id = ? AND repo_slug = ?`).run(id, slug);
  }

  products(): LessonProductView[] {
    const rows = this.db.prepare(`SELECT id, name FROM lesson_products ORDER BY name`).all() as unknown as { id: number; name: string }[];
    return rows.map((p) => this.productView(Number(p.id), p.name));
  }

  product(id: number): LessonProductView | null {
    const r = this.db.prepare(`SELECT id, name FROM lesson_products WHERE id = ?`).get(id) as unknown as { id: number; name: string } | undefined;
    return r ? this.productView(Number(r.id), r.name) : null;
  }

  productsOf(slug: string): LessonProductView[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name FROM lesson_products p JOIN lesson_product_repos pr ON pr.product_id = p.id
         WHERE pr.repo_slug = ? ORDER BY p.name`,
      )
      .all(slug) as unknown as { id: number; name: string }[];
    return rows.map((p) => this.productView(Number(p.id), p.name));
  }

  private productView(id: number, name: string): LessonProductView {
    const slugs = (
      this.db.prepare(`SELECT repo_slug FROM lesson_product_repos WHERE product_id = ? ORDER BY repo_slug`).all(id) as unknown as { repo_slug: string }[]
    ).map((r) => r.repo_slug);
    return { id, name, slugs };
  }

  // ---- 规矩 ----
  /** 合并过的行（merged_into 不为空）默认不列：它们只为撤销留着。 */
  lessons(filter?: { status?: LessonStatus[]; scope?: LessonScope; includeMerged?: boolean; ids?: number[] }): Lesson[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (!filter?.includeMerged) where.push(`merged_into IS NULL`);
    if (filter?.ids) {
      if (filter.ids.length === 0) return [];
      where.push(`id IN (SELECT value FROM json_each(?))`);
      args.push(JSON.stringify(filter.ids));
    }
    if (filter?.status) {
      if (filter.status.length === 0) return [];
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      args.push(...filter.status);
    }
    if (filter?.scope) {
      if (filter.scope.kind === "repo") {
        where.push(`repo_slug = ?`);
        args.push(filter.scope.slug);
      } else {
        where.push(`product_id = ?`);
        args.push(filter.scope.productId);
      }
    }
    const rows = this.db
      .prepare(`SELECT * FROM lessons ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`)
      .all(...args) as unknown as LessonRow[];
    return rows.map((r) => toLesson(r, this.sourcesOf(Number(r.id))));
  }

  pendingCount(): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM lessons WHERE status = 'pending' AND merged_into IS NULL`).get() as { n: number }).n);
  }

  /** 顺着 merged_into 找到最终留下的那条（防环：最多走 50 步）；id 不存在返回 null。 */
  resolveMerged(id: number): Lesson | null {
    let cur = this.get(id);
    for (let i = 0; cur && cur.mergedInto !== null && i < 50; i++) {
      const next = this.get(cur.mergedInto);
      if (!next) break;
      cur = next;
    }
    return cur;
  }

  /** 这一行最后一次改动的时间（准入的计划只写这一遍开始以后没被改过的）。 */
  updatedAt(id: number): number | null {
    const r = this.db.prepare(`SELECT updated_at FROM lessons WHERE id = ?`).get(id) as { updated_at: number } | undefined;
    return r ? Number(r.updated_at) : null;
  }

  /** 改准入、范围、评分等字段（只改给了的）。 */
  setFields(id: number, patch: LessonFieldsPatch, now: number): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof LessonFieldsPatch, unknown][]) {
      if (v === undefined) continue;
      const [col, enc] = PATCH_COLUMNS[k];
      sets.push(`${col} = ?`);
      args.push(enc(v as never));
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE lessons SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, now, id);
  }

  get(id: number): Lesson | null {
    const r = this.db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(id) as unknown as LessonRow | undefined;
    return r ? toLesson(r, this.sourcesOf(id)) : null;
  }

  private sourcesOf(lessonId: number): LessonSource[] {
    return (
      this.db.prepare(`SELECT * FROM lesson_sources WHERE lesson_id = ? ORDER BY at, id`).all(lessonId) as unknown as SourceRow[]
    ).map(toSource);
  }

  /** 同一出处（PR 号 + url）已有就不再加；返回是否新加了。url 为空时 UNIQUE 约束拦不住（NULL 互不相等），这里手动查。 */
  private addSource(lessonId: number, s: Omit<NewLessonSource, "slug"> & { slug: string | null } & SourceDetails, at: number): boolean {
    const dup = this.db
      .prepare(`SELECT 1 FROM lesson_sources WHERE lesson_id = ? AND pr_number = ? AND url IS ?`)
      .get(lessonId, s.prNumber, s.url);
    if (dup) return false;
    this.db.prepare(`INSERT INTO lesson_sources (lesson_id, pr_number, url, at, repo_slug, run_id, reviewer, path, line, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(lessonId, s.prNumber, s.url, at, s.slug, s.runId, s.reviewer ?? null, s.path ?? null, s.line ?? null, cut(s.excerpt));
    return true;
  }

  addLesson(l: NewLesson): number {
    return withTransaction(this.db, () => {
      const res = this.db
        .prepare(
          `INSERT INTO lessons (repo_slug, product_id, text, why, status, hits, last_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?)`,
        )
        .run(
          l.scope.kind === "repo" ? l.scope.slug : null, l.scope.kind === "product" ? l.scope.productId : null,
          l.text, l.why, l.at, l.at, l.at,
        );
      const id = Number(res.lastInsertRowid);
      this.addSource(id, l.source, l.at);
      return id;
    });
  }

  /** 导入时用：这台机器没有的仓库先建一行，本地路径留空（「这台机器上没有克隆」）；已有的不动。 */
  ensureRepo(slug: string, now: number): void {
    this.db.prepare(`INSERT INTO lesson_repos (slug, local_path, created_at) VALUES (?, '', ?) ON CONFLICT (slug) DO NOTHING`).run(slug, now);
  }

  /** 导入一条规矩：状态、准入、范围字段和出处都按给的写。 */
  importLesson(l: ImportedLesson): number {
    return withTransaction(this.db, () => {
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO lessons (repo_slug, product_id, text, why, status, hits, last_seen_at, created_at, updated_at,
               scope_globs, scope_lang, scope_layer, strength, checkability, admission)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            l.scope.kind === "repo" ? l.scope.slug : null, l.scope.kind === "product" ? l.scope.productId : null,
            l.text, l.why, l.status, Math.max(1, l.hits), l.lastSeenAt, l.createdAt, l.now,
            JSON.stringify(l.scopeGlobs), l.scopeLang, l.scopeLayer, l.strength, l.checkability, l.admission,
          ).lastInsertRowid,
      );
      for (const s of l.sources) this.addSource(id, { ...s, runId: null }, s.at);
      return id;
    });
  }

  /** 导入时选了「用导入的」：改正文以外的内容，hits 取大，出处合并。 */
  updateImported(id: number, u: { why: string; hits: number; lastSeenAt: number; sources: ImportedLesson["sources"]; status?: LessonStatus; fields: LessonFieldsPatch }, now: number): void {
    withTransaction(this.db, () => {
      this.db
        .prepare(`UPDATE lessons SET why = ?, hits = MAX(hits, ?), last_seen_at = MAX(last_seen_at, ?), updated_at = ? WHERE id = ?`)
        .run(u.why, u.hits, u.lastSeenAt, now, id);
      if (u.status) this.setStatus(id, u.status, now);
      this.setFields(id, u.fields, now);
      for (const s of u.sources) this.addSource(id, { ...s, runId: null }, s.at);
    });
  }

  /** 又出现一次：hits+1、last_seen_at、加一条出处（同一出处重复时 hits 不加）。 */
  hit(id: number, at: number, source: NewLessonSource): void {
    withTransaction(this.db, () => {
      const added = this.addSource(id, source, at);
      this.db
        .prepare(`UPDATE lessons SET hits = hits + ?, last_seen_at = MAX(last_seen_at, ?), updated_at = ? WHERE id = ?`)
        .run(added ? 1 : 0, at, at, id);
    });
  }

  /** 第一次变成已确认时记下 confirmed_at（「最常违反」按确认之后又出现的出处算）。 */
  setStatus(id: number, s: LessonStatus, now: number): void {
    this.db
      .prepare(`UPDATE lessons SET status = ?, updated_at = ?, confirmed_at = CASE WHEN ? = 'confirmed' AND confirmed_at IS NULL THEN ? ELSE confirmed_at END WHERE id = ?`)
      .run(s, now, s, now, id);
  }

  /** 换范围（产品提升：跨仓库重复的规矩挪到产品层）。 */
  setScope(id: number, scope: LessonScope, now: number): void {
    this.db
      .prepare(`UPDATE lessons SET repo_slug = ?, product_id = ?, updated_at = ? WHERE id = ?`)
      .run(scope.kind === "repo" ? scope.slug : null, scope.kind === "product" ? scope.productId : null, now, id);
  }

  /** 一条规矩的出处，带评论原文（给模型看）。 */
  sourcesWithExcerpt(lessonId: number): SourceWithExcerpt[] {
    return (this.db.prepare(`SELECT * FROM lesson_sources WHERE lesson_id = ? ORDER BY at, id`).all(lessonId) as unknown as SourceRow[]).map((r) => ({
      ...toSource(r), excerpt: r.excerpt ?? null,
    }));
  }

  /** 补一条出处的评论细节：只填空着的。返回是否改了。 */
  fillSource(sourceId: number, d: SourceDetails): boolean {
    const r = this.db
      .prepare(
        `UPDATE lesson_sources SET reviewer = COALESCE(reviewer, ?), path = COALESCE(path, ?), line = COALESCE(line, ?), excerpt = COALESCE(excerpt, ?)
         WHERE id = ? AND (reviewer IS NULL OR path IS NULL OR line IS NULL OR excerpt IS NULL)`,
      )
      .run(d.reviewer ?? null, d.path ?? null, d.line ?? null, cut(d.excerpt), sourceId);
    return Number(r.changes) > 0;
  }

  setText(id: number, text: string, now: number): void {
    this.db.prepare(`UPDATE lessons SET text = ?, updated_at = ? WHERE id = ?`).run(text, now, id);
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM lessons WHERE id = ?`).run(id);
  }

  /** 合并进这一条的那些行的 id。 */
  mergedIds(keepId: number): number[] {
    return (this.db.prepare(`SELECT id FROM lessons WHERE merged_into = ? ORDER BY id`).all(keepId) as { id: number }[]).map((r) => Number(r.id));
  }

  /** keep 收下 drop 的出处、hits 相加、last_seen_at 取大，text 换成新的；drop 不删，记 merged_into = keep（撤销用，列表里不再出现）。 */
  merge(keepId: number, dropId: number, text: string, now: number): void {
    withTransaction(this.db, () => {
      const drop = this.get(dropId);
      const keep = this.get(keepId);
      if (!drop || !keep) throw new Error(`lesson not found: ${!keep ? keepId : dropId}`);
      for (const s of this.sourcesWithExcerpt(dropId)) this.addSource(keepId, s, s.at);
      this.db
        .prepare(`UPDATE lessons SET text = ?, hits = hits + ?, last_seen_at = MAX(last_seen_at, ?), created_at = MIN(created_at, ?), updated_at = ? WHERE id = ?`)
        .run(text, drop.hits, drop.lastSeenAt, drop.createdAt, now, keepId);
      this.db.prepare(`UPDATE lessons SET merged_into = ?, updated_at = ? WHERE id = ?`).run(keepId, now, dropId);
      // 指向 drop 的合并也改指向 keep，链不会越来越长。
      this.db.prepare(`UPDATE lessons SET merged_into = ? WHERE merged_into = ?`).run(keepId, dropId);
    });
  }

  source(id: number): LessonSource | null {
    const r = this.db.prepare(`SELECT * FROM lesson_sources WHERE id = ?`).get(id) as unknown as SourceRow | undefined;
    return r ? toSource(r) : null;
  }

  // ---- 队列 ----
  /** 已有的行：failed 的改回 queued，其余不动；返回新排进去的个数。 */
  enqueue(slug: string, prs: number[], origin: QueueItem["origin"], now: number): number {
    return withTransaction(this.db, () => {
      const ins = this.db.prepare(
        `INSERT INTO lesson_queue (repo_slug, pr_number, origin, status, enqueued_at) VALUES (?, ?, ?, 'queued', ?)
         ON CONFLICT (repo_slug, pr_number) DO NOTHING`,
      );
      const retry = this.db.prepare(
        `UPDATE lesson_queue SET status = 'queued', error = NULL, error_message = NULL, finished_at = NULL, not_before = NULL
         WHERE repo_slug = ? AND pr_number = ? AND status = 'failed'`,
      );
      let added = 0;
      for (const pr of prs) {
        if (Number(ins.run(slug, pr, origin, now).changes) > 0) added++;
        else retry.run(slug, pr);
      }
      return added;
    });
  }

  /** 优先级高的先，其次最早的 queued 且 not_before 为空或 <= now，改成 running（优先级清零）。不计 attempts，真正起进程前调 markSpawned。 */
  take(now: number, origins?: readonly QueueItem["origin"][]): QueueItem | null {
    if (origins && origins.length === 0) return null;
    return withTransaction(this.db, () => {
      // origins：后台调度（工作流 L）这会儿放行的来源；不给就不限。
      const only = origins ? `AND origin IN (${origins.map(() => "?").join(",")})` : "";
      const r = this.db
        .prepare(
          `SELECT id, repo_slug, pr_number, origin, attempts FROM lesson_queue
           WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?) ${only}
           ORDER BY priority DESC, enqueued_at, id LIMIT 1`,
        )
        .get(now, ...(origins ?? [])) as unknown as { id: number; repo_slug: string; pr_number: number; origin: QueueItem["origin"]; attempts: number } | undefined;
      if (!r) return null;
      this.db.prepare(`UPDATE lesson_queue SET status = 'running', priority = 0 WHERE id = ?`).run(r.id);
      return { id: Number(r.id), slug: r.repo_slug, prNumber: Number(r.pr_number), origin: r.origin, attempts: Number(r.attempts) };
    });
  }

  /** 真的要起 claude 进程了：attempts+1。 */
  markSpawned(id: number): void {
    this.db.prepare(`UPDATE lesson_queue SET attempts = attempts + 1 WHERE id = ?`).run(id);
  }

  /** done 时更新 lesson_repos 的 last_analyzed_at 和 analyzed_count。last_run_id 只写这次给的 runId，不给就清空，不沿用上一次尝试的。 */
  finish(
    id: number,
    status: "done" | "skipped" | "failed",
    now: number,
    error?: string,
    detail?: { message?: string | null; runId?: number | null },
  ): void {
    withTransaction(this.db, () => {
      const message = detail?.message == null ? null : capHead(detail.message, RUN_CAPS.message);
      this.db
        .prepare(
          `UPDATE lesson_queue SET status = ?, error = ?, error_message = ?, last_run_id = ?,
             finished_at = ?, not_before = NULL WHERE id = ?`,
        )
        .run(status, error ?? null, message, detail?.runId ?? null, now, id);
      if (status === "done") {
        this.db
          .prepare(
            `UPDATE lesson_repos SET last_analyzed_at = ?, analyzed_count = analyzed_count + 1
             WHERE slug = (SELECT repo_slug FROM lesson_queue WHERE id = ?)`,
          )
          .run(now, id);
      }
    });
  }

  /** 这次分析是降了档跑的：等这一档恢复后再用要求的档位重跑一次。 */
  markUpgrade(id: number): void {
    this.db.prepare(`UPDATE lesson_queue SET upgrade_pending = 1 WHERE id = ?`).run(id);
  }

  upgradePendingCount(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM lesson_queue WHERE upgrade_pending = 1 AND status = 'done'`).get() as unknown as { c: number };
    return Number(r.c);
  }

  /**
   * 等着升级重跑的放回队列。降级那次新建、还没人确认（pending）、出处全来自那次运行的规矩先撤掉，免得重跑再建一条重复的；
   * 被那次命中的旧规矩不动（出处按 PR + 链接去重，重跑不会多算）。返回放回了几个。
   */
  requeueUpgrades(now: number): number {
    return withTransaction(this.db, () => {
      const rows = this.db
        .prepare(`SELECT id, last_run_id FROM lesson_queue WHERE upgrade_pending = 1 AND status = 'done'`)
        .all() as unknown as { id: number; last_run_id: number | null }[];
      const withdraw = this.db.prepare(
        `DELETE FROM lessons WHERE status = 'pending' AND id IN (SELECT lesson_id FROM lesson_sources WHERE run_id = ?)
           AND NOT EXISTS (SELECT 1 FROM lesson_sources s WHERE s.lesson_id = lessons.id AND (s.run_id IS NULL OR s.run_id <> ?))`,
      );
      const requeue = this.db.prepare(
        `UPDATE lesson_queue SET status = 'queued', upgrade_pending = 0, priority = 0, not_before = NULL, error = NULL, error_message = NULL,
           finished_at = NULL, enqueued_at = ? WHERE id = ?`,
      );
      for (const r of rows) {
        if (r.last_run_id !== null) withdraw.run(r.last_run_id, r.last_run_id);
        requeue.run(now, r.id);
      }
      return rows.length;
    });
  }

  /** 回到 queued，notBefore 之前不会被取。 */
  defer(id: number, notBefore: number, runId?: number): void {
    this.db
      .prepare(`UPDATE lesson_queue SET status = 'queued', not_before = ?, last_run_id = COALESCE(?, last_run_id) WHERE id = ?`)
      .run(notBefore, runId ?? null, id);
  }

  /** 手动重试：failed / skipped（含取消）/ queued 的行排到最前；running、done 不行。 */
  retry(id: number, now: number): "ok" | "not_found" | "bad_status" {
    const r = this.db.prepare(`SELECT status FROM lesson_queue WHERE id = ?`).get(id) as unknown as { status: string } | undefined;
    if (!r) return "not_found";
    if (r.status === "running" || r.status === "done") return "bad_status";
    this.db
      .prepare(
        `UPDATE lesson_queue SET status = 'queued', priority = 1, not_before = NULL, error = NULL, error_message = NULL,
           finished_at = NULL, enqueued_at = ? WHERE id = ?`,
      )
      .run(now, id);
    return "ok";
  }

  /** 这个仓库所有 failed 的行重试，返回个数。 */
  retryFailed(slug: string, now: number): number {
    return Number(
      this.db
        .prepare(
          `UPDATE lesson_queue SET status = 'queued', priority = 1, not_before = NULL, error = NULL, error_message = NULL,
             finished_at = NULL, enqueued_at = ? WHERE repo_slug = ? AND status = 'failed'`,
        )
        .run(now, slug).changes,
    );
  }

  /** 取消排队中的行：变成 skipped / cancelled，enqueue 不会把它救回来。 */
  cancelQueued(id: number, now: number): "ok" | "not_found" | "bad_status" {
    const r = this.db.prepare(`SELECT status FROM lesson_queue WHERE id = ?`).get(id) as unknown as { status: string } | undefined;
    if (!r) return "not_found";
    if (r.status !== "queued") return "bad_status";
    this.db.prepare(`UPDATE lesson_queue SET status = 'skipped', error = 'cancelled', finished_at = ?, not_before = NULL WHERE id = ?`).run(now, id);
    return "ok";
  }

  /** 限额恢复时：让所有排队中的行马上可取。 */
  clearNotBefore(): number {
    return Number(this.db.prepare(`UPDATE lesson_queue SET not_before = NULL WHERE status = 'queued' AND not_before IS NOT NULL`).run().changes);
  }

  queuedTotal(): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM lesson_queue WHERE status = 'queued'`).get() as { n: number }).n);
  }

  /** 按来源数排队和在跑的（后台调度的状态表用）。 */
  queueCountsByOrigin(): Partial<Record<QueueItem["origin"], { queued: number; running: number }>> {
    const rows = this.db
      .prepare(`SELECT origin, SUM(status = 'queued') AS q, SUM(status = 'running') AS r FROM lesson_queue WHERE status IN ('queued','running') GROUP BY origin`)
      .all() as unknown as { origin: QueueItem["origin"]; q: number; r: number }[];
    const out: Partial<Record<QueueItem["origin"], { queued: number; running: number }>> = {};
    for (const r of rows) out[r.origin] = { queued: Number(r.q), running: Number(r.r) };
    return out;
  }

  /** 启动时 running → queued，返回个数。 */
  resetRunning(): number {
    return Number(this.db.prepare(`UPDATE lesson_queue SET status = 'queued' WHERE status = 'running'`).run().changes);
  }

  queueCounts(slug: string): LessonQueueCounts {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(status = 'queued'), 0) AS queued, COALESCE(SUM(status = 'running'), 0) AS running,
                COALESCE(SUM(status = 'failed'), 0) AS failed,
                COALESCE(SUM(status = 'skipped' AND (error IS NULL OR error <> 'cancelled')), 0) AS skipped,
                COALESCE(SUM(status = 'skipped' AND error = 'cancelled'), 0) AS cancelled
         FROM lesson_queue WHERE repo_slug = ?`,
      )
      .get(slug) as unknown as LessonQueueCounts;
    return { queued: Number(r.queued), running: Number(r.running), failed: Number(r.failed), skipped: Number(r.skipped), cancelled: Number(r.cancelled) };
  }

  /** 这几个 PR 在队列里的状态（向导等它们分析完）；不在队列里的没有。 */
  queueStatusOf(slug: string, prs: readonly number[]): Map<number, { status: LessonQueueRow["status"]; attempts: number }> {
    const out = new Map<number, { status: LessonQueueRow["status"]; attempts: number }>();
    const want = new Set(prs);
    for (const r of this.db.prepare(`SELECT pr_number, status, attempts FROM lesson_queue WHERE repo_slug = ?`).all(slug) as { pr_number: number; status: LessonQueueRow["status"]; attempts: number }[])
      if (want.has(Number(r.pr_number))) out.set(Number(r.pr_number), { status: r.status, attempts: Number(r.attempts) });
    return out;
  }

  /** 原则的正文（会话说明用）。 */
  /** 归到哪条原则（不算对规矩的改动：不动 updated_at）。 */
  setPrinciple(id: number, principleId: number | null): void {
    this.db.prepare(`UPDATE lessons SET principle_id = ? WHERE id = ?`).run(principleId, id);
  }

  principleTexts(ids: readonly number[]): Map<number, { text: string; why: string }> {
    const out = new Map<number, { text: string; why: string }>();
    if (!ids.length) return out;
    const q = this.db.prepare(`SELECT id, text, why FROM lesson_principles WHERE id = ?`);
    for (const id of new Set(ids)) {
      const r = q.get(id) as { id: number; text: string; why: string } | undefined;
      if (r) out.set(Number(r.id), { text: r.text, why: r.why });
    }
    return out;
  }

  /**
   * 确认以后又被违反了几次（核心说明的排序）：确认之后才来的出处（review 里又被指出），加上从它做出来的检查的 fail 命中。
   */
  violationCounts(ids: readonly number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (!ids.length) return out;
    const src = this.db.prepare(`SELECT COUNT(*) AS n FROM lesson_sources s JOIN lessons l ON l.id = s.lesson_id WHERE s.lesson_id = ? AND l.confirmed_at IS NOT NULL AND s.at > l.confirmed_at`);
    const hits = this.db.prepare(`SELECT COUNT(*) AS n FROM check_hits h JOIN checks c ON c.id = h.check_id WHERE c.lesson_id = ? AND h.outcome = 'fail'`);
    for (const id of new Set(ids)) out.set(id, Number((src.get(id) as { n: number }).n) + Number((hits.get(id) as { n: number }).n));
    return out;
  }

  /** 分析一个 PR 平均要多久（向导的估算）；没有记录时为 null。 */
  averageRunMs(): number | null {
    const r = this.db.prepare(`SELECT AVG(duration_ms) AS ms FROM (SELECT duration_ms FROM lesson_runs WHERE status = 'done' AND duration_ms IS NOT NULL ORDER BY id DESC LIMIT 50)`).get() as { ms: number | null };
    return r.ms === null ? null : Math.round(Number(r.ms));
  }

  queueRows(slug: string): LessonQueueRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM lesson_queue WHERE repo_slug = ? ORDER BY COALESCE(finished_at, enqueued_at) DESC, id DESC LIMIT 500`)
      .all(slug) as unknown as {
      id: number; pr_number: number; origin: QueueItem["origin"]; status: LessonQueueRow["status"]; error: string | null;
      error_message: string | null; attempts: number; last_run_id: number | null; enqueued_at: number; finished_at: number | null; not_before: number | null;
    }[];
    return rows.map((r) => ({
      id: Number(r.id), prNumber: Number(r.pr_number), origin: r.origin, status: r.status, error: r.error, errorMessage: r.error_message,
      attempts: Number(r.attempts), lastRunId: num(r.last_run_id), enqueuedAt: Number(r.enqueued_at), finishedAt: num(r.finished_at), notBefore: num(r.not_before),
    }));
  }

  /** 这次运行用到的规矩：run 的出处是该规矩最早的出处就是新建，否则是命中已有的。 */
  runLessons(runId: number): { id: number; text: string; status: LessonStatus; kind: "created" | "hit" }[] {
    const rows = this.db
      .prepare(
        `SELECT l.id, l.text, l.status,
                (SELECT run_id FROM lesson_sources WHERE id = (SELECT MIN(id) FROM lesson_sources WHERE lesson_id = l.id)) AS first_run
         FROM lessons l WHERE l.id IN (SELECT lesson_id FROM lesson_sources WHERE run_id = ?) ORDER BY l.id`,
      )
      .all(runId) as unknown as { id: number; text: string; status: LessonStatus; first_run: number | null }[];
    return rows.map((r) => ({ id: Number(r.id), text: r.text, status: r.status, kind: r.first_run !== null && Number(r.first_run) === runId ? "created" : "hit" }));
  }
}
