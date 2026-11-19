// 效果统计的采集（设计 §11.1）：PR 合并后、复盘完成后，对这个 PR 全量算一遍写进 review_effect_prs / review_effect_comments。
// 启动时补一次还没算过的。只读别人的表（ticket_prs、pr_stage_events、lesson_runs、lesson_sources、lessons、pr_briefs），同步 SQL；
// 只有改动文件要跑 git / gh（第一次算时取，之后沿用）。
import type { Db } from "../db/database";
import type { ReviewEffectComment, ReviewEffectRepo } from "../db/review-effect-repo";
import { avoidableCount } from "../metrics/facts";
import { reviewerKind } from "../tickets/gh";

export const EFFECT_MAX_FILES = 1000;
export const EFFECT_BACKFILL_LIMIT = 200;
const MERGE_HOPS = 20;

export interface PrRef {
  id: number;
  slug: string;
  number: number;
  url: string;
  ticketKey: string;
  repoId: number | null;
  headBranch: string | null;
  author: string | null;
  openedAt: number | null;
  mergedAt: number | null;
}

export interface CollectorDeps {
  db: Db;
  repo: ReviewEffectRepo;
  /** 这个 PR 改了哪些文件（worktree 里 git diff，不行就 GitHub compare）；拿不到为 null。 */
  files(pr: PrRef): Promise<string[] | null>;
  now(): number;
  log(msg: string, err?: unknown): void;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** 人的 review 轮次：按时间排，中间隔着一次 push 算新的一轮。 */
export function countRounds(reviewAts: readonly number[], pushAts: readonly number[]): number {
  const rs = [...reviewAts].sort((a, b) => a - b);
  if (rs.length === 0) return 0;
  const ps = [...pushAts].sort((a, b) => a - b);
  let rounds = 1;
  for (let i = 1; i < rs.length; i++) if (ps.some((p) => p > rs[i - 1] && p < rs[i])) rounds++;
  return rounds;
}

export class ReviewEffectCollector {
  private readonly running = new Set<number>();

  constructor(private readonly d: CollectorDeps) {}

  private pr(id: number): (PrRef & { state: string; butler: boolean }) | null {
    const r = this.d.db.prepare(`SELECT * FROM ticket_prs WHERE id = ?`).get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: Number(r.id), slug: String(r.slug), number: Number(r.number), url: String(r.url), ticketKey: String(r.ticket_key),
      repoId: num(r.repo_id), headBranch: (r.head_branch as string | null) ?? null, author: (r.author as string | null) ?? null,
      openedAt: num(r.opened_at), mergedAt: num(r.merged_at), state: String(r.state), butler: Number(r.butler_made ?? 0) === 1,
    };
  }

  /** 算一个已合并的 PR；没合并、不存在的跳过。同一个 PR 同时只算一次。 */
  async collect(prId: number): Promise<void> {
    if (this.running.has(prId)) return;
    this.running.add(prId);
    try {
      const pr = this.pr(prId);
      if (!pr || pr.state !== "merged") return;
      const prev = this.d.repo.get(prId);
      let files = prev?.files ?? [];
      if (files.length === 0) {
        try {
          files = ((await this.d.files(pr)) ?? []).slice(0, EFFECT_MAX_FILES);
        } catch (e) {
          this.d.log(`review effect: files of ${pr.url} failed`, e);
          files = [];
        }
      }
      // 读完 git 以后再读一次：等的时候 PR 行可能被删了。
      const cur = this.pr(prId);
      if (!cur) return;
      const { stats, comments } = this.compute(cur);
      this.d.repo.save({ ...stats, files }, comments);
    } catch (e) {
      this.d.log(`review effect: collecting PR ${prId} failed`, e);
    } finally {
      this.running.delete(prId);
    }
  }

  /** 复盘完成后：按仓库和编号找到 PR 再算。 */
  async retroDone(slug: string, number: number): Promise<void> {
    const ids = this.d.db.prepare(`SELECT id FROM ticket_prs WHERE slug = ? AND number = ? AND state = 'merged'`).all(slug, number) as { id: number }[];
    for (const r of ids) await this.collect(Number(r.id));
  }

  /** 启动补跑：合并了还没算过的，以及复盘后来才做完的。 */
  async backfill(limit = EFFECT_BACKFILL_LIMIT): Promise<number> {
    const missing = this.d.repo.missingMerged(limit);
    const stale = (
      this.d.db
        .prepare(
          `SELECT e.pr_id AS id FROM review_effect_prs e
           WHERE e.retro_done = 0 AND EXISTS (SELECT 1 FROM lesson_runs r WHERE r.repo_slug = e.repo_slug AND r.pr_number = e.number AND r.status = 'done')
           LIMIT ?`,
        )
        .all(limit) as { id: number }[]
    ).map((r) => Number(r.id));
    const ids = [...new Set([...missing, ...stale])].slice(0, limit);
    for (const id of ids) await this.collect(id);
    return ids.length;
  }

