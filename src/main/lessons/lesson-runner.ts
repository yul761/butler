import type { LimitKind } from "../../shared/availability";
import type { Lang } from "../../shared/i18n";
import type { BgKind } from "../../shared/background";
import type { LessonOrigin, LessonRunningItem } from "../../shared/lessons";
import type { BackgroundScheduler } from "../background/scheduler";
import type { ClaudeAvailability } from "../claude/availability";
import { headlessArgs, type ClaudeResult } from "../claude/headless";
import type { JobsRepo } from "../db/jobs-repo";
import { JOB_LESSONS_DAILY } from "../db/jobs-repo";
import type { LessonRunFinish, LessonRunsRepo } from "../db/lesson-runs-repo";
import type { LessonsRepo, QueueItem } from "../db/lessons-repo";
import { execHeadlessJson, type HeadlessExecDeps, type HeadlessExecResult } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { dayStart, localDate } from "../schedule/calendar";
import { LESSON_GH_TIMEOUT_MS, type compareFiles, type mergedPrs, type MergedPr, type prLessonDataDetail } from "../tickets/gh";
import { AnalysisSchema, analysisPrompt, applyAnalysis } from "./analyze";
import { fixRange, reviewItems, transcriptExcerpts, type Material } from "./material";
import type { RepoIdentity } from "./repo-identity";

export const LESSON_CONCURRENCY = 2;
export const BACKFILL_LIMIT = 100;
const EXCERPT_MAX_CHARS = 20_000;
/** 每日拉取全部失败后，这么久之内不再重试（调度器每分钟触发一次）。 */
export const DAILY_RETRY_BACKOFF_MS = 30 * 60_000;

export interface LessonRunnerDeps {
  repo: LessonsRepo;
  /** 每次分析（含失败、限流、取消的）一条运行记录。 */
  runs: LessonRunsRepo;
  /** 限流 / 模型不可用 / 手动暂停时不取新的；恢复时通过 subscribe 接着跑。 */
  availability: Pick<ClaudeAvailability, "lessonsGate" | "subscribe" | "resumeLessons" | "report">;
  identity: RepoIdentity;
  jobs: JobsRepo;
  gh: { mergedPrs: typeof mergedPrs; prLessonDataDetail: typeof prLessonDataDetail; compareFiles: typeof compareFiles; available: () => boolean };
  headless: HeadlessExecDeps;
  /** PR 分支 → Butler 的 ticket：在所有 ticket_repos（包括归档的）里找 branch 相同、slugOf(repo_path) 相同的那一行。 */
  ticketForBranch: (slug: string, branch: string) => string | null;
  /** wantTranscripts 为 false 时不用读对话记录（没有评论指到文件，摘录一定为空）。 */
  butlerContext: (ticketKey: string, wantTranscripts: boolean) => Promise<{ decisions: string[]; learnings: string[]; transcripts: string[][] }>;
  lang: () => Lang;
  now: () => number;
  notify: () => void;
  /**
   * 后台调度（工作流 L）：backfill 来源的是 lesson_backfill，其余是 lesson_analyze。闸门不放行的来源不取；
   * 要让路时（可打断、bgYield = interrupt）正在跑的停下、放回队列，不算失败。没接时和 2.1.0 一样随时跑。
   */
  scheduler?: Pick<BackgroundScheduler, "gate" | "subscribe" | "onYield" | "registerSource">;
  /** 模型路由：lesson_analyze 要求的档位现在能用了吗（能用时把降级跑出来的结果放回队列重跑）。没有就不重跑。 */
  upgradeReady?: () => boolean;
  /** 一次分析加了或命中了规矩（工作流 D 的自动准入接在这里）。在事务之外调用。 */
  onLessonsChanged?: (slug: string) => void;
  log?: (msg: string, e?: unknown) => void;
}

/** 看一次有没有该升级重跑的最多这么频繁（pump 很频繁）。 */
export const UPGRADE_CHECK_MS = 60_000;

