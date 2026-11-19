import type { Db } from "./database";
import type {
  CheckSummary, DiffFile, EvidenceCategory, EvidenceItem, EvidenceKind, EvidenceVerified, PreReviewStatus, PreReviewTrigger,
  PreReviewVerdict, ReviewTarget, Violation,
} from "../../shared/prereview";

/** pre_reviews 的一行（工作流 G，设计 §2）。 */
export interface PreReviewRow {
  id: number;
  ticketKey: string | null;
  sessionId: string | null;
  target: ReviewTarget;
  cwd: string | null;
  base: string | null;
  prId: number | null;
  trigger: PreReviewTrigger;
  status: PreReviewStatus;
  jobId: number | null;
  files: DiffFile[];
  lessonIds: number[];
  checks: CheckSummary | null;
  violations: Violation[];
  summary: string | null;
  verdict: PreReviewVerdict | null;
  detail: string | null;
  model: string | null;
  /** 证据里的 notes（已知取舍、没做的事）。 */
  notes: string | null;
  deliveredAt: number | null;
  deliverTries: number;
  createdAt: number;
  finishedAt: number | null;
}

export interface NewPreReview {
  ticketKey: string | null;
  sessionId: string | null;
  target: ReviewTarget;
  cwd: string | null;
  base: string | null;
  prId: number | null;
  trigger: PreReviewTrigger;
  notes?: string | null;
  createdAt: number;
}

export type PreReviewPatch = Partial<{
  status: PreReviewStatus; jobId: number | null; base: string | null; prId: number | null; files: DiffFile[]; lessonIds: number[];
  checks: CheckSummary | null; violations: Violation[]; summary: string | null; verdict: PreReviewVerdict | null; detail: string | null;
  model: string | null; deliveredAt: number | null; deliverTries: number; finishedAt: number | null;
}>;

export interface NewEvidence {
  preReviewId: number | null;
  prId: number | null;
  ticketKey: string | null;
  sessionId: string | null;
  target: ReviewTarget;
  kind: EvidenceKind;
  category: EvidenceCategory | null;
  name: string;
  command: string | null;
  claimed: "pass" | "fail" | null;
  summary: string;
  createdAt: number;
}

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function json<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toReview(r: Row): PreReviewRow {
  const checks = json<CheckSummary | Record<string, never>>(r.checks, {});
  return {
    id: Number(r.id), ticketKey: s(r.ticket_key), sessionId: s(r.session_id),
    target: { repoSlug: String(r.repo_slug), branch: String(r.branch), headSha: String(r.head_sha) },
    cwd: s(r.cwd), base: s(r.base), prId: n(r.pr_id), trigger: r.trigger as PreReviewTrigger, status: r.status as PreReviewStatus,
    jobId: n(r.job_id), files: json<DiffFile[]>(r.files, []), lessonIds: json<number[]>(r.lessons, []),
    checks: "failing" in checks ? (checks as CheckSummary) : null, violations: json<Violation[]>(r.violations, []),
    summary: s(r.summary), verdict: (r.verdict as PreReviewVerdict | null) ?? null, detail: s(r.detail), model: s(r.model), notes: s(r.notes),
    deliveredAt: n(r.delivered_at), deliverTries: Number(r.deliver_tries ?? 0), createdAt: Number(r.created_at), finishedAt: n(r.finished_at),
  };
}

function toEvidence(r: Row): EvidenceItem & { ticketKey: string | null; sessionId: string | null; target: ReviewTarget } {
  return {
    id: Number(r.id), preReviewId: n(r.pre_review_id), prId: n(r.pr_id), ticketKey: s(r.ticket_key), sessionId: s(r.session_id),
    target: { repoSlug: String(r.repo_slug), branch: String(r.branch), headSha: String(r.head_sha) },
    kind: r.kind as EvidenceKind, category: (r.category as EvidenceCategory | null) ?? null, name: String(r.name), command: s(r.command),
    claimed: (r.claimed as "pass" | "fail" | null) ?? null, summary: String(r.summary), verified: r.verified as EvidenceVerified,
    verifyDetail: s(r.verify_detail), rerunOutput: s(r.rerun_output), createdAt: Number(r.created_at), verifiedAt: n(r.verified_at),
  };
}

