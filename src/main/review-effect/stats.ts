// 效果统计的读取（设计 §11.2、§11.3）：给 F 的按规矩评论趋势，和「效果」页的「Review 效果」区块。同步、只读。
import type { Db } from "../db/database";
import { matchAny } from "../../shared/glob";
import type { ReviewEffectLesson, ReviewEffectView, ReviewEffectWeek, ReviewGroupStats } from "../../shared/review-effect";

export interface TrendSide {
  prs: number;
  comments: number;
  perPr: number | null;
  byWho: { human: number; copilot: number };
}

export interface LessonCommentTrend {
  lessonId: number;
  before: TrendSide;
  after: TrendSide;
}

export interface LessonCommentTrendQuery {
  lessonId?: number;
  checkId?: number;
  /** 分界时间（ms）：之前和之后各取离它最近的 window 个 PR。 */
  since: number;
  repo?: string;
  window?: number;
}

export const TREND_WINDOW = 20;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const WEEKS = 12;
const MERGE_HOPS = 20;
/** 「规矩上线前后」：看最近这么多天确认的规矩，最多这么多条，上线后至少这么多个 PR。 */
const LESSON_LOOKBACK_DAYS = 180;
const LESSON_CANDIDATES = 50;
const LESSON_SHOW = 10;
const LESSON_MIN_AFTER = 3;

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const marks = (n: number): string => Array.from({ length: n }, () => "?").join(",");