  private compute(pr: PrRef & { butler: boolean }): { stats: Omit<Parameters<ReviewEffectRepo["save"]>[0], "files">; comments: ReviewEffectComment[] } {
    const db = this.d.db;
    const field = (path: string) => `CASE WHEN json_valid(data) THEN json_extract(data, '${path}') END`;
    const stages = db
      .prepare(
        `SELECT kind, at, ${field("$.who")} AS who, ${field("$.id")} AS rid, length(trim(COALESCE(${field("$.body")}, ''))) > 0 AS has_body
         FROM pr_stage_events WHERE pr_id = ? AND kind IN ('comment', 'review') ORDER BY at, id`,
      )
      .all(pr.id) as Row[];
    let human = 0;
    let copilot = 0;
    const seen = new Set<string>();
    const humanReviews: number[] = [];
    let firstHuman: number | null = null;
    for (const s of stages) {
      const at = Number(s.at);
      if (s.who === "human" && s.kind === "review") humanReviews.push(at);
      if (s.who === "human" && (firstHuman === null || at < firstHuman)) firstHuman = at;
      // 和 H 同口径：没有正文的 review 不算评论；同一个 review 换了状态只算一次。
      if (s.kind === "review" && Number(s.has_body) !== 1) continue;
      if (s.kind === "review" && s.rid !== null && s.rid !== undefined) {
        const k = String(s.rid);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      if (s.who === "human") human++;
      else if (s.who === "copilot") copilot++;
    }
    const pushes = (
      db
        .prepare(`SELECT at FROM pr_stage_events WHERE kind = 'push' AND (pr_id = ? OR (pr_id IS NULL AND repo_id = ? AND branch = ?))`)
        .all(pr.id, pr.repoId, pr.headBranch) as { at: number }[]
    ).map((r) => Number(r.at));

    const run = db
      .prepare(`SELECT findings_json FROM lesson_runs WHERE repo_slug = ? AND pr_number = ? AND status = 'done' ORDER BY id DESC LIMIT 1`)
      .get(pr.slug, pr.number) as { findings_json: string | null } | undefined;
    const briefPosted = db.prepare(`SELECT 1 FROM pr_briefs WHERE pr_id = ? AND posted_at IS NOT NULL LIMIT 1`).get(pr.id) !== undefined;

    const sources = db
      .prepare(
        `SELECT s.id, s.lesson_id, s.reviewer, s.path, s.at FROM lesson_sources s
         WHERE s.pr_number = ? AND COALESCE(s.repo_slug, (SELECT l.repo_slug FROM lessons l WHERE l.id = s.lesson_id)) = ? ORDER BY s.id`,
      )
      .all(pr.number, pr.slug) as Row[];
    const comments: ReviewEffectComment[] = [];
    for (const s of sources) {
      const reviewer = typeof s.reviewer === "string" ? s.reviewer : null;
      const who = reviewer ? reviewerKind(reviewer, pr.author ?? "") : "human";
      if (who !== "human" && who !== "copilot") continue;
      const final = this.finalLesson(Number(s.lesson_id));
      const confirmedAt = final === null ? null : num((db.prepare(`SELECT confirmed_at FROM lessons WHERE id = ?`).get(final) as Row | undefined)?.confirmed_at);
      comments.push({
        sourceId: Number(s.id), lessonId: final, who, path: typeof s.path === "string" ? s.path : null,
        lessonConfirmedBefore: confirmedAt !== null && pr.openedAt !== null && confirmedAt < pr.openedAt, createdAt: Number(s.at),
      });
    }
    return {
      stats: {
        prId: pr.id, repoSlug: pr.slug, number: pr.number, butler: pr.butler, openedAt: pr.openedAt, mergedAt: pr.mergedAt,
        commentsHuman: human, commentsCopilot: copilot, avoidable: run ? avoidableCount(run.findings_json) : 0,
        rounds: countRounds(humanReviews, pushes),
        firstReviewMs: firstHuman !== null && pr.openedAt !== null ? Math.max(0, firstHuman - pr.openedAt) : null,
        submitToMergeMs: pr.mergedAt !== null && pr.openedAt !== null ? Math.max(0, pr.mergedAt - pr.openedAt) : null,
        briefPosted, retroDone: run !== undefined, computedAt: this.d.now(),
      },
      comments,
    };
  }

  /** 沿 merged_into 走到最终的那条规矩；规矩没了为 null。 */
  private finalLesson(id: number): number | null {
    let cur = id;
    for (let i = 0; i < MERGE_HOPS; i++) {
      const r = this.d.db.prepare(`SELECT merged_into FROM lessons WHERE id = ?`).get(cur) as Row | undefined;
      if (!r) return i === 0 ? null : cur;
      const next = num(r.merged_into);
      if (next === null || next === cur) return cur;
      cur = next;
    }
    return cur;
  }
}
