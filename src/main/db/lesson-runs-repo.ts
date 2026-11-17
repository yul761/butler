import { RUN_MESSAGE_MAX, type LessonRunReason, type LessonRunStatus } from "../../shared/lessons";
import { withTransaction, type Db } from "./database";

export const RUN_CAPS = { message: RUN_MESSAGE_MAX, stderrTail: 8192, ghStderr: 4096, material: 65536, rawOutput: 65536, findings: 65536 } as const;
export const RUNS_PER_PR = 3;
export const RUN_MAX_AGE_MS = 90 * 86_400_000;
export const RUNS_WITH_BODY = 200;

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** 保留开头 max 个字符（不拆代理对），被截掉的在末尾标出。 */
export function capHead(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  if (end > 0 && isHigh(s.charCodeAt(end - 1)) && isLow(s.charCodeAt(end))) end -= 1;
  return `${s.slice(0, end)}\n[… ${s.length - end} chars cut]`;
}

/** 保留末尾 max 个字符（不拆代理对），被截掉的在开头标出。 */
export function capTail(s: string, max: number): string {
  if (s.length <= max) return s;
  let start = s.length - max;
  if (start < s.length && isLow(s.charCodeAt(start)) && isHigh(s.charCodeAt(start - 1))) start += 1;
  return `[… ${start} chars cut]\n${s.slice(start)}`;
}

export interface NewLessonRun { queueId: number | null; slug: string; prNumber: number; origin: string; startedAt: number }
export interface LessonRunFinish {
  status: Exclude<LessonRunStatus, "running">;
  reason: LessonRunReason | null;
  finishedAt: number;
  message?: string;
  stderrTail?: string;
  ghStderr?: string;
  prTitle?: string;
  prUrl?: string;
  material?: string;
  rawOutput?: string;
  findings?: unknown;
  created?: number;
  hit?: number;
  dropped?: number;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}
export interface LessonRunRow {
  id: number;
  queueId: number | null;
  slug: string;
  prNumber: number;
  origin: string;
  status: LessonRunStatus;
  reason: string | null;
  message: string | null;
  stderrTail: string | null;
  ghStderr: string | null;
  prTitle: string | null;
  prUrl: string | null;
  material: string | null;
  rawOutput: string | null;
  findings: unknown | null;
  trimmed: boolean;
  created: number;
  hit: number;
  dropped: number;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  startedAt: number;
  finishedAt: number | null;
}

interface Row {
  id: number; queue_id: number | null; repo_slug: string; pr_number: number; origin: string; status: LessonRunStatus; reason: string | null;
  message: string | null; stderr_tail: string | null; gh_stderr: string | null; pr_title: string | null; pr_url: string | null;
  material: string | null; raw_output: string | null; findings_json: string | null; trimmed: number;
  created: number; hit: number; dropped: number; model: string | null; cost_usd: number | null;
  input_tokens: number | null; output_tokens: number | null; duration_ms: number | null; started_at: number; finished_at: number | null;
}

const n = (v: number | null): number | null => (v === null ? null : Number(v));
const parse = (s: string | null): unknown | null => {
  if (s === null) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};
const toRow = (r: Row): LessonRunRow => ({
  id: Number(r.id), queueId: n(r.queue_id), slug: r.repo_slug, prNumber: Number(r.pr_number), origin: r.origin, status: r.status, reason: r.reason,
  message: r.message, stderrTail: r.stderr_tail, ghStderr: r.gh_stderr, prTitle: r.pr_title, prUrl: r.pr_url,
  material: r.material, rawOutput: r.raw_output, findings: parse(r.findings_json), trimmed: Number(r.trimmed) === 1,
  created: Number(r.created), hit: Number(r.hit), dropped: Number(r.dropped), model: r.model, costUsd: n(r.cost_usd),
  inputTokens: n(r.input_tokens), outputTokens: n(r.output_tokens), durationMs: n(r.duration_ms), startedAt: Number(r.started_at), finishedAt: n(r.finished_at),
});

const head = (s: string | undefined, max: number): string | null => (s === undefined ? null : capHead(s, max));
const tail = (s: string | undefined, max: number): string | null => (s === undefined ? null : capTail(s, max));

/** 被 session 引用的运行（在 Claude 里打开过的）不清理。 */
const NOT_OPENED = `id NOT IN (SELECT lesson_run_id FROM sessions WHERE lesson_run_id IS NOT NULL)`;

