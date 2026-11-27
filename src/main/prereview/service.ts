// 预审的入口（设计 §3.1、§4.1、§4.5）：session 交证据、Shipherd 看到 PR 的新提交、手动重跑；结果送回 session。
import type { Mailbox } from "../mailbox/mailbox";
import type { PreReviewRepo, PreReviewRow } from "../db/prereview-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { RepoProfile } from "../../shared/baselines";
import type { ResolvedPrPolicy } from "../../shared/pr-policy";
import { sanitizeTask } from "../../shared/control";
import { parseSubmitEvidence, type EvidenceGap, type PreReviewPauseReason, type PreReviewQueueActResult, type PreReviewView, type ReviewTarget } from "../../shared/prereview";
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
  queue: {
    enqueue(kind: "pre_review", payload: PreReviewPayload, o: { ticketKey?: string | null; dedupeKey?: string | null }): number;
    cancel(id: number): boolean;
    /** 排队的任务提到最前（BTL-271 队列页）。 */
    moveToFront?(id: number): boolean;
  };
  /** 这一次预审现在排第几、为什么停着（PreReviewStatusService.placeOf）；submit_evidence 的回复里说。 */
  placeOf?(preReviewId: number): QueuePlace | null;
  /** preReviewEnabled；给了 ticket 时它所在 epic 自己选的自动化档位优先（BTL-247）。 */
  enabled(ticketKey?: string | null): boolean;
  /** session 在哪（worktree、ticket、仓库 slug）；不认识的 session 为 null。 */
  place(sessionId: string): SessionPlace | null;
  git: GitRun;
  /** 这个 PR 该送给哪个 session（和 CI 递送同一套挑法）；没有为 null。 */
  recipient(pr: TicketPr): string | null;
  /** 这个 PR 在本地哪个目录（session 的 worktree 或 ticket 仓库）；没有为 null。 */
  cwdOf(pr: TicketPr, sessionId: string | null): string | null;
  /** Shipherd 开的 session 做的 PR（不是用户自己手开的）。 */
  isShipherdPr(pr: TicketPr): boolean;
  /** 这份代码（仓库 + 分支）已经开着的 PR；交证据时据此补上 pr_id 和 base，没有为 null。 */
  openPrFor(ticketKey: string | null, target: ReviewTarget): TicketPr | null;
  profile(slug: string): RepoProfile | null;
  policy(slug: string): ResolvedPrPolicy;
  /** 信箱（BTL-245）：结果排进 session 的信箱，送到后在 on("prereview") 里记 deliveredAt。 */
  mailbox: Pick<Mailbox, "send" | "on" | "queuedByRef" | "withdraw" | "queuedRefs">;
  lang(): Lang;
  changed(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

/** 排在预审队列的哪儿。 */
export interface QueuePlace {
  position: number | null;
  /** 前面还有几个在排队。 */
  ahead: number;
  /** 现在在跑几个。 */
  running: number;
  reason: PreReviewPauseReason | null;
  waiting: "concurrency" | "worktree" | null;
}

export type SubmitResult = { ok: true; preReviewId: number; message: string } | { ok: false; message: string };

const MSG = {
  en: {
    off: "Pre-review is off in Shipherd, so the evidence was not recorded. Carry on.",
    bad: "No usable evidence: give at least one check (name, category, command, result, output), acceptance item or notRun entry.",
    unknown: "Shipherd does not know this session's worktree.",
    noGit: "Could not read HEAD and branch in the worktree.",
    dirty: "The worktree has uncommitted changes. Commit first: evidence has to match a specific commit.",
    queued: (sha: string, place: string) => `Evidence received for ${sha}. ${place}The result will be sent here. Until then, do not change the worktree. End this turn now.`,
    place: (p: QueuePlace | null): string => {
      if (!p || p.position === null) return "Shipherd is pre-reviewing it. ";
      const at = p.position === 1 ? "It is next in the pre-review queue" : `It is number ${p.position} in the pre-review queue (${p.ahead} ahead)`;
      const why = p.reason ? `; pre-review is paused right now (${REASON.en[p.reason]}) and starts once that clears` : p.waiting === "worktree" ? "; it waits for the pre-review already running in this worktree" : p.running > 0 ? `; ${p.running} running` : "";
      return `${at}${why}. `;
    },
    cancelled: (sha: string) => `The pre-review of ${sha} was cancelled in Shipherd. No result is coming; carry on with your flow.`,
  },
  zh: {
    off: "Shipherd 没开预审，证据没有记录。继续就行。",
    bad: "没有能用的证据：至少给一条检查（name、category、command、result、output）、一条验收或一条 notRun。",
    unknown: "Shipherd 不认识这个 session 的 worktree。",
    noGit: "读不到 worktree 里的 HEAD 和分支。",
    dirty: "worktree 里有没提交的改动。先提交：证据要对应一个确定的提交。",
    queued: (sha: string, place: string) => `已收到 ${sha} 的证据。${place}结果会送进来。在那之前不要改 worktree。现在结束这一轮。`,
    place: (p: QueuePlace | null): string => {
      if (!p || p.position === null) return "Shipherd 正在预审。";
      const at = p.position === 1 ? "排在预审队列第 1 个" : `排在预审队列第 ${p.position} 个（前面还有 ${p.ahead} 个）`;
      const why = p.reason ? `；预审现在停着（${REASON.zh[p.reason]}），恢复后才开始` : p.waiting === "worktree" ? "；这个 worktree 里已经有一次预审在跑，等它跑完" : p.running > 0 ? `；现在有 ${p.running} 个在跑` : "";
      return `${at}${why}。`;
    },
    cancelled: (sha: string) => `${sha} 的预审在 Shipherd 里被取消了，不会有结果送来。按流程继续就行。`,
  },
};

/** 预审停着的原因，一句话（submit_evidence 的回复、总控工具）。 */
export const REASON: Record<"zh" | "en", Record<PreReviewPauseReason, string>> = {
  zh: { manual: "预审被手动暂停了", cost: "花费熔断了", quota: "额度紧张", user_active: "等你空闲", outside_hours: "不在允许的时段", memory: "内存不够" },
  en: { manual: "paused by hand", cost: "the cost breaker tripped", quota: "quota is tight", user_active: "waiting for you to be idle", outside_hours: "outside the allowed hours", memory: "memory is short" },
};

export class PreReviewService {
  constructor(private readonly d: PreReviewServiceDeps) {
    d.mailbox.on("prereview", (m) => {
      const id = Number(m.ref?.slice("prereview:".length));
      this.d.repo.update(id, { deliveredAt: m.deliveredAt ?? this.d.now() });
      this.d.log(`pre-review ${id}: sent the result to ${m.toSession} (${m.via})`);
      this.d.changed();
    });
  }

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
      detail: null, model: null, deliveredAt: null, deliverTries: 0, createdAt: this.d.now(), startedAt: null, finishedAt: null,
    };
  }

  /** session 交证据（MCP submit_evidence）。 */
  async submitEvidence(sessionId: string, raw: unknown): Promise<SubmitResult> {
    const m = this.m();
    const place = this.d.place(sessionId);
    if (!this.d.enabled(place?.ticketKey)) return { ok: false, message: m.off };
    const args = parseSubmitEvidence(raw);
    if (!args) return { ok: false, message: m.bad };
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
    const pr = this.d.openPrFor(place.ticketKey, target);
    const prId = pr?.id ?? null;
    const id = this.enqueue(this.blank({ ticketKey: place.ticketKey, sessionId, target, cwd: place.cwd, base: pr?.baseBranch ?? null, prId, trigger: "evidence", notes: args.notes ?? null }), `session:${sessionId}:${head}`);
    const now = this.d.now();
    const base = { preReviewId: id, prId, ticketKey: place.ticketKey, sessionId, target, createdAt: now };
    for (const c of args.checks) this.d.repo.addEvidence({ ...base, kind: "check", category: c.category, name: c.name, command: c.command || null, claimed: c.result, summary: c.output });
    for (const a of args.acceptance) this.d.repo.addEvidence({ ...base, kind: "acceptance", category: null, name: a.criterion, command: null, claimed: null, summary: a.how });
    for (const u of args.ui ?? []) this.d.repo.addEvidence({ ...base, kind: "ui", category: null, name: u.path, command: null, claimed: null, summary: u.note ?? "" });
    for (const n of args.notRun ?? []) this.d.repo.addEvidence({ ...base, kind: "not_run", category: n.category ?? null, name: n.name, command: null, claimed: null, summary: n.reason });
    let at: QueuePlace | null = null;
    try {
      at = this.d.placeOf?.(id) ?? null;
    } catch (e) {
      this.d.log(`submit_evidence ${sessionId}: reading the queue place failed`, e);
    }
    return { ok: true, preReviewId: id, message: m.queued(head.slice(0, 7), m.place(at)) };
  }

  /**
   * 队列页、总控取消一次预审（排队的或在跑的）：行标成 skipped（cancelled），任务撤掉（在跑的中止）。
   * 交证据触发的会告诉那个 session 不用再等。
   */
  cancel(id: number): PreReviewQueueActResult {
    const row = this.d.repo.get(id);
    if (!row) return { ok: false, reason: "not_found" };
    if (row.status !== "queued" && row.status !== "running") return { ok: false, reason: "not_queued" };
    // 先改行再撤任务：在跑的被中止时，runner 看到行已经不是 running，不会把它放回 queued。
    this.d.repo.update(id, { status: "skipped", detail: "cancelled", startedAt: null, finishedAt: this.d.now() });
    if (row.jobId !== null) this.d.queue.cancel(row.jobId);
    this.d.log(`pre-review ${id}: cancelled (${row.status})`);
    if (row.sessionId && row.trigger === "evidence") {
      this.d.mailbox.send({ kind: "review", from: null, to: row.sessionId, featureId: null, body: sanitizeTask(this.m().cancelled(row.target.headSha.slice(0, 7))), ref: `prereview:${id}` });
    }
    this.d.changed();
    return { ok: true };
  }

  /** 队列页、总控把排队的一次预审提到最前。 */
  moveToFront(id: number): PreReviewQueueActResult {
    const row = this.d.repo.get(id);
    if (!row) return { ok: false, reason: "not_found" };
    // 行可能还停在 running（任务已经放回队列）：能不能插队看任务（BackgroundQueue.moveToFront 只认排队的）。
    if ((row.status !== "queued" && row.status !== "running") || row.jobId === null) return { ok: false, reason: "not_queued" };
    if (!this.d.queue.moveToFront?.(row.jobId)) return { ok: false, reason: "not_queued" };
    this.d.log(`pre-review ${id}: moved to the front of the queue`);
    this.d.changed();
    return { ok: true };
  }

  /**
   * Shipherd 读到一个 PR（onPrRead / linkCreatedPr 之后）：把同一份代码的预审、证据、简报补上 pr_id；
   * 预审开着、PR 开着且不是草稿、是 Shipherd 的 PR、这个提交还没预审过 → 排一次（trigger = pr）。返回排了的预审 id。
   */
  onPrSeen(pr: TicketPr): number | null {
    if (!pr.headSha || !pr.headBranch) return null;
    const target: ReviewTarget = { repoSlug: pr.slug, branch: pr.headBranch, headSha: pr.headSha };
    if (this.d.repo.attachPr(pr.id, target) > 0) this.d.changed();
    if (!this.d.enabled(pr.ticketKey) || pr.state !== "open" || pr.isDraft || !this.d.isShipherdPr(pr)) return null;
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
    return this.again(prev, { ticketKey: pr.ticketKey, sessionId, target, cwd, base: pr.baseBranch, prId: pr.id }, `manual:${pr.id}`);
  }

  /**
   * 总控按 ticket 重新预审、还没有 PR 的代码（BTL-271）：对着某一次预审的同一份代码（仓库、分支、提交）再排一次，
   * session、worktree、base、证据都沿用。找不到这一次返回 null。
   */
  rerun(preReviewId: number): number | null {
    const prev = this.d.repo.get(preReviewId);
    if (!prev) return null;
    const latest = this.d.repo.latestFor(prev.target) ?? prev;
    return this.again(latest, { ticketKey: prev.ticketKey, sessionId: latest.sessionId, target: prev.target, cwd: latest.cwd, base: latest.base, prId: latest.prId }, `manual:${prev.target.repoSlug}:${prev.target.branch}`);
  }

  /** 排一次手动预审，把上一次（同一份代码）的证据复制过来（核实结果重做）。 */
  private again(prev: PreReviewRow | null, o: Pick<PreReviewRow, "ticketKey" | "sessionId" | "target" | "cwd" | "base" | "prId">, dedupe: string): number {
    const id = this.enqueue(this.blank({ ...o, trigger: "manual", notes: prev?.notes ?? null }), dedupe);
    if (prev) {
      const now = this.d.now();
      for (const e of this.d.repo.evidenceOf(prev.id)) {
        this.d.repo.addEvidence({ preReviewId: id, prId: o.prId, ticketKey: o.ticketKey, sessionId: e.sessionId, target: o.target, kind: e.kind, category: e.category, name: e.name, command: e.command, claimed: e.claimed, summary: e.summary, createdAt: now });
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

  /**
   * 排进 session 的信箱。只送 evidence 和 manual 触发的、还有 PR 触发但有 session 的。已经在排队的不再排。
   * 返回 queued，或者为什么不送。
   */
  deliver(given: PreReviewRow): Promise<"queued" | string> {
    // 重新读一遍：flush 手里的是一轮开始时的旧行，期间 runner 可能已经送过了。
    const row = this.d.repo.get(given.id) ?? given;
    if (row.deliveredAt !== null) return Promise.resolve("already");
    if (!row.sessionId) return Promise.resolve("no_session");
    if (row.status !== "done" && !(row.status === "failed" && row.trigger === "evidence")) return Promise.resolve("not_done");
    if (row.finishedAt !== null && this.d.now() - row.finishedAt > PRE_REVIEW_DELIVERY_MS) return Promise.resolve("expired");
    const ref = `prereview:${row.id}`;
    if (this.d.mailbox.queuedByRef(ref)) return Promise.resolve("queued");
    const body = sanitizeTask(
      deliveryText({
        shortSha: row.target.headSha.slice(0, 7), verdict: row.verdict ?? "error", violations: row.violations,
        gaps: row.status === "done" ? this.gaps(row) : [], error: row.detail, lang: this.d.lang(),
      }),
    );
    this.d.mailbox.send({ kind: "review", from: null, to: row.sessionId, featureId: null, body, ref });
    return Promise.resolve("queued");
  }

  /** roundDone、启动时：还没送到的再送一次（24 小时为止）。 */
  async flush(): Promise<void> {
    // 排了 24 小时还没送到（目标一直关着）：撤回，打开时不再送过期的结论。
    for (const ref of this.d.mailbox.queuedRefs("prereview")) {
      const row = this.d.repo.get(Number(ref.slice("prereview:".length)));
      if (!row || (row.finishedAt !== null && this.d.now() - row.finishedAt > PRE_REVIEW_DELIVERY_MS)) this.d.mailbox.withdraw(ref);
    }
    for (const row of this.d.repo.undelivered(this.d.now() - PRE_REVIEW_DELIVERY_MS)) {
      try {
        await this.deliver(row);
      } catch (e) {
        this.d.log(`pre-review ${row.id}: delivery failed`, e);
      }
    }
  }

  /**
   * 启动时：上次没跑完的。任务已经不在了的记失败；任务被队列放回排队、行还停在 running 的（退出时 runner 没来得及改），
   * 行也放回 queued、清掉开跑时间，徽标、插队和队列页才对得上。jobState 是任务现在的状态，没有任务为 null。
   */
  sweep(jobState: (jobId: number) => "queued" | "running" | null): void {
    let changed = false;
    for (const row of this.d.repo.stale(this.d.now())) {
      const state = row.jobId !== null ? jobState(row.jobId) : null;
      if (state === "running") continue;
      if (state === "queued") {
        if (row.status === "running") {
          this.d.repo.update(row.id, { status: "queued", startedAt: null });
          changed = true;
        }
        continue;
      }
      this.d.repo.update(row.id, { status: "failed", verdict: "error", detail: "interrupted", finishedAt: this.d.now() });
      changed = true;
    }
    if (changed) this.d.changed();
  }
}
