import type { Lesson, LessonProductView, LessonScope, LessonSource, LessonStatus } from "../../shared/lessons";
import { withTransaction, type Db } from "./database";

export interface LessonRepoRow {
  slug: string;
  localPath: string;
  mergedCursor: string | null;
  backfilledAt: number | null;
  lastAnalyzedAt: number | null;
  analyzedCount: number;
}
export interface QueueItem { id: number; slug: string; prNumber: number; origin: "backfill" | "merged" | "daily" }
export interface NewLesson {
  scope: LessonScope;
  text: string;
  why: string;
  at: number;
  source: { prNumber: number; url: string | null };
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
}
interface SourceRow { id: number; lesson_id: number; pr_number: number; url: string | null; at: number }

const num = (v: number | null): number | null => (v === null ? null : Number(v));

const toRepo = (r: RepoRow): LessonRepoRow => ({
  slug: r.slug, localPath: r.local_path, mergedCursor: r.merged_cursor, backfilledAt: num(r.backfilled_at),
  lastAnalyzedAt: num(r.last_analyzed_at), analyzedCount: Number(r.analyzed_count),
});
const toSource = (r: SourceRow): LessonSource => ({ id: Number(r.id), prNumber: Number(r.pr_number), url: r.url, at: Number(r.at) });
const toLesson = (r: LessonRow, sources: LessonSource[]): Lesson => ({
  id: Number(r.id),
  scope: r.repo_slug !== null ? { kind: "repo", slug: r.repo_slug } : { kind: "product", productId: Number(r.product_id) },
  text: r.text, why: r.why, status: r.status, hits: Number(r.hits), lastSeenAt: Number(r.last_seen_at),
  createdAt: Number(r.created_at), sources,
});

/** 复盘规矩：仓库、产品、规矩、出处和待分析的 PR 队列。 */
export class LessonsRepo {
  constructor(private readonly db: Db) {}

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
  lessons(filter?: { status?: LessonStatus[]; scope?: LessonScope }): Lesson[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
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
  private addSource(lessonId: number, s: { prNumber: number; url: string | null }, at: number): boolean {
    const dup = this.db
      .prepare(`SELECT 1 FROM lesson_sources WHERE lesson_id = ? AND pr_number = ? AND url IS ?`)
      .get(lessonId, s.prNumber, s.url);
    if (dup) return false;
    this.db.prepare(`INSERT INTO lesson_sources (lesson_id, pr_number, url, at) VALUES (?, ?, ?, ?)`).run(lessonId, s.prNumber, s.url, at);
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

  /** 又出现一次：hits+1、last_seen_at、加一条出处（同一出处重复时 hits 不加）。 */
  hit(id: number, at: number, source: { prNumber: number; url: string | null }): void {
    withTransaction(this.db, () => {
      const added = this.addSource(id, source, at);
      this.db
        .prepare(`UPDATE lessons SET hits = hits + ?, last_seen_at = MAX(last_seen_at, ?), updated_at = ? WHERE id = ?`)
        .run(added ? 1 : 0, at, at, id);
    });
  }

  setStatus(id: number, s: LessonStatus, now: number): void {
    this.db.prepare(`UPDATE lessons SET status = ?, updated_at = ? WHERE id = ?`).run(s, now, id);
  }

  setText(id: number, text: string, now: number): void {
    this.db.prepare(`UPDATE lessons SET text = ?, updated_at = ? WHERE id = ?`).run(text, now, id);
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM lessons WHERE id = ?`).run(id);
  }

  /** keep 收下 drop 的出处、hits 相加、last_seen_at 取大，text 换成新的；drop 删掉。 */
  merge(keepId: number, dropId: number, text: string, now: number): void {
    withTransaction(this.db, () => {
      const drop = this.get(dropId);
      const keep = this.get(keepId);
      if (!drop || !keep) throw new Error(`lesson not found: ${!keep ? keepId : dropId}`);
      for (const s of drop.sources) this.addSource(keepId, { prNumber: s.prNumber, url: s.url }, s.at);
      this.db
        .prepare(`UPDATE lessons SET text = ?, hits = hits + ?, last_seen_at = MAX(last_seen_at, ?), updated_at = ? WHERE id = ?`)
        .run(text, drop.hits, drop.lastSeenAt, now, keepId);
      this.remove(dropId);
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
        `UPDATE lesson_queue SET status = 'queued', error = NULL, finished_at = NULL, not_before = NULL
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

  /** 最早的 queued 且 not_before 为空或 <= now，改成 running。 */
  take(now: number): QueueItem | null {
    return withTransaction(this.db, () => {
      const r = this.db
        .prepare(
          `SELECT id, repo_slug, pr_number, origin FROM lesson_queue
           WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?)
           ORDER BY enqueued_at, id LIMIT 1`,
        )
        .get(now) as unknown as { id: number; repo_slug: string; pr_number: number; origin: QueueItem["origin"] } | undefined;
      if (!r) return null;
      this.db.prepare(`UPDATE lesson_queue SET status = 'running' WHERE id = ?`).run(r.id);
      return { id: Number(r.id), slug: r.repo_slug, prNumber: Number(r.pr_number), origin: r.origin };
    });
  }

  /** done 时更新 lesson_repos 的 last_analyzed_at 和 analyzed_count。 */
  finish(id: number, status: "done" | "skipped" | "failed", now: number, error?: string): void {
    withTransaction(this.db, () => {
      this.db
        .prepare(`UPDATE lesson_queue SET status = ?, error = ?, finished_at = ?, not_before = NULL WHERE id = ?`)
        .run(status, error ?? null, now, id);
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

  /** 回到 queued，notBefore 之前不会被取。 */
  defer(id: number, notBefore: number): void {
    this.db.prepare(`UPDATE lesson_queue SET status = 'queued', not_before = ? WHERE id = ?`).run(notBefore, id);
  }

  /** 启动时 running → queued，返回个数。 */
  resetRunning(): number {
    return Number(this.db.prepare(`UPDATE lesson_queue SET status = 'queued' WHERE status = 'running'`).run().changes);
  }

  queueCounts(slug: string): { queued: number; failed: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(status = 'queued'), 0) AS queued, COALESCE(SUM(status = 'failed'), 0) AS failed
         FROM lesson_queue WHERE repo_slug = ?`,
      )
      .get(slug) as unknown as { queued: number; failed: number };
    return { queued: Number(r.queued), failed: Number(r.failed) };
  }
}
