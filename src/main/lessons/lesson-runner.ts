import type { Lang } from "../../shared/i18n";
import { headlessArgs } from "../claude/headless";
import type { JobsRepo } from "../db/jobs-repo";
import { JOB_LESSONS_DAILY } from "../db/jobs-repo";
import type { LessonsRepo, QueueItem } from "../db/lessons-repo";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { dayStart, localDate } from "../schedule/calendar";
import { LESSON_GH_TIMEOUT_MS, type compareFiles, type mergedPrs, type MergedPr, type prLessonData } from "../tickets/gh";
import { AnalysisSchema, analysisPrompt, applyAnalysis } from "./analyze";
import { fixRange, reviewItems, transcriptExcerpts, type Material } from "./material";
import type { RepoIdentity } from "./repo-identity";

export const LESSON_CONCURRENCY = 2;
export const BACKFILL_LIMIT = 100;
export const RATE_LIMIT_PAUSE_MS = 10 * 60_000;
const EXCERPT_MAX_CHARS = 20_000;
/** 每日拉取全部失败后，这么久之内不再重试（调度器每分钟触发一次）。 */
export const DAILY_RETRY_BACKOFF_MS = 30 * 60_000;

export interface LessonRunnerDeps {
  repo: LessonsRepo;
  identity: RepoIdentity;
  jobs: JobsRepo;
  gh: { mergedPrs: typeof mergedPrs; prLessonData: typeof prLessonData; compareFiles: typeof compareFiles; available: () => boolean };
  headless: HeadlessExecDeps;
  /** PR 分支 → Butler 的 ticket：在所有 ticket_repos（包括归档的）里找 branch 相同、slugOf(repo_path) 相同的那一行。 */
  ticketForBranch: (slug: string, branch: string) => string | null;
  /** wantTranscripts 为 false 时不用读对话记录（没有评论指到文件，摘录一定为空）。 */
  butlerContext: (ticketKey: string, wantTranscripts: boolean) => Promise<{ decisions: string[]; learnings: string[]; transcripts: string[][] }>;
  lang: () => Lang;
  now: () => number;
  notify: () => void;
  log?: (msg: string, e?: unknown) => void;
}

/** GitHub 的搜索索引有延迟，刚合并的 PR 可能晚点才搜得到：从游标往前 1 小时搜。重复的 PR 入队时会被忽略，已分析过的不会再分析。 */
const CURSOR_OVERLAP_MS = 60 * 60_000;
function overlapped(cursor: string): string {
  const ms = Date.parse(cursor);
  return Number.isNaN(ms) ? cursor : new Date(ms - CURSOR_OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const maxMergedAt = (prs: MergedPr[]): string | null => prs.reduce<string | null>((m, p) => (m === null || p.mergedAt > m ? p.mergedAt : m), null);

/** 复盘规矩的后台队列：最多 LESSON_CONCURRENCY 个 PR 同时交给 headless claude 分析；队列在库里，退出重开后接着跑。 */
export class LessonRunner {
  private readonly active = new Set<Promise<void>>();
  private pausedUntil = 0;
  private pauseTimer: NodeJS.Timeout | null = null;
  private dailyRunning = false;
  /** start() 之前不取队列：resetRunning 之前取走的行会被它改回 queued，造成重复分析。 */
  private started = false;

  constructor(private readonly d: LessonRunnerDeps) {}

  /** 启动时调一次：running 的回到 queued，然后开跑。 */
  start(): void {
    this.d.repo.resetRunning();
    this.started = true;
    this.pump();
  }

  /** 页面的「分析历史」。没有 gh、解析不出 slug 时返回原因，不排队。 */
  async backfill(slug: string): Promise<{ ok: true; enqueued: number } | { ok: false; reason: "no_gh" | "gh_failed" | "unknown_repo" }> {
    if (!this.d.gh.available()) return { ok: false, reason: "no_gh" };
    const row = this.d.repo.repo(slug);
    if (!row) return { ok: false, reason: "unknown_repo" };
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
    return { ok: true, enqueued };
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
    } else if (this.d.repo.repo(t.slug)) {
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
        if (row.backfilledAt === null) continue;
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

  private pump(): void {
    if (!this.started) return;
    while (this.active.size < LESSON_CONCURRENCY) {
      if (this.d.headless.signal?.aborted) return;
      const now = this.d.now();
      if (now < this.pausedUntil) {
        this.schedulePump(this.pausedUntil - now);
        return;
      }
      let item: QueueItem | null;
      try {
        item = this.d.repo.take(now);
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

  private schedulePump(ms: number): void {
    if (this.pauseTimer) return;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      this.pump();
    }, ms + 1000);
    this.pauseTimer.unref?.();
  }

  /** 一个队列项；任何异常都记成 failed（error），不让它停在 running，也不让 pump 崩。 */
  private async process(item: QueueItem): Promise<void> {
    try {
      await this.analyze(item);
    } catch (e) {
      this.d.log?.(`lessons: analyzing ${item.slug}#${item.prNumber} failed`, e);
      try {
        this.d.repo.finish(item.id, "failed", this.d.now(), "error");
      } catch (e2) {
        this.d.log?.(`lessons: could not mark ${item.slug}#${item.prNumber} failed`, e2);
      }
    }
    try {
      this.d.notify();
    } catch (e) {
      this.d.log?.("lessons: notify failed", e);
    }
  }

  private async analyze(item: QueueItem): Promise<void> {
    const { repo, gh } = this.d;
    const row = repo.repo(item.slug);
    if (!row) {
      repo.finish(item.id, "failed", this.d.now(), "unknown_repo");
      return;
    }
    const cwd = row.localPath;
    const pr = await gh.prLessonData(cwd, item.prNumber, LESSON_GH_TIMEOUT_MS);
    if (!pr) {
      repo.finish(item.id, "failed", this.d.now(), "gh");
      return;
    }
    const items = reviewItems(pr);
    if (items.length === 0) {
      repo.finish(item.id, "skipped", this.d.now());
      return;
    }
    const paths = items.flatMap((i) => (i.path ? [i.path] : []));

    let fixes: Material["fixes"] = [];
    let fixesNote: Material["fixesNote"] = null;
    const range = fixRange(pr, items);
    if (!range && paths.length > 0) {
      fixesNote = "rewritten";
      this.d.log?.(`lessons: no fix range for ${item.slug}#${item.prNumber}, history was likely rewritten`);
    }
    if (range) {
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

    const r = await execHeadlessJson(this.d.headless, {
      label: "lessons",
      args: headlessArgs({ schema: toCliJsonSchema(AnalysisSchema), allowedTools: [] }),
      prompt,
      cwd,
    });
    if (!r.ok) {
      if (r.reason === "rate_limited") {
        this.pausedUntil = this.d.now() + RATE_LIMIT_PAUSE_MS;
        repo.defer(item.id, this.pausedUntil);
      } else if (r.reason === "aborted") repo.defer(item.id, this.d.now());
      else repo.finish(item.id, "failed", this.d.now(), r.reason);
      return;
    }
    const v = validate(AnalysisSchema, r.value);
    if (!v.ok) {
      this.d.log?.(`lessons: bad output for ${item.slug}#${item.prNumber}: ${v.errors}`);
      repo.finish(item.id, "failed", this.d.now(), "bad_output");
      return;
    }
    repo.transaction(() => {
      const allowed = new Set<string>([pr.url]);
      for (const i of items) if (i.url) allowed.add(i.url);
      applyAnalysis(repo, item.slug, item.prNumber, v.value, this.d.now(), { allowed, prUrl: pr.url });
      repo.finish(item.id, "done", this.d.now());
    });
  }
}