/** GitHub 的搜索索引有延迟，刚合并的 PR 可能晚点才搜得到：从游标往前 1 小时搜。重复的 PR 入队时会被忽略，已分析过的不会再分析。 */
const CURSOR_OVERLAP_MS = 60 * 60_000;
function overlapped(cursor: string): string {
  const ms = Date.parse(cursor);
  return Number.isNaN(ms) ? cursor : new Date(ms - CURSOR_OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const maxMergedAt = (prs: MergedPr[]): string | null => prs.reduce<string | null>((m, p) => (m === null || p.mergedAt > m ? p.mergedAt : m), null);

/** 运行记录里除了结束时间以外的内容。 */
type RunEnd = Omit<LessonRunFinish, "finishedAt">;
/** 队列行怎么收尾：finish 成某个状态，或者回到 queued（linkRun：last_run_id 指向这次运行）。 */
type QueueEnd = { finish: "done" | "skipped" | "failed"; error?: string; message?: string } | { defer: true; linkRun: boolean };
type HeadlessFailed = Extract<HeadlessExecResult, { ok: false }>;

/** 一个正在跑的队列项。ctx 随分析一路补上，出异常时也记得住已经拿到的 PR 信息和素材。 */
interface Attempt {
  item: QueueItem;
  runId: number;
  startedAt: number;
  ctl: AbortController;
  /** 后台调度要它让路（和用户取消分开：让路的放回队列）。 */
  yieldCtl: AbortController;
  ctx: Pick<RunEnd, "prTitle" | "prUrl" | "material">;
}

/** 复盘队列项的来源 → 后台任务种类。 */
export const lessonKindOf = (origin: LessonOrigin): BgKind => (origin === "backfill" ? "lesson_backfill" : "lesson_analyze");
const ORIGINS: readonly LessonOrigin[] = ["merged", "daily", "backfill"];

/** 走了路由的运行：要求的档位、实际模型、降级前的模型。 */
function routeFields(r: HeadlessExecResult): Partial<RunEnd> {
  const route = r.route;
  if (route.requestedTier === null) return {};
  return { requestedTier: route.requestedTier, actualModel: route.actualModel, fallbackFrom: route.fallbackFrom };
}

/** claude 结果里的花费、模型、token（输入含缓存读写）和时长。 */
function claudeFields(r: ClaudeResult | null): Partial<RunEnd> {
  if (!r) return {};
  const u = r.usage;
  return {
    model: r.model ?? undefined,
    costUsd: r.costUsd ?? undefined,
    inputTokens: u ? u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead : undefined,
    outputTokens: u?.output,
    durationMs: r.durationMs ?? undefined,
  };
}

/** 复盘规矩的后台队列：最多 LESSON_CONCURRENCY 个 PR 同时交给 headless claude 分析；队列在库里，退出重开后接着跑。 */
export class LessonRunner {
  private readonly active = new Set<Promise<void>>();
  /** 正在跑的项，按队列 id。 */
  private readonly live = new Map<number, Attempt>();
  private dailyRunning = false;
  /** start() 之前不取队列：resetRunning 之前取走的行会被它改回 queued，造成重复分析。 */
  private started = false;
  private upgradeCheckedAt = -Infinity;

  constructor(private readonly d: LessonRunnerDeps) {}

  /** 降级跑出来的结果：要求的档位恢复后放回队列重跑（最多每 UPGRADE_CHECK_MS 看一次）。返回放回了几个。 */
  requeueUpgrades(force = false): number {
    const now = this.d.now();
    if (!this.d.upgradeReady || (!force && now - this.upgradeCheckedAt < UPGRADE_CHECK_MS)) return 0;
    this.upgradeCheckedAt = now;
    try {
      if (this.d.repo.upgradePendingCount() === 0 || !this.d.upgradeReady()) return 0;
      const n = this.d.repo.requeueUpgrades(now);
      if (n > 0) {
        this.d.log?.(`lessons: re-running ${n} analyses that ran on a lower tier`);
        this.d.notify();
        this.pump();
      }
      return n;
    } catch (e) {
      this.d.log?.("lessons: requeueing upgrades failed", e);
      return 0;
    }
  }

  /** 启动时调一次：上次没跑完的运行记为 aborted，running 的回到 queued，清理旧运行，然后开跑；可用状态一变就再取。 */
  start(): void {
    const now = this.d.now();
    this.d.runs.abortRunning(now);
    this.d.repo.resetRunning();
    this.prune(now);
    this.started = true;
    this.d.availability.subscribe(() => this.pump());
    const sch = this.d.scheduler;
    if (sch) {
      sch.subscribe(() => this.pump());
      sch.onYield((s) => {
        if (!("kinds" in s)) return; // 复盘不归哪个 ticket，熔断按 ticket 停的不管它
        for (const a of this.live.values()) {
          if (s.kinds.includes(lessonKindOf(a.item.origin)) && !a.yieldCtl.signal.aborted) {
            this.d.log?.(`lessons: ${a.item.slug}#${a.item.prNumber} yields to interactive work`);
            a.yieldCtl.abort();
          }
        }
      });
      sch.registerSource(() => {
        const c = this.d.repo.queueCountsByOrigin();
        return {
          lesson_analyze: { queued: (c.merged?.queued ?? 0) + (c.daily?.queued ?? 0), running: (c.merged?.running ?? 0) + (c.daily?.running ?? 0) },
          lesson_backfill: { queued: c.backfill?.queued ?? 0, running: c.backfill?.running ?? 0 },
        };
      });
    }
    this.pump();
  }

  /** 取消：正在跑的中止它的 claude（还没起进程的不会再起）；排队中的直接标成取消。 */
  cancel(queueId: number): "ok" | "not_found" | "bad_status" {
    const a = this.live.get(queueId);
    if (a) {
      a.ctl.abort();
      return "ok";
    }
    return this.d.repo.cancelQueued(queueId, this.d.now());
  }

  /** 手动重试一项：排到最前。 */
  retry(queueId: number): "ok" | "not_found" | "bad_status" {
    const r = this.d.repo.retry(queueId, this.d.now());
    if (r === "ok") this.pump();
    return r;
  }

  /** 这个仓库所有失败的项重试，返回个数。 */
  retryFailed(slug: string): number {
    const n = this.d.repo.retryFailed(slug, this.d.now());
    if (n > 0) this.pump();
    return n;
  }

  /** 「现在就跑」：等待中的项马上可取，再解除暂停。顺序要紧：resumeLessons 会同步触发订阅的 pump，那时 not_before 必须已经清掉。 */
  runNow(): void {
    this.d.repo.clearNotBefore();
    this.d.availability.resumeLessons();
    this.pump();
  }

  running(): LessonRunningItem[] {
    return [...this.live.values()].map((a) => ({ queueId: a.item.id, runId: a.runId, slug: a.item.slug, prNumber: a.item.prNumber, startedAt: a.startedAt }));
  }

  /** 页面的「分析历史」。没有 gh、解析不出 slug 时返回原因，不排队。 */
  /** 向导开始前的估算：这个仓库合并过的 PR 号（最多 BACKFILL_LIMIT 个），不排队。 */
  async mergedPrNumbers(slug: string): Promise<number[] | null> {
    const row = this.d.repo.repo(slug);
    if (!this.d.gh.available() || !row || !isCloned(row)) return null;
    const prs = await this.d.gh.mergedPrs(row.localPath, null, BACKFILL_LIMIT, LESSON_GH_TIMEOUT_MS);
    return prs === null ? null : prs.map((p) => p.number);
  }

  async backfill(slug: string): Promise<{ ok: true; enqueued: number; prs: number[] } | { ok: false; reason: "no_gh" | "gh_failed" | "unknown_repo" }> {
    if (!this.d.gh.available()) return { ok: false, reason: "no_gh" };
    const row = this.d.repo.repo(slug);
    // 本地路径为空 = 导入来的、这台机器上没有克隆：没有仓库就没法在里面跑 gh（cwd 为空会落到 Butler 自己的目录）。
    if (!row || !isCloned(row)) return { ok: false, reason: "unknown_repo" };
    const prs = await this.d.gh.mergedPrs(row.localPath, null, BACKFILL_LIMIT, LESSON_GH_TIMEOUT_MS);
    if (prs === null) return { ok: false, reason: "gh_failed" };
    this.warnIfTruncated(slug, prs);
    const enqueued = this.d.repo.transaction(() => {
      const n = this.d.repo.enqueue(slug, prs.map((p) => p.number), "backfill", this.d.now());
      this.d.repo.setBackfilled(slug, this.d.now());
      const newest = maxMergedAt(prs);
      if (newest !== null) this.d.repo.advanceCursor(slug, newest);
      return n;
    });
    this.pump();
    return { ok: true, enqueued, prs: prs.map((p) => p.number) };
  }

  /**
   * PR 监视看到 Butler 跟踪的 PR 合并时调用。repoPath 是这个 PR 所在的 ticket 仓库（不是 ticket 仓库的 PR 为 null）。
   * 认得出仓库的按仓库登记、排队；否则用 PR 的 slug，但只排已经登记过的仓库（没有本地仓库没法分析）。
   */
  merged(t: { repoPath: string | null; slug: string }, prNumber: number): void {
    const slug = t.repoPath === null ? null : this.d.identity.slugOf(t.repoPath);
    if (t.repoPath !== null && slug !== null) {
      this.d.repo.upsertRepo(slug, t.repoPath, this.d.now());
      this.d.repo.enqueue(slug, [prNumber], "merged", this.d.now());
    } else if (isCloned(this.d.repo.repo(t.slug))) {
      this.d.repo.enqueue(t.slug, [prNumber], "merged", this.d.now());
    } else return;
    this.pump();
  }

  /** checkSchedule 每次调；今天已经跑过就什么都不做。 */
  async daily(): Promise<void> {
    if (this.dailyRunning || !this.d.gh.available()) return;
    const { lastRunAt: last, lastStatus } = this.d.jobs.get(JOB_LESSONS_DAILY);
    const now = this.d.now();
    if (last !== null && lastStatus === "ok" && last >= dayStart(localDate(now))) return;
    if (last !== null && lastStatus === "failed" && now - last < DAILY_RETRY_BACKOFF_MS) return;
    this.dailyRunning = true;
    try {
      let attempted = 0;
      let failed = 0;
      for (const row of this.d.repo.repos()) {
        if (row.backfilledAt === null || !isCloned(row)) continue;
        attempted++;
        try {
          const prs = await this.d.gh.mergedPrs(row.localPath, row.mergedCursor === null ? null : overlapped(row.mergedCursor), BACKFILL_LIMIT, LESSON_GH_TIMEOUT_MS);
          if (prs === null) {
            this.d.log?.(`lessons: daily pull failed for ${row.slug}`);
            failed++;
            continue;
          }
          this.warnIfTruncated(row.slug, prs);
          this.d.repo.transaction(() => {
            this.d.repo.enqueue(row.slug, prs.map((p) => p.number), "daily", this.d.now());
            const newest = maxMergedAt(prs);
            if (newest !== null) this.d.repo.advanceCursor(row.slug, newest);
          });
        } catch (e) {
          this.d.log?.(`lessons: daily pull failed for ${row.slug}`, e);
          failed++;
        }
      }
      if (attempted > 0 && failed === attempted) this.d.jobs.record(JOB_LESSONS_DAILY, this.d.now(), "failed", "all repos failed");
      else this.d.jobs.record(JOB_LESSONS_DAILY, this.d.now(), "ok", null);
      this.prune(this.d.now());
    } finally {
      this.dailyRunning = false;
    }
    this.pump();
  }

  /** 测试用：等当前所有任务跑完。 */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active]);
  }

  private warnIfTruncated(slug: string, prs: MergedPr[]): void {
    if (prs.length === BACKFILL_LIMIT) this.d.log?.(`lessons: merged PR list hit the limit for ${slug}; older ones may be skipped`);
  }

  private prune(now: number): void {
    try {
      this.d.runs.prune(now);
    } catch (e) {
      this.d.log?.("lessons: pruning runs failed", e);
    }
  }

  /** 暂停时一个都不取；正在跑的照常跑完。 */
  private pump(): void {
    if (!this.started) return;
    this.requeueUpgrades();
    while (this.active.size < LESSON_CONCURRENCY) {
      if (this.d.headless.signal?.aborted) return;
      const now = this.d.now();
      if (this.d.availability.lessonsGate(now).paused) return;
      const sch = this.d.scheduler;
      const origins = sch ? ORIGINS.filter((o) => sch.gate(lessonKindOf(o)).run) : undefined;
      if (origins && origins.length === 0) return;
      let item: QueueItem | null;
      try {
        item = this.d.repo.take(now, origins);
      } catch (e) {
        this.d.log?.("lessons: taking the next queue item failed", e);
        return;
      }
      if (!item) return;
      const job: Promise<void> = this.process(item).finally(() => {
        this.active.delete(job);
        this.pump();
      });
      this.active.add(job);
    }
  }

  /** 一个队列项；任何异常都记成 failed（error），不让它停在 running，也不让 pump 崩。 */
  private async process(item: QueueItem): Promise<void> {
    let a: Attempt | null = null;
    try {
      const startedAt = this.d.now();
      const runId = this.d.runs.start({ queueId: item.id, slug: item.slug, prNumber: item.prNumber, origin: item.origin, startedAt });
      a = { item, runId, startedAt, ctl: new AbortController(), yieldCtl: new AbortController(), ctx: {} };
      this.live.set(item.id, a);
      await this.analyze(a);
    } catch (e) {
      this.d.log?.(`lessons: analyzing ${item.slug}#${item.prNumber} failed`, e);
      const message = String(e);
      try {
        if (a) this.settle(a, { status: "failed", reason: "error", message }, { finish: "failed", error: "error", message });
        else this.d.repo.finish(item.id, "failed", this.d.now(), "error", { message });
      } catch (e2) {
        this.d.log?.(`lessons: could not mark ${item.slug}#${item.prNumber} failed`, e2);
      }
    } finally {
      this.live.delete(item.id);
    }
    try {
      this.d.notify();
    } catch (e) {
      this.d.log?.("lessons: notify failed", e);
    }
  }

  /** 运行记录和队列行在一个事务里收尾。时长没有 claude 给的就用墙钟。 */
  private settle(a: Attempt, run: RunEnd, q: QueueEnd): void {
    const { repo } = this.d;
    const now = this.d.now();
    repo.transaction(() => {
      this.d.runs.finish(a.runId, { ...a.ctx, ...run, durationMs: run.durationMs ?? now - a.startedAt, finishedAt: now });
      if ("defer" in q) repo.defer(a.item.id, now, q.linkRun ? a.runId : undefined);
      else repo.finish(a.item.id, q.finish, now, q.error, { message: q.message ?? null, runId: a.runId });
    });
  }

  /** 让路：这次记 aborted（yielded），队列项马上回到 queued（闸门再开时接着分析这一项），不算失败。 */
  private settleYielded(a: Attempt, extra: Partial<RunEnd> = {}): void {
    this.settle(a, { ...extra, status: "aborted", reason: "yielded" }, { defer: true, linkRun: false });
  }

  private settleCancelled(a: Attempt, extra: Partial<RunEnd> = {}): void {
    this.settle(a, { ...extra, status: "cancelled", reason: "cancelled" }, { finish: "skipped", error: "cancelled" });
  }

  private settleFailure(a: Attempt, r: HeadlessFailed): void {
    const detail: Partial<RunEnd> = { message: r.message, stderrTail: r.stderr || undefined, rawOutput: r.rawText ?? undefined, ...claudeFields(r.result), ...routeFields(r) };
    if (r.reason === "rate_limited" || r.reason === "model_unavailable") {
      const kind: LimitKind = r.reason === "model_unavailable" ? "model_unavailable" : (r.limit?.kind ?? "rate_limit");
      this.ensurePaused(r, kind);
      this.settle(a, { ...detail, status: "limited", reason: kind }, { defer: true, linkRun: true });
    } else if (r.reason === "cost_paused") {
      // 复盘不归 ticket，一般到不了这里；真到了就和让路一样放回队列。
      this.settleYielded(a, detail);
    } else if (r.reason === "aborted") {
      if (a.ctl.signal.aborted) this.settleCancelled(a, detail);
      else if (a.yieldCtl.signal.aborted) this.settleYielded(a, detail);
      else this.settle(a, { ...detail, status: "aborted", reason: "app_quit" }, { defer: true, linkRun: false });
    } else {
      this.settle(a, { ...detail, status: "failed", reason: r.reason }, { finish: "failed", error: r.reason, message: r.message });
    }
  }

  /**
   * headless 的 onLimit 一般已经报过、闸门已经关了。分类器没认出来（limit 为空）时闸门还开着：自己报一次，
   * 不然刚放回队列的这一项会被马上再取走。
   */
  private ensurePaused(r: HeadlessFailed, kind: LimitKind): void {
    try {
      if (this.d.availability.lessonsGate(this.d.now()).paused) return;
      this.d.availability.report({ kind, resetsAt: r.limit?.resetsAt ?? null, message: r.limit?.message ?? r.message, source: "headless", job: "lessons", sessionId: null });
    } catch (e) {
      this.d.log?.("lessons: reporting the limit failed", e);
    }
  }

  private async analyze(a: Attempt): Promise<void> {
    const { repo, gh } = this.d;
    const { item } = a;
    const row = repo.repo(item.slug);
    if (!row || !isCloned(row)) {
      this.settle(a, { status: "failed", reason: "unknown_repo" }, { finish: "failed", error: "unknown_repo" });
      return;
    }
    const cwd = row.localPath;
    const got = await gh.prLessonDataDetail(cwd, item.prNumber, LESSON_GH_TIMEOUT_MS);
    const pr = got.data;
    if (pr) a.ctx = { prTitle: pr.title, prUrl: pr.url };
    if (a.ctl.signal.aborted) {
      this.settleCancelled(a);
      return;
    }
    if (a.yieldCtl.signal.aborted) {
      this.settleYielded(a);
      return;
    }
    if (!pr) {
      this.settle(a, { status: "failed", reason: "gh", ghStderr: got.stderr || undefined }, { finish: "failed", error: "gh", message: got.stderr || undefined });
      return;
    }
    const items = reviewItems(pr);
    if (items.length === 0) {
      this.settle(a, { status: "skipped", reason: "no_review_comments" }, { finish: "skipped" });
      return;
    }
    const paths = items.flatMap((i) => (i.path ? [i.path] : []));

    let fixes: Material["fixes"] = [];
    let fixesNote: Material["fixesNote"] = null;
    const range = fixRange(pr, items);
    if ("none" in range) {
      if (range.none === "rewritten" && paths.length > 0) {
        fixesNote = "rewritten";
        this.d.log?.(`lessons: history rewritten for ${item.slug}#${item.prNumber}, no fix range`);
      }
    } else {
      try {
        const files = await gh.compareFiles(cwd, range.base, range.head, LESSON_GH_TIMEOUT_MS);
        if (files) fixes = files.filter((f) => paths.includes(f.filename));
      } catch (e) {
        this.d.log?.(`lessons: compare failed for ${item.slug}#${item.prNumber}`, e);
      }
    }

    let butler: Material["butler"] = null;
    const ticketKey = this.d.ticketForBranch(item.slug, pr.headRefName);
    if (ticketKey !== null) {
      const ctx = await this.d.butlerContext(ticketKey, paths.length > 0);
      const excerpts: string[] = [];
      let left = EXCERPT_MAX_CHARS;
      for (const t of ctx.transcripts) {
        if (left <= 0) break;
        const got = transcriptExcerpts(t, paths, left);
        excerpts.push(...got);
        left -= got.reduce((n, s) => n + s.length, 0);
      }
      butler = { ticketKey, decisions: ctx.decisions, learnings: ctx.learnings, excerpts };
    }

    const products = repo.products().filter((p) => p.slugs.includes(item.slug));
    const productIds = new Set(products.map((p) => p.id));
    const existing = repo.lessons().filter((l) => (l.scope.kind === "repo" ? l.scope.slug === item.slug : productIds.has(l.scope.productId)));
    const prompt = analysisPrompt(this.d.lang(), item.slug, { pr, items, fixes, fixesNote, butler }, existing, products);
    a.ctx.material = prompt;

    // 取消可能发生在拉 gh 数据、读对话记录的时候：起进程前再看一次。
    if (a.ctl.signal.aborted) {
      this.settleCancelled(a);
      return;
    }
    if (a.yieldCtl.signal.aborted) {
      this.settleYielded(a);
      return;
    }
    repo.markSpawned(item.id);
    const signals = [this.d.headless.signal, a.ctl.signal, a.yieldCtl.signal].filter((s): s is AbortSignal => s !== undefined);
    const r = await execHeadlessJson({ ...this.d.headless, signal: AbortSignal.any(signals) }, {
      task: "lesson_analyze",
      label: "lessons",
      args: headlessArgs({ schema: toCliJsonSchema(AnalysisSchema), allowedTools: [] }),
      prompt,
      cwd,
    });
    if (!r.ok) {
      this.settleFailure(a, r);
      return;
    }
    const output: Partial<RunEnd> = { rawOutput: r.rawText, ...claudeFields(r.result), ...routeFields(r) };
    const v = validate(AnalysisSchema, r.value);
    if (!v.ok) {
      this.d.log?.(`lessons: bad output for ${item.slug}#${item.prNumber}: ${v.errors}`);
      this.settle(a, { ...output, status: "failed", reason: "bad_output", message: v.errors }, { finish: "failed", error: "bad_output", message: v.errors });
      return;
    }
    let changed = false;
    repo.transaction(() => {
      const allowed = new Set<string>([pr.url]);
      for (const i of items) if (i.url) allowed.add(i.url);
      const applied = applyAnalysis(repo, item.slug, item.prNumber, v.value, this.d.now(), { allowed, prUrl: pr.url }, a.runId, {
        items, degradedFrom: r.route.degraded ? (r.route.fallbackFrom ?? r.route.requestedTier) : null,
      });
      this.settle(a, { ...output, ...applied, status: "done", reason: null, findings: v.value.findings }, { finish: "done" });
      // 降了档跑的：要求的档位恢复后重跑一次（D 也会读 fallback_from 降低这次结果的权重）。
      if (r.route.degraded) repo.markUpgrade(item.id);
      changed = applied.created + applied.hit > 0;
    });
    if (changed) this.d.onLessonsChanged?.(item.slug);
  }
}

/** 这台机器上有这个仓库的克隆吗（导入来的仓库本地路径为空）。 */
export const isCloned = (row: { localPath: string } | null | undefined): boolean => !!row && row.localPath !== "";