function jsonList(v: unknown): string[] {
  try {
    const x = JSON.parse(String(v ?? "[]")) as unknown;
    return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function finalLesson(db: Db, id: number): number | null {
  let cur = id;
  for (let i = 0; i < MERGE_HOPS; i++) {
    const r = db.prepare(`SELECT merged_into FROM lessons WHERE id = ?`).get(cur) as Row | undefined;
    if (!r) return i === 0 ? null : cur;
    const next = num(r.merged_into);
    if (next === null || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** 最终那条规矩和所有合并进它的（评论收集时可能还挂在旧 id 上）。 */
function lessonFamily(db: Db, final: number): number[] {
  const ids = new Set([final]);
  let frontier = [final];
  for (let i = 0; i < MERGE_HOPS && frontier.length; i++) {
    const next = (db.prepare(`SELECT id FROM lessons WHERE merged_into IN (${marks(frontier.length)})`).all(...frontier) as Row[])
      .map((r) => Number(r.id))
      .filter((id) => !ids.has(id));
    for (const id of next) ids.add(id);
    frontier = next;
  }
  return [...ids];
}

function lessonRepos(db: Db, l: Row): string[] {
  if (typeof l.repo_slug === "string") return [l.repo_slug];
  if (l.product_id === null || l.product_id === undefined) return [];
  return (db.prepare(`SELECT repo_slug FROM lesson_product_repos WHERE product_id = ? ORDER BY repo_slug`).all(Number(l.product_id)) as Row[]).map((r) => String(r.repo_slug));
}

function side(prIds: number[], byPr: Map<number, { human: number; copilot: number }>): TrendSide {
  let human = 0;
  let copilot = 0;
  for (const id of prIds) {
    const c = byPr.get(id);
    if (c) {
      human += c.human;
      copilot += c.copilot;
    }
  }
  const comments = human + copilot;
  return { prs: prIds.length, comments, perPr: prIds.length ? comments / prIds.length : null, byWho: { human, copilot } };
}

/**
 * 一条规矩（或一个检查对应的规矩）上线前后，规矩适用的 PR 上归到它的评论数。
 * PR：规矩适用的仓库里已合并、复盘做完、改动命中规矩 scopeGlobs 的；since 前后各取离它最近的 window 个。找不到规矩返回 null。
 */
export function lessonCommentTrend(db: Db, q: LessonCommentTrendQuery): LessonCommentTrend | null {
  let id = q.lessonId ?? null;
  if (id === null && q.checkId !== undefined) id = num((db.prepare(`SELECT lesson_id FROM checks WHERE id = ?`).get(q.checkId) as Row | undefined)?.lesson_id);
  if (id === null) return null;
  const final = finalLesson(db, id);
  if (final === null) return null;
  const l = db.prepare(`SELECT id, repo_slug, product_id, scope_globs FROM lessons WHERE id = ?`).get(final) as Row | undefined;
  if (!l) return null;
  let repos = lessonRepos(db, l);
  if (q.repo !== undefined) repos = repos.filter((r) => r === q.repo);
  const window = Math.max(1, Math.floor(q.window ?? TREND_WINDOW));
  const globs = jsonList(l.scope_globs);
  const prs = repos.length
    ? (
        db
          .prepare(`SELECT pr_id, merged_at, files FROM review_effect_prs WHERE repo_slug IN (${marks(repos.length)}) AND retro_done = 1 AND merged_at IS NOT NULL ORDER BY merged_at, pr_id`)
          .all(...repos) as Row[]
      ).filter((r) => globs.length === 0 || jsonList(r.files).some((f) => matchAny(f, globs)))
    : [];
  const before = prs.filter((r) => Number(r.merged_at) < q.since).slice(-window).map((r) => Number(r.pr_id));
  const after = prs.filter((r) => Number(r.merged_at) >= q.since).slice(0, window).map((r) => Number(r.pr_id));
  const all = [...before, ...after];
  const family = lessonFamily(db, final);
  const byPr = new Map<number, { human: number; copilot: number }>();
  if (all.length) {
    const rows = db
      .prepare(`SELECT pr_id, who FROM review_effect_comments WHERE lesson_id IN (${marks(family.length)}) AND pr_id IN (${marks(all.length)})`)
      .all(...family, ...all) as Row[];
    for (const r of rows) {
      const c = byPr.get(Number(r.pr_id)) ?? { human: 0, copilot: 0 };
      if (r.who === "copilot") c.copilot++;
      else c.human++;
      byPr.set(Number(r.pr_id), c);
    }
  }
  return { lessonId: final, before: side(before, byPr), after: side(after, byPr) };
}

const mean = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

interface EffRow {
  prId: number;
  shipherd: boolean;
  mergedAt: number;
  human: number;
  copilot: number;
  avoidable: number;
  rounds: number;
  firstReviewMs: number | null;
  submitToMergeMs: number | null;
  brief: boolean;
}

function group(rows: EffRow[]): ReviewGroupStats {
  return {
    prs: rows.length,
    humanComments: mean(rows.map((r) => r.human)),
    rounds: mean(rows.map((r) => r.rounds)),
    firstReviewMs: mean(rows.map((r) => r.firstReviewMs)),
    submitToMergeMs: mean(rows.map((r) => r.submitToMergeMs)),
  };
}

/** 周一 0 点（UTC）。 */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY;
}

/** 「效果」页的「Review 效果」区块：窗口是最近 days 天合并的 PR；趋势固定看最近 12 周。 */
export function reviewEffect(db: Db, days: number, now: number): ReviewEffectView {
  const from = now - Math.max(1, days) * DAY;
  const thisWeek = weekStart(now);
  const trendFrom = thisWeek - (WEEKS - 1) * WEEK;
  const rows = (
    db.prepare(`SELECT * FROM review_effect_prs WHERE merged_at IS NOT NULL AND merged_at >= ? ORDER BY merged_at`).all(Math.min(from, trendFrom)) as Row[]
  ).map(
    (r): EffRow => ({
      prId: Number(r.pr_id), shipherd: Number(r.shipherd) === 1, mergedAt: Number(r.merged_at), human: Number(r.comments_human),
      copilot: Number(r.comments_copilot), avoidable: Number(r.avoidable), rounds: Number(r.rounds), firstReviewMs: num(r.first_review_ms),
      submitToMergeMs: num(r.submit_to_merge_ms), brief: Number(r.brief_posted) === 1,
    }),
  );

  const weeks: ReviewEffectWeek[] = [];
  for (let i = 0; i < WEEKS; i++) {
    const start = trendFrom + i * WEEK;
    const inWeek = rows.filter((r) => r.shipherd && r.mergedAt >= start && r.mergedAt < start + WEEK);
    const avoidable = inWeek.reduce((a, r) => a + r.avoidable, 0);
    weeks.push({ weekStart: start, prs: inWeek.length, avoidable, perPr: inWeek.length ? avoidable / inWeek.length : null });
  }

  const win = rows.filter((r) => r.mergedAt >= from && r.mergedAt <= now);
  const shipherd = win.filter((r) => r.shipherd);

  const lessons: ReviewEffectLesson[] = [];
  const candidates = db
    .prepare(
      `SELECT id, text, confirmed_at FROM lessons WHERE status = 'confirmed' AND merged_into IS NULL AND confirmed_at IS NOT NULL AND confirmed_at >= ?
       ORDER BY confirmed_at DESC LIMIT ?`,
    )
    .all(now - LESSON_LOOKBACK_DAYS * DAY, LESSON_CANDIDATES) as Row[];
  for (const c of candidates) {
    const t = lessonCommentTrend(db, { lessonId: Number(c.id), since: Number(c.confirmed_at) });
    if (!t || t.after.prs < LESSON_MIN_AFTER) continue;
    lessons.push({
      lessonId: t.lessonId, text: String(c.text).replace(/\s+/g, " ").trim().slice(0, 200), confirmedAt: Number(c.confirmed_at),
      before: { prs: t.before.prs, perPr: t.before.perPr }, after: { prs: t.after.prs, perPr: t.after.perPr },
    });
  }
  const delta = (l: ReviewEffectLesson): number => (l.after.perPr ?? 0) - (l.before.perPr ?? 0);
  lessons.sort((a, b) => delta(a) - delta(b) || b.confirmedAt - a.confirmedAt);

  let confirmedBefore = 0;
  let notYet = 0;
  if (win.length) {
    const ids = win.map((r) => r.prId);
    for (const r of db
      .prepare(`SELECT lesson_confirmed_before AS b, COUNT(*) AS n FROM review_effect_comments WHERE pr_id IN (${marks(ids.length)}) AND lesson_id IS NOT NULL GROUP BY b`)
      .all(...ids) as Row[]) {
      if (Number(r.b) === 1) confirmedBefore += Number(r.n);
      else notYet += Number(r.n);
    }
  }
  const total = win.reduce((a, r) => a + r.human + r.copilot, 0);

  return {
    days, weeks, shipherd: group(shipherd), others: group(win.filter((r) => !r.shipherd)),
    withBrief: group(shipherd.filter((r) => r.brief)), withoutBrief: group(shipherd.filter((r) => !r.brief)),
    lessons: lessons.slice(0, LESSON_SHOW),
    landing: { confirmedBefore, notYet, unattributed: Math.max(0, total - confirmedBefore - notYet) },
  };
}
