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

export interface LessonRunnerDeps {
  repo: LessonsRepo;
  identity: RepoIdentity;
  jobs: JobsRepo;
  gh: { mergedPrs: typeof mergedPrs; prLessonData: typeof prLessonData; compareFiles: typeof compareFiles; available: () => boolean };
  headless: HeadlessExecDeps;
  /** PR 分支 → Butler 的 ticket：在所有 ticket_repos（包括归档的）里找 branch 相同、slugOf(repo_path) 相同的那一行。 */
  ticketForBranch: (slug: string, branch: string) => string | null;
  butlerContext: (ticketKey: string) => { decisions: string[]; learnings: string[]; transcripts: string[][] };
  lang: () => Lang;
  now: () => number;
  notify: () => void;
  log?: (msg: string, e?: unknown) => void;
}

const maxMergedAt = (prs: MergedPr[]): string | null => prs.reduce<string | null>((m, p) => (m === null || p.mergedAt > m ? p.mergedAt : m), null);

/** 复盘规矩的后台队列：最多 LESSON_CONCURRENCY 个 PR 同时交给 headless claude 分析；队列在库里，退出重开后接着跑。 */
export class LessonRunner {
  private readonly active = new Set<Promise<void>>();
  private pausedUntil = 0;
  private pauseTimer: NodeJS.Timeout | null = null;
  private dailyRunning = false;

  constructor(private readonly d: LessonRunnerDeps) {}

  /** 启动时调一次：running 的回到 queued，然后开跑。 */
  start(): void {
    this.d.repo.resetRunning();
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

  /** PR 监视看到 Butler 跟踪的 PR 合并时调用。 */
  merged(repoPath: string, prNumber: number): void {
    const slug = this.d.identity.slugOf(repoPath);
    if (slug === null) return;
    this.d.repo.upsertRepo(slug, repoPath, this.d.now());
    this.d.repo.enqueue(slug, [prNumber], "merged", this.d.now());
    this.pump();
  }

  /** checkSchedule 每次调；今天已经跑过就什么都不做。 */
  async daily(): Promise<void> {
    if (this.dailyRunning || !this.d.gh.available()) return;
    const last = this.d.jobs.get(JOB_LESSONS_DAILY).lastRunAt;
    const now = this.d.now();
    if (last !== null && last >= dayStart(localDate(now))) return;
    this.dailyRunning = true;
    try {
      for (const row of this.d.repo.repos()) {
        if (row.backfilledAt === null) continue;
        try {
          const prs = await this.d.gh.mergedPrs(row.localPath, row.mergedCursor, BACKFILL_LIMIT, LESSON_GH_TIMEOUT_MS);
          if (prs === null) {
            this.d.log?.(`lessons: daily pull failed for ${row.slug}`);
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
        }
      }
      this.d.jobs.record(JOB_LESSONS_DAILY, this.d.now(), "ok", null);
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
    const range = fixRange(pr, items);
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
      const ctx = this.d.butlerContext(ticketKey);
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
    const prompt = analysisPrompt(this.d.lang(), item.slug, { pr, items, fixes, butler }, existing, products);

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
      applyAnalysis(repo, item.slug, item.prNumber, v.value, this.d.now());
      repo.finish(item.id, "done", this.d.now());
    });
    this.d.notify();
  }
}
