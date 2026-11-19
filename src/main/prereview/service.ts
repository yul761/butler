// 预审的入口（设计 §3.1、§4.1、§4.5）：session 交证据、Butler 看到 PR 的新提交、手动重跑；结果送回 session。
import type { DeliverResult } from "../sessions/pty-manager";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { PreReviewRepo, PreReviewRow } from "../db/prereview-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { RepoProfile } from "../../shared/baselines";
import type { ResolvedPrPolicy } from "../../shared/pr-policy";
import { sanitizeTask } from "../../shared/control";
import { parseSubmitEvidence, type EvidenceGap, type PreReviewView, type ReviewTarget } from "../../shared/prereview";
import type { GitRun } from "./diff";
import { deliveryText } from "./delivery";
import { evidenceStatus, requiredEvidence } from "./evidence";
import type { Lang } from "./model";
import type { PreReviewPayload } from "./runner";

/** 送不到的预审结果最多重试这么久（设计 §4.5）。 */
export const PRE_REVIEW_DELIVERY_MS = 24 * 3600_000;

export interface SessionPlace {
  cwd: string;
  ticketKey: string | null;
  slug: string | null;
}

export interface PreReviewServiceDeps {
  repo: PreReviewRepo;
  queue: { enqueue(kind: "pre_review", payload: PreReviewPayload, o: { ticketKey?: string | null; dedupeKey?: string | null }): number; cancel(id: number): boolean };
  /** preReviewEnabled。 */
  enabled(): boolean;
  /** session 在哪（worktree、ticket、仓库 slug）；不认识的 session 为 null。 */
  place(sessionId: string): SessionPlace | null;
  git: GitRun;
  /** 这个 PR 该送给哪个 session（和 CI 递送同一套挑法）；没有为 null。 */
  recipient(pr: TicketPr): string | null;
  /** 这个 PR 在本地哪个目录（session 的 worktree 或 ticket 仓库）；没有为 null。 */
  cwdOf(pr: TicketPr, sessionId: string | null): string | null;
  /** Butler 开的 session 做的 PR（不是用户自己手开的）。 */
  isButlerPr(pr: TicketPr): boolean;
  profile(slug: string): RepoProfile | null;
  policy(slug: string): ResolvedPrPolicy;
  guard: Pick<DeliveryGuard, "check" | "recheckAfter">;
  deliver(termId: string, text: string, recheck: () => boolean): Promise<DeliverResult>;
  /** 和 CI、评论递送共用：同一个 session 同时只递一条。 */
  busy: Set<string>;
  lang(): Lang;
  changed(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

export type SubmitResult = { ok: true; preReviewId: number; message: string } | { ok: false; message: string };

const MSG = {
  en: {
    off: "Pre-review is off in Butler, so the evidence was not recorded. Carry on.",
    bad: "No usable evidence: give at least one check (name, category, command, result, output), acceptance item or notRun entry.",
    unknown: "Butler does not know this session's worktree.",
    noGit: "Could not read HEAD and branch in the worktree.",
    dirty: "The worktree has uncommitted changes. Commit first: evidence has to match a specific commit.",
    queued: (sha: string) => `Evidence received for ${sha}. Butler is pre-reviewing it; the result will be sent here. Until then, do not change the worktree. End this turn now.`,
  },
  zh: {
    off: "Butler 没开预审，证据没有记录。继续就行。",
    bad: "没有能用的证据：至少给一条检查（name、category、command、result、output）、一条验收或一条 notRun。",
    unknown: "Butler 不认识这个 session 的 worktree。",
    noGit: "读不到 worktree 里的 HEAD 和分支。",
    dirty: "worktree 里有没提交的改动。先提交：证据要对应一个确定的提交。",
    queued: (sha: string) => `已收到 ${sha} 的证据，Butler 正在预审，结果会送进来。在那之前不要改 worktree。现在结束这一轮。`,
  },
};

export class PreReviewService {
  constructor(private readonly d: PreReviewServiceDeps) {}

  private m() {
    return MSG[this.d.lang()];
  }

  /** 排一次预审：同一份代码还在排队的那次作废（被新的证据或新的触发取代）。 */
  private enqueue(row: Omit<PreReviewRow, "id">, dedupe: string): number {
    const old = this.d.repo.pendingFor(row.target);
    if (old && old.status === "queued") {
      if (old.jobId !== null) this.d.queue.cancel(old.jobId);
      this.d.repo.update(old.id, { status: "skipped", detail: "superseded", finishedAt: this.d.now() });
    }
    const id = this.d.repo.insert({ ticketKey: row.ticketKey, sessionId: row.sessionId, target: row.target, cwd: row.cwd, base: row.base, prId: row.prId, trigger: row.trigger, notes: row.notes, createdAt: row.createdAt });
    const jobId = this.d.queue.enqueue("pre_review", { preReviewId: id }, { ticketKey: row.ticketKey, dedupeKey: `${dedupe}:${id}` });
    this.d.repo.update(id, { jobId });
    this.d.changed();
    return id;
  }

  private blank(o: Pick<PreReviewRow, "ticketKey" | "sessionId" | "target" | "cwd" | "base" | "prId" | "trigger"> & { notes?: string | null }): Omit<PreReviewRow, "id"> {
    return {
      ...o, notes: o.notes ?? null, status: "queued", jobId: null, files: [], lessonIds: [], checks: null, violations: [], summary: null, verdict: null,
      detail: null, model: null, deliveredAt: null, deliverTries: 0, createdAt: this.d.now(), finishedAt: null,
    };
  }

  /** session 交证据（MCP submit_evidence）。 */
  async submitEvidence(sessionId: string, raw: unknown): Promise<SubmitResult> {
    const m = this.m();
    if (!this.d.enabled()) return { ok: false, message: m.off };
    const args = parseSubmitEvidence(raw);
    if (!args) return { ok: false, message: m.bad };
    const place = this.d.place(sessionId);
    if (!place || !place.slug) return { ok: false, message: m.unknown };
    let head: string;
    let branch: string;
    try {
      head = (await this.d.git(place.cwd, ["rev-parse", "HEAD"])).trim();
      branch = (await this.d.git(place.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if ((await this.d.git(place.cwd, ["status", "--porcelain", "--untracked-files=no"])).trim()) return { ok: false, message: m.dirty };
    } catch (e) {
      this.d.log(`submit_evidence ${sessionId}: git failed`, e);
      return { ok: false, message: m.noGit };
    }
    if (!/^[0-9a-f]{40,64}$/.test(head) || !branch || branch === "HEAD") return { ok: false, message: m.noGit };
    const target: ReviewTarget = { repoSlug: place.slug, branch, headSha: head };
    const id = this.enqueue(this.blank({ ticketKey: place.ticketKey, sessionId, target, cwd: place.cwd, base: null, prId: null, trigger: "evidence", notes: args.notes ?? null }), `session:${sessionId}:${head}`);
    const now = this.d.now();
    const base = { preReviewId: id, prId: null, ticketKey: place.ticketKey, sessionId, target, createdAt: now };
    for (const c of args.checks) this.d.repo.addEvidence({ ...base, kind: "check", category: c.category, name: c.name, command: c.command || null, claimed: c.result, summary: c.output });
    for (const a of args.acceptance) this.d.repo.addEvidence({ ...base, kind: "acceptance", category: null, name: a.criterion, command: null, claimed: null, summary: a.how });
    for (const u of args.ui ?? []) this.d.repo.addEvidence({ ...base, kind: "ui", category: null, name: u.path, command: null, claimed: null, summary: u.note ?? "" });
    for (const n of args.notRun ?? []) this.d.repo.addEvidence({ ...base, kind: "not_run", category: n.category ?? null, name: n.name, command: null, claimed: null, summary: n.reason });
    return { ok: true, preReviewId: id, message: m.queued(head.slice(0, 7)) };
  }

  /**
   * Butler 读到一个 PR（onPrRead / linkCreatedPr 之后）：把同一份代码的预审、证据、简报补上 pr_id；
   * 预审开着、PR 开着且不是草稿、是 Butler 的 PR、这个提交还没预审过 → 排一次（trigger = pr）。返回排了的预审 id。
   */
  onPrSeen(pr: TicketPr): number | null {
    if (!pr.headSha || !pr.headBranch) return null;
    const target: ReviewTarget = { repoSlug: pr.slug, branch: pr.headBranch, headSha: pr.headSha };
    if (this.d.repo.attachPr(pr.id, target) > 0) this.d.changed();
    if (!this.d.enabled() || pr.state !== "open" || pr.isDraft || !this.d.isButlerPr(pr)) return null;
    if (this.d.repo.latestFor(target)) return null;
    const sessionId = this.d.recipient(pr);
    const cwd = this.d.cwdOf(pr, sessionId);
    return this.enqueue(this.blank({ ticketKey: pr.ticketKey, sessionId, target, cwd, base: pr.baseBranch, prId: pr.id, trigger: "pr" }), `pr:${pr.slug}:${pr.headBranch}:${pr.headSha}`);
  }

  /** 页面、总控的「重新预审」：开关关着也能跑（用户亲手点的）。证据沿用这份代码最近一次交的。 */
  manual(pr: TicketPr): number | null {
    if (!pr.headSha || !pr.headBranch) return null;
    const target: ReviewTarget = { repoSlug: pr.slug, branch: pr.headBranch, headSha: pr.headSha };
    const prev = this.d.repo.latestFor(target);
    const sessionId = prev?.sessionId ?? this.d.recipient(pr);
    const cwd = prev?.cwd ?? this.d.cwdOf(pr, sessionId);
    const id = this.enqueue(this.blank({ ticketKey: pr.ticketKey, sessionId, target, cwd, base: pr.baseBranch, prId: pr.id, trigger: "manual", notes: prev?.notes ?? null }), `manual:${pr.id}`);
    // 证据跟着复制过来（核实结果重做）。
    if (prev) {
      const now = this.d.now();
      for (const e of this.d.repo.evidenceOf(prev.id)) {
        this.d.repo.addEvidence({ preReviewId: id, prId: pr.id, ticketKey: pr.ticketKey, sessionId: e.sessionId, target, kind: e.kind, category: e.category, name: e.name, command: e.command, claimed: e.claimed, summary: e.summary, createdAt: now });
      }
    }
    return id;
  }

  /** 预审对着的证据缺口（就绪、风险、递送、简报共用）。 */
  gaps(row: PreReviewRow): EvidenceGap[] {
    const evidence = this.d.repo.evidenceOf(row.id);
    const required = requiredEvidence(this.d.profile(row.target.repoSlug), row.files.map((f) => f.path), this.d.policy(row.target.repoSlug).evidence);
    return evidenceStatus(evidence, required);
  }

  view(row: PreReviewRow): PreReviewView {
    const evidence = this.d.repo.evidenceOf(row.id);
    return {
      id: row.id, ticketKey: row.ticketKey, sessionId: row.sessionId, target: row.target, base: row.base, prId: row.prId, trigger: row.trigger,
      status: row.status, verdict: row.verdict, summary: row.summary, detail: row.detail, files: row.files, lessonIds: row.lessonIds, checks: row.checks,
      violations: row.violations, evidence, missingEvidence: row.status === "done" || row.status === "failed" ? this.gaps(row) : [],
      model: row.model, deliveredAt: row.deliveredAt, createdAt: row.createdAt, finishedAt: row.finishedAt,
    };
  }

  /** MCP pre_review_result：这个 session 最近一次预审。 */
  latestForSession(sessionId: string): PreReviewView | null {
    const row = this.d.repo.latestForSession(sessionId);
    return row ? this.view(row) : null;
  }

  /** 送进 session。只送 evidence 和 manual 触发的、还有 PR 触发但有 session 的；送不到留着，flush 再试。 */
  async deliver(row: PreReviewRow): Promise<"sent" | string> {
    if (row.deliveredAt !== null) return "already";
    if (!row.sessionId) return "no_session";
    if (row.status !== "done" && !(row.status === "failed" && row.trigger === "evidence")) return "not_done";
    if (row.finishedAt !== null && this.d.now() - row.finishedAt > PRE_REVIEW_DELIVERY_MS) return "expired";
    const sid = row.sessionId;
    if (this.d.busy.has(sid)) return "busy_delivering";
    const gate = this.d.guard.check(sid);
    if (!gate.ok) {
      this.d.repo.update(row.id, { deliverTries: row.deliverTries + 1 });
      return `guard:${gate.block}`;
    }
    const lang = this.d.lang();
    const text = sanitizeTask(
      deliveryText({
        shortSha: row.target.headSha.slice(0, 7), verdict: row.verdict ?? "error", violations: row.violations,
        gaps: row.status === "done" ? this.gaps(row) : [], error: row.detail, lang,
      }),
    );
    this.d.busy.add(sid);
    try {
      const r = await this.d.deliver(gate.termId, text, this.d.guard.recheckAfter(sid, gate));
      if (r !== "sent") {
        this.d.repo.update(row.id, { deliverTries: row.deliverTries + 1 });
        return `deliver:${r}`;
      }
      this.d.repo.update(row.id, { deliveredAt: this.d.now() });
      this.d.log(`pre-review ${row.id}: sent the result to ${sid}`);
      this.d.changed();
      return "sent";
    } finally {
      this.d.busy.delete(sid);
    }
  }

  /** roundDone、启动时：还没送到的再送一次（24 小时为止）。 */
  async flush(): Promise<void> {
    for (const row of this.d.repo.undelivered(this.d.now() - PRE_REVIEW_DELIVERY_MS)) {
      try {
        await this.deliver(row);
      } catch (e) {
        this.d.log(`pre-review ${row.id}: delivery failed`, e);
      }
    }
  }

  /** 启动时：上次没跑完、任务已经不在了的（队列会把在跑的放回去；这里只收尾没有任务的）。 */
  sweep(jobAlive: (jobId: number) => boolean): void {
    for (const row of this.d.repo.stale(this.d.now())) {
      if (row.jobId !== null && jobAlive(row.jobId)) continue;
      this.d.repo.update(row.id, { status: "failed", verdict: "error", detail: "interrupted", finishedAt: this.d.now() });
    }
  }
}