export type StoredEvidence = ReturnType<typeof toEvidence>;

const REVIEW_COLUMNS: Record<keyof PreReviewPatch, [string, (v: never) => unknown]> = {
  status: ["status", (v) => v], jobId: ["job_id", (v) => v], base: ["base", (v) => v], prId: ["pr_id", (v) => v],
  files: ["files", (v) => JSON.stringify(v)], lessonIds: ["lessons", (v) => JSON.stringify(v)],
  checks: ["checks", (v) => JSON.stringify(v ?? {})], violations: ["violations", (v) => JSON.stringify(v)],
  summary: ["summary", (v) => v], verdict: ["verdict", (v) => v], detail: ["detail", (v) => v], model: ["model", (v) => v],
  deliveredAt: ["delivered_at", (v) => v], deliverTries: ["deliver_tries", (v) => v], finishedAt: ["finished_at", (v) => v],
};

/** 预审和完成证据（工作流 G）。 */
export class PreReviewRepo {
  constructor(private readonly db: Db) {}

  insert(r: NewPreReview): number {
    const res = this.db
      .prepare(
        `INSERT INTO pre_reviews (ticket_key, session_id, repo_slug, cwd, branch, base, head_sha, pr_id, trigger, status, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(r.ticketKey, r.sessionId, r.target.repoSlug, r.cwd, r.target.branch, r.base, r.target.headSha, r.prId, r.trigger, r.notes ?? null, r.createdAt);
    return Number(res.lastInsertRowid);
  }

  get(id: number): PreReviewRow | null {
    const r = this.db.prepare(`SELECT * FROM pre_reviews WHERE id = ?`).get(id) as Row | undefined;
    return r ? toReview(r) : null;
  }

  update(id: number, p: PreReviewPatch): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(p)) {
      const col = REVIEW_COLUMNS[k as keyof PreReviewPatch];
      if (!col || v === undefined) continue;
      sets.push(`${col[0]} = ?`);
      args.push(col[1](v as never) as string | number | null);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE pre_reviews SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  /** 这一份代码最近的一次预审（不论状态）。 */
  latestFor(t: ReviewTarget): PreReviewRow | null {
    const r = this.db
      .prepare(`SELECT * FROM pre_reviews WHERE repo_slug = ? AND branch = ? AND head_sha = ? ORDER BY id DESC LIMIT 1`)
      .get(t.repoSlug, t.branch, t.headSha) as Row | undefined;
    return r ? toReview(r) : null;
  }

  /** 这个分支最近的一次预审（任何提交）。 */
  latestForBranch(repoSlug: string, branch: string): PreReviewRow | null {
    const r = this.db
      .prepare(`SELECT * FROM pre_reviews WHERE repo_slug = ? AND branch = ? ORDER BY id DESC LIMIT 1`)
      .get(repoSlug, branch) as Row | undefined;
    return r ? toReview(r) : null;
  }

  latestForPr(prId: number): PreReviewRow | null {
    const r = this.db.prepare(`SELECT * FROM pre_reviews WHERE pr_id = ? ORDER BY id DESC LIMIT 1`).get(prId) as Row | undefined;
    return r ? toReview(r) : null;
  }

  latestForSession(sessionId: string): PreReviewRow | null {
    const r = this.db.prepare(`SELECT * FROM pre_reviews WHERE session_id = ? ORDER BY id DESC LIMIT 1`).get(sessionId) as Row | undefined;
    return r ? toReview(r) : null;
  }

  /** 还在排队或在跑的（同一份代码不重复排）。 */
  pendingFor(t: ReviewTarget): PreReviewRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM pre_reviews WHERE repo_slug = ? AND branch = ? AND head_sha = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`,
      )
      .get(t.repoSlug, t.branch, t.headSha) as Row | undefined;
    return r ? toReview(r) : null;
  }