/** 每次复盘分析的运行记录：开始、结束（带上限）、读取和保留清理。 */
export class LessonRunsRepo {
  constructor(private readonly db: Db) {}

  start(r: NewLessonRun): number {
    const res = this.db
      .prepare(`INSERT INTO lesson_runs (queue_id, repo_slug, pr_number, origin, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`)
      .run(r.queueId, r.slug, r.prNumber, r.origin, r.startedAt);
    return Number(res.lastInsertRowid);
  }

  finish(id: number, f: LessonRunFinish): void {
    const findings = f.findings === undefined ? null : capHead(JSON.stringify(f.findings) ?? "null", RUN_CAPS.findings);
    this.db
      .prepare(
        `UPDATE lesson_runs SET status = ?, reason = ?, finished_at = ?, message = ?, stderr_tail = ?, gh_stderr = ?, pr_title = ?, pr_url = ?,
           material = ?, raw_output = ?, findings_json = ?, created = ?, hit = ?, dropped = ?, model = ?, cost_usd = ?,
           input_tokens = ?, output_tokens = ?, duration_ms = ? WHERE id = ?`,
      )
      .run(
        f.status, f.reason, f.finishedAt, head(f.message, RUN_CAPS.message), tail(f.stderrTail, RUN_CAPS.stderrTail), tail(f.ghStderr, RUN_CAPS.ghStderr),
        f.prTitle ?? null, f.prUrl ?? null, head(f.material, RUN_CAPS.material), head(f.rawOutput, RUN_CAPS.rawOutput), findings,
        f.created ?? 0, f.hit ?? 0, f.dropped ?? 0, f.model ?? null, f.costUsd ?? null,
        f.inputTokens ?? null, f.outputTokens ?? null, f.durationMs ?? null, id,
      );
  }

  get(id: number): LessonRunRow | null {
    const r = this.db.prepare(`SELECT * FROM lesson_runs WHERE id = ?`).get(id) as Row | undefined;
    return r ? toRow(r) : null;
  }

  /** 某个 PR 的运行，新的在前。 */
  forPr(slug: string, prNumber: number): LessonRunRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM lesson_runs WHERE repo_slug = ? AND pr_number = ? ORDER BY started_at DESC, id DESC`)
      .all(slug, prNumber) as unknown as Row[];
    return rows.map(toRow);
  }

  /** 最近结束的运行（按 finished_at，新的在前）。 */
  recentFinished(limit: number): { status: LessonRunStatus; reason: string | null }[] {
    const rows = this.db
      .prepare(`SELECT status, reason FROM lesson_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT ?`)
      .all(limit) as unknown as { status: LessonRunStatus; reason: string | null }[];
    return rows.map((r) => ({ status: r.status, reason: r.reason }));
  }

  /** 启动时把上次没跑完的记为 aborted / app_quit。返回改了几行。 */
  abortRunning(now: number): number {
    const res = this.db
      .prepare(`UPDATE lesson_runs SET status = 'aborted', reason = 'app_quit', finished_at = ? WHERE status = 'running'`)
      .run(now);
    return Number(res.changes);
  }

  /** 保留规则：超过 90 天的删；每个 PR 只留最新 3 条；最新 200 条之外清掉 material 和 raw_output。不动 running。 */
  prune(now: number): { deleted: number; trimmed: number } {
    return withTransaction(this.db, () => {
      const aged = this.db
        .prepare(`DELETE FROM lesson_runs WHERE status <> 'running' AND started_at < ? AND ${NOT_OPENED}`)
        .run(now - RUN_MAX_AGE_MS);
      const extra = this.db
        .prepare(
          `DELETE FROM lesson_runs WHERE status <> 'running' AND ${NOT_OPENED} AND id IN (
             SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY repo_slug, pr_number ORDER BY started_at DESC, id DESC) AS rn FROM lesson_runs)
             WHERE rn > ?)`,
        )
        .run(RUNS_PER_PR);
      const trimmed = this.db
        .prepare(
          `UPDATE lesson_runs SET material = NULL, raw_output = NULL, trimmed = 1
           WHERE status <> 'running' AND (material IS NOT NULL OR raw_output IS NOT NULL) AND id IN (
             SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY started_at DESC, id DESC) AS rn FROM lesson_runs)
             WHERE rn > ?)`,
        )
        .run(RUNS_WITH_BODY);
      return { deleted: Number(aged.changes) + Number(extra.changes), trimmed: Number(trimmed.changes) };
    });
  }
}
