import type { ForkErrorCode, ForkMode, ForkStatus } from "../../shared/fork";
import type { Db } from "./database";

/** 对话 tab「问一问」的分叉讨论：一行一个分叉，费用逐轮累计。 */
export interface ForkRow {
  id: number;
  rootSessionId: string;
  /** 第一轮跑完才知道。 */
  forkSessionId: string | null;
  mode: ForkMode;
  /** 已知部分的合计；一轮都不知道时为 null。 */
  costUsd: number | null;
  /** 有一轮算不出钱。 */
  costPartial: boolean;
  /** CLI 上次报的 total_cost_usd（续 session 时是累计的，下一轮按它取差）；还没报过为 null。 */
  costSeenTotal: number | null;
  startedAt: number;
  lastAt: number;
  summarySentAt: number | null;
  ticketKey: string | null;
  featureId: number | null;
  cwd: string;
  /** 第一轮的参数；接着问时用 continueArgs 换 resume 目标。 */
  launchArgs: string[];
  status: ForkStatus;
  errorCode: ForkErrorCode | null;
  errorResetAt: number | null;
  conclusion: string | null;
  conclusionAt: number | null;
  reaskOf: number | null;
}

interface Row {
  id: number;
  root_session_id: string;
  fork_session_id: string | null;
  mode: ForkMode;
  cost_usd: number | null;
  cost_partial: number;
  cost_seen_total: number | null;
  started_at: number;
  last_at: number;
  summary_sent_at: number | null;
  ticket_key: string | null;
  feature_id: number | null;
  cwd: string;
  launch_args: string;
  status: ForkStatus;
  error_code: ForkErrorCode | null;
  error_reset_at: number | null;
  conclusion: string | null;
  conclusion_at: number | null;
  reask_of: number | null;
}

const num = (v: number | bigint | null): number | null => (v === null ? null : Number(v));

const toFork = (r: Row): ForkRow => ({
  id: Number(r.id), rootSessionId: r.root_session_id, forkSessionId: r.fork_session_id, mode: r.mode, costUsd: num(r.cost_usd),
  costPartial: Number(r.cost_partial) === 1, costSeenTotal: num(r.cost_seen_total), startedAt: Number(r.started_at), lastAt: Number(r.last_at), summarySentAt: num(r.summary_sent_at),
  ticketKey: r.ticket_key, featureId: num(r.feature_id), cwd: r.cwd, launchArgs: JSON.parse(r.launch_args) as string[], status: r.status,
  errorCode: r.error_code, errorResetAt: num(r.error_reset_at), conclusion: r.conclusion, conclusionAt: num(r.conclusion_at), reaskOf: num(r.reask_of),
});

export interface NewFork {
  rootSessionId: string;
  mode: ForkMode;
  ticketKey: string | null;
  featureId: number | null;
  cwd: string;
  launchArgs: string[];
  at: number;
  reaskOf?: number | null;
}

export interface ForkFinish {
  at: number;
  /** 只在传了时才写；后面不传不会被清掉。 */
  forkSessionId?: string | null;
  /** 这一轮的费用；算不出来传 null。 */
  addCost: number | null;
  partial: boolean;
  /** 这一轮之后 CLI 报的累计 total_cost_usd；不传（或 null）就留着上一次的。 */
  seenTotal?: number | null;
  error?: { code: ForkErrorCode; resetAt: number | null } | null;
}

export class ForkDiscussionsRepo {
  constructor(private readonly db: Db) {}

  create(r: NewFork): ForkRow {
    const res = this.db
      .prepare(
        `INSERT INTO fork_discussions (root_session_id, mode, started_at, last_at, ticket_key, feature_id, cwd, launch_args, status, reask_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(r.rootSessionId, r.mode, r.at, r.at, r.ticketKey, r.featureId, r.cwd, JSON.stringify(r.launchArgs), r.reaskOf ?? null);
    return this.get(Number(res.lastInsertRowid))!;
  }

  get(id: number): ForkRow | null {
    const r = this.db.prepare(`SELECT * FROM fork_discussions WHERE id = ?`).get(id) as Row | undefined;
    return r ? toFork(r) : null;
  }

  /** started_at 从旧到新。 */
  listByRoot(rootSessionId: string): ForkRow[] {
    return (this.db.prepare(`SELECT * FROM fork_discussions WHERE root_session_id = ? ORDER BY started_at, id`).all(rootSessionId) as unknown as Row[]).map(toFork);
  }

  runningReaskOf(id: number): ForkRow | null {
    const r = this.db.prepare(`SELECT * FROM fork_discussions WHERE reask_of = ? AND status = 'running' ORDER BY id LIMIT 1`).get(id) as Row | undefined;
    return r ? toFork(r) : null;
  }

  /** 只有不是 running 时才改成 running；返回改没改（连点的原子判断）。 */
  start(id: number, at: number): boolean {
    return Number(this.db.prepare(`UPDATE fork_discussions SET status = 'running', last_at = ?, error_code = NULL, error_reset_at = NULL WHERE id = ? AND status != 'running'`).run(at, id).changes) > 0;
  }

  /** 一轮跑完：累计费用，status 变成 idle 或 failed；不带 error 会清掉上一次的错误。 */
  finish(id: number, o: ForkFinish): void {
    this.db
      .prepare(
        `UPDATE fork_discussions SET
           status = ?, last_at = ?,
           fork_session_id = COALESCE(?, fork_session_id),
           cost_usd = CASE WHEN ? IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + ? END,
           cost_partial = MAX(cost_partial, ?),
           cost_seen_total = COALESCE(?, cost_seen_total),
           error_code = ?, error_reset_at = ?
         WHERE id = ?`,
      )
      .run(
        o.error ? "failed" : "idle", o.at, o.forkSessionId ?? null, o.addCost, o.addCost, o.partial ? 1 : 0, o.seenTotal ?? null,
        o.error?.code ?? null, o.error?.resetAt ?? null, id,
      );
  }

  setConclusion(id: number, text: string, at: number): void {
    this.db.prepare(`UPDATE fork_discussions SET conclusion = ?, conclusion_at = ? WHERE id = ?`).run(text, at, id);
  }

  markSent(id: number, at: number): void {
    this.db.prepare(`UPDATE fork_discussions SET summary_sent_at = ? WHERE id = ?`).run(at, id);
  }

  /** 启动时用：上次退出时还在跑的，标成失败；跑到一半被杀的那一轮可能已经花了钱，费用记成一部分不知道。返回改了几行。 */
  failRunning(code: "interrupted", at: number): number {
    return Number(
      this.db
        .prepare(`UPDATE fork_discussions SET status = 'failed', error_code = ?, error_reset_at = NULL, last_at = ?, cost_partial = 1 WHERE status = 'running'`)
        .run(code, at).changes,
    );
  }
}