  /** 做完了、还没送到 session 的（roundDone 时重试）。since 之前的不再重试。 */
  undelivered(since: number): PreReviewRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM pre_reviews WHERE status = 'done' AND delivered_at IS NULL AND session_id IS NOT NULL AND finished_at >= ? ORDER BY id`,
        )
        .all(since) as Row[]
    ).map(toReview);
  }

  /** 状态还是 running / queued、但任务早已不在的（启动时收尾）。 */
  stale(before: number): PreReviewRow[] {
    return (this.db.prepare(`SELECT * FROM pre_reviews WHERE status IN ('queued','running') AND created_at < ? ORDER BY id`).all(before) as Row[]).map(toReview);
  }

  /** PR 出现后，把同一份代码（分支 + 提交）的预审、证据、简报补上 pr_id。返回补了几行预审。 */
  attachPr(prId: number, t: ReviewTarget): number {
    const args = [prId, t.repoSlug, t.branch, t.headSha] as const;
    const res = this.db.prepare(`UPDATE pre_reviews SET pr_id = ? WHERE pr_id IS NULL AND repo_slug = ? AND branch = ? AND head_sha = ?`).run(...args);
    this.db.prepare(`UPDATE pr_evidence SET pr_id = ? WHERE pr_id IS NULL AND repo_slug = ? AND branch = ? AND head_sha = ?`).run(...args);
    this.db.prepare(`UPDATE pr_briefs SET pr_id = ? WHERE pr_id IS NULL AND repo_slug = ? AND branch = ? AND head_sha = ?`).run(...args);
    return Number(res.changes);
  }

  // ---------------------------------------------------------------- 证据

  addEvidence(e: NewEvidence): number {
    const res = this.db
      .prepare(
        `INSERT INTO pr_evidence (pre_review_id, pr_id, ticket_key, session_id, repo_slug, branch, head_sha, kind, category, name, command, claimed, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.preReviewId, e.prId, e.ticketKey, e.sessionId, e.target.repoSlug, e.target.branch, e.target.headSha, e.kind, e.category, e.name,
        e.command, e.claimed, e.summary, e.createdAt,
      );
    return Number(res.lastInsertRowid);
  }

  evidenceOf(preReviewId: number): StoredEvidence[] {
    return (this.db.prepare(`SELECT * FROM pr_evidence WHERE pre_review_id = ? ORDER BY id`).all(preReviewId) as Row[]).map(toEvidence);
  }

  /** 这一份代码最近一次提交的证据（同一提交提交多次时只取最近那次预审挂的）。 */
  evidenceFor(t: ReviewTarget): StoredEvidence[] {
    const last = this.db
      .prepare(
        `SELECT pre_review_id FROM pr_evidence WHERE repo_slug = ? AND branch = ? AND head_sha = ? AND pre_review_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(t.repoSlug, t.branch, t.headSha) as { pre_review_id: number } | undefined;
    return last ? this.evidenceOf(last.pre_review_id) : [];
  }

  setVerified(id: number, verified: EvidenceVerified, detail: string | null, rerunOutput: string | null, at: number): void {
    this.db
      .prepare(`UPDATE pr_evidence SET verified = ?, verify_detail = ?, rerun_output = ?, verified_at = ? WHERE id = ?`)
      .run(verified, detail, rerunOutput, at, id);
  }

  /** 按天数清理旧的预审（证据跟着级联删）。只删已经结束的。 */
  prune(before: number): number {
    return Number(
      this.db.prepare(`DELETE FROM pre_reviews WHERE status IN ('done','failed','skipped') AND created_at < ?`).run(before).changes,
    );
  }
}
