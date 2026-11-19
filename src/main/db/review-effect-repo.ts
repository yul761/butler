import type { Db } from "./database";

/** review_effect_prs 的一行：一个合并了的 PR 的 review 统计（工作流 G，设计 §11）。 */
export interface ReviewEffectPr {
  prId: number;
  repoSlug: string;
  number: number;
  /** Butler 的 session 做的 PR。 */
  butler: boolean;
  openedAt: number | null;
  mergedAt: number | null;
  files: string[];
  commentsHuman: number;
  commentsCopilot: number;
  /** 复盘里 avoidable 的评论数（最新一次 done 的复盘，和 H 的 readAvoidable 同口径）。 */
  avoidable: number;
  rounds: number;
  firstReviewMs: number | null;
  submitToMergeMs: number | null;
  briefPosted: boolean;
  retroDone: boolean;
  computedAt: number;
}

export interface ReviewEffectComment {
  sourceId: number;
  lessonId: number | null;
  who: "human" | "copilot";
  path: string | null;
  lessonConfirmedBefore: boolean;
  createdAt: number;
}

type Row = Record<string, unknown>;
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toPr(r: Row): ReviewEffectPr {
  let files: string[] = [];
  try {
    files = JSON.parse(String(r.files)) as string[];
  } catch {
    // 坏的当空。
  }
  return {
    prId: Number(r.pr_id), repoSlug: String(r.repo_slug), number: Number(r.number), butler: Number(r.butler) === 1,
    openedAt: n(r.opened_at), mergedAt: n(r.merged_at), files, commentsHuman: Number(r.comments_human), commentsCopilot: Number(r.comments_copilot),
    avoidable: Number(r.avoidable), rounds: Number(r.rounds), firstReviewMs: n(r.first_review_ms), submitToMergeMs: n(r.submit_to_merge_ms),
    briefPosted: Number(r.brief_posted) === 1, retroDone: Number(r.retro_done) === 1, computedAt: Number(r.computed_at),
  };
}

function toComment(r: Row): ReviewEffectComment & { prId: number } {
  return {
    prId: Number(r.pr_id), sourceId: Number(r.source_id), lessonId: n(r.lesson_id), who: r.who as "human" | "copilot",
    path: r.path === null || r.path === undefined ? null : String(r.path), lessonConfirmedBefore: Number(r.lesson_confirmed_before) === 1,
    createdAt: Number(r.created_at),
  };
}

export class ReviewEffectRepo {
  constructor(private readonly db: Db) {}

  /** 整行重写一个 PR 的统计和它的评论（每次收集都是全量算）。 */
  save(pr: ReviewEffectPr, comments: ReviewEffectComment[]): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO review_effect_prs (pr_id, repo_slug, number, butler, opened_at, merged_at, files, comments_human, comments_copilot, avoidable,
             rounds, first_review_ms, submit_to_merge_ms, brief_posted, retro_done, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (pr_id) DO UPDATE SET repo_slug = excluded.repo_slug, number = excluded.number, butler = excluded.butler,
             opened_at = excluded.opened_at, merged_at = excluded.merged_at, files = excluded.files, comments_human = excluded.comments_human,
             comments_copilot = excluded.comments_copilot, avoidable = excluded.avoidable, rounds = excluded.rounds,
             first_review_ms = excluded.first_review_ms, submit_to_merge_ms = excluded.submit_to_merge_ms, brief_posted = excluded.brief_posted,
             retro_done = excluded.retro_done, computed_at = excluded.computed_at`,
        )
        .run(
          pr.prId, pr.repoSlug, pr.number, pr.butler ? 1 : 0, pr.openedAt, pr.mergedAt, JSON.stringify(pr.files), pr.commentsHuman,
          pr.commentsCopilot, pr.avoidable, pr.rounds, pr.firstReviewMs, pr.submitToMergeMs, pr.briefPosted ? 1 : 0, pr.retroDone ? 1 : 0,
          pr.computedAt,
        );
      this.db.prepare(`DELETE FROM review_effect_comments WHERE pr_id = ?`).run(pr.prId);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO review_effect_comments (pr_id, source_id, lesson_id, who, path, lesson_confirmed_before, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of comments) ins.run(pr.prId, c.sourceId, c.lessonId, c.who, c.path, c.lessonConfirmedBefore ? 1 : 0, c.createdAt);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  get(prId: number): ReviewEffectPr | null {
    const r = this.db.prepare(`SELECT * FROM review_effect_prs WHERE pr_id = ?`).get(prId) as Row | undefined;
    return r ? toPr(r) : null;
  }

  /** 合并时间在 [from, to) 的 PR。 */
  mergedBetween(from: number, to: number): ReviewEffectPr[] {
    return (
      this.db.prepare(`SELECT * FROM review_effect_prs WHERE merged_at >= ? AND merged_at < ? ORDER BY merged_at`).all(from, to) as Row[]
    ).map(toPr);
  }

  commentsOf(prIds: number[]): (ReviewEffectComment & { prId: number })[] {
    if (prIds.length === 0) return [];
    const marks = prIds.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM review_effect_comments WHERE pr_id IN (${marks}) ORDER BY id`).all(...prIds) as Row[]).map(toComment);
  }

  /** 归到这些规矩的评论（F 的前后窗口用），评论时间在 [from, to)。 */
  commentsForLessons(lessonIds: number[], from: number, to: number): (ReviewEffectComment & { prId: number })[] {
    if (lessonIds.length === 0) return [];
    const marks = lessonIds.map(() => "?").join(",");
    return (
      this.db
        .prepare(`SELECT * FROM review_effect_comments WHERE lesson_id IN (${marks}) AND created_at >= ? AND created_at < ? ORDER BY id`)
        .all(...lessonIds, from, to) as Row[]
    ).map(toComment);
  }

  /** 已合并、还没收集过的 PR（启动补跑）：ticket_prs 里 merged 而 review_effect_prs 没有的。 */
  missingMerged(limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT p.id FROM ticket_prs p LEFT JOIN review_effect_prs e ON e.pr_id = p.id
           WHERE p.state = 'merged' AND e.pr_id IS NULL ORDER BY p.id DESC LIMIT ?`,
        )
        .all(limit) as { id: number }[]
    ).map((r) => r.id);
  }
}
