import { JOB_METRICS_GH, type JobsRepo } from "../db/jobs-repo";
import type { BaselinePr, MetricsRepo } from "../db/metrics-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import { dayStart, localDate } from "../schedule/calendar";
import { METRICS_GH_TIMEOUT_MS, reviewerKind, type IssueEvent, type PrComment, type PrStatus, type ReviewAuthors, type SearchedPr } from "../tickets/gh";
import type { RecordEvent } from "./events";

const DAY_MS = 24 * 60 * 60_000;
/** 和 PR 回填一样，同时最多 2 个 gh。 */
const GH_PARALLEL = 2;
/** 连续失败这么多次就停（gh 没登录、断网）。 */
const MAX_CONSECUTIVE_FAILURES = 5;
/** 失败后多久再试。 */
export const METRICS_GH_RETRY_MS = 30 * 60_000;
/** 每个仓库看最近多少个标题带 Revert 的已合并 PR。 */
const REVERT_SCAN_LIMIT = 50;
/** 重开：看最近 30 天有动静的 ticket PR，最多 200 个。 */
const REOPEN_RECENT_MS = 30 * DAY_MS;
const REOPEN_MAX = 200;
/** 基线：截止点之前 180 天，每个仓库最多 100 个。 */
export const BASELINE_DAYS = 180;
const BASELINE_LIMIT = 100;

export type JobPr = Pick<TicketPr, "id" | "ticketKey" | "slug" | "number" | "title" | "state" | "openedAt" | "mergedAt" | "closedAt">;

export interface MetricsGhDeps {
  gh: {
    available(): boolean;
    searchMergedPrs(cwd: string, repo: string, search: string, limit: number, timeoutMs: number, author?: string): Promise<SearchedPr[] | null>;
    prStatus(cwd: string, ref: string, timeoutMs: number): Promise<PrStatus | null>;
    reviewComments(cwd: string, number: number, timeoutMs: number, repo?: string | null): Promise<PrComment[] | null>;
    /** review 作者里哪些是 Bot（gh pr view 给的 login 不带 [bot]）；读不到为 null，按 reviewerKind 算。 */
    reviewAuthors(cwd: string, number: number, timeoutMs: number, repo?: string | null): Promise<ReviewAuthors | null>;
    issueEvents(cwd: string, repo: string, number: number, timeoutMs: number): Promise<IssueEvent[] | null>;
  };
  /** gh 在这里跑；仓库都用 slug 指定（GH_REPO），不看目录。 */
  home: string;
  /** 已知仓库的 slug：ticket 的 PR 和复盘仓库。 */
  slugs(): string[];
  prs(): JobPr[];
  baseline: Pick<MetricsRepo, "hasBaseline" | "upsertBaseline">;
  /** 基线截止点（baselineCutoff）。 */
  cutoff(): number;
  record: RecordEvent;
  jobs: Pick<JobsRepo, "get" | "record">;
  now(): number;
  log(msg: string, e?: unknown): void;
}

/** slug 的 owner/repo 两段（三段的 host/owner/repo 去掉 host），小写。 */
const ownerRepo = (slug: string): string => slug.toLowerCase().split("/").slice(-2).join("/");

/**
 * 这个 revert PR 撤的是哪些 ticket PR（纯函数）：正文里的 `Reverts owner/repo#N`（或 `Reverts #N`），
 * 或者标题 `Revert "<原标题>"` 对上原 PR 的标题。只认同一个仓库里、在 revert 合并之前合并的。
 */
export function revertTargets(rev: Pick<SearchedPr, "number" | "title" | "body" | "mergedAt">, slug: string, prs: readonly JobPr[]): JobPr[] {
  if (rev.mergedAt === null) return [];
  const numbers = new Set<number>();
  for (const m of rev.body.matchAll(/\bReverts?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi)) {
    if (m[1] === undefined || m[1].toLowerCase() === ownerRepo(slug)) numbers.add(Number(m[2]));
  }
  const title = /^Revert\s+"(.+)"\s*$/.exec(rev.title.trim())?.[1] ?? null;
  return prs.filter(
    (p) =>
      ownerRepo(p.slug) === ownerRepo(slug) &&
      p.number !== rev.number &&
      p.state === "merged" &&
      p.mergedAt !== null &&
      p.mergedAt <= rev.mergedAt! &&
      // 正文写了 Reverts #N 就只认它；没写才按标题 Revert "<标题>" 对。
      (numbers.size > 0 ? numbers.has(p.number) : title !== null && p.title === title),
  );
}

/** 要查重开的 PR：还开着的，或者最近 30 天开过、合并过、关过的，最近的在前，最多 200 个（纯函数）。 */
export function reopenCandidates(prs: readonly JobPr[], now: number): JobPr[] {
  const last = (p: JobPr) => Math.max(p.openedAt ?? 0, p.mergedAt ?? 0, p.closedAt ?? 0);
  return prs
    .filter((p) => p.state === "open" || last(p) >= now - REOPEN_RECENT_MS)
    .sort((a, b) => last(b) - last(a))
    .slice(0, REOPEN_MAX);
}

/**
 * 一个基线 PR 的周期和评论（纯函数），计法和 ticket PR 一样：普通评论、行内评论、有正文的 review，
 * 按 reviewerKind 分 human / copilot（作者自己、bot 不算）；同一个 review 只算一次。没有开 / 合并时间的返回 null。
 */
export function baselineOf(slug: string, pr: PrStatus, inline: readonly PrComment[], fetchedAt: number, bots: ReviewAuthors | null = null): BaselinePr | null {
  if (pr.createdAt === null || pr.mergedAt === null) return null;
  let human = 0;
  let copilot = 0;
  // 和 ticket PR 一样（pr-observe）：gh pr view 的 login 不带 [bot]，靠 reviews API 的 user.type 认出 Bot。
  const isBot = (login: string, reviewId: string | null) =>
    bots !== null && ((reviewId !== null && bots.botReviewIds.has(reviewId)) || bots.botLogins.has(login.toLowerCase().replace(/\[bot\]$/, "")));
  const count = (login: string, reviewId: string | null = null) => {
    const k = reviewerKind(login, pr.author);
    if (k === "human" && isBot(login, reviewId)) return;
    if (k === "human") human++;
    else if (k === "copilot") copilot++;
  };
  for (const c of [...pr.comments, ...inline]) count(c.author);
  const seen = new Set<string>();
  for (const r of pr.reviews) {
    if (r.state === "PENDING" || r.body.trim() === "" || seen.has(r.id)) continue;
    seen.add(r.id);
    count(r.author, r.id);
  }
  return { slug, number: pr.number, openedAt: pr.createdAt, mergedAt: pr.mergedAt, firstCommitAt: pr.firstCommitAt, humanComments: human, copilotComments: copilot, fetchedAt };
}

/** gh 的 merged: 搜索用 UTC 日期。 */
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

type Task = () => Promise<boolean>;

/**
 * 度量的每日 gh 任务（`JOB_METRICS_GH`，ws-h 第 7、8 节）：只读。
 * - revert：每个仓库最近标题带 Revert 的已合并 PR，对上 ticket PR 记 `pr_reverted`；
 * - 重开：最近有动静的 ticket PR 的时间线里的 reopened，记 `pr_reopened`；
 * - 基线：截止点之前 180 天自己合并的、不是 ticket PR 的，写进 `metrics_baseline_prs`（已有的不重读）。
 * 同时最多 2 个 gh；连续失败 5 次就停。全部失败才记 failed（30 分钟后再试），否则今天不再跑。
 */
export class MetricsGhJob {
  private running = false;

  constructor(private readonly d: MetricsGhDeps) {}

  /** checkSchedule 每次调：今天已经跑过就什么都不做。 */
  async daily(): Promise<boolean> {
    if (this.running || !this.d.gh.available()) return false;
    const { lastRunAt: last, lastStatus } = this.d.jobs.get(JOB_METRICS_GH);
    const now = this.d.now();
    if (last !== null && lastStatus === "ok" && last >= dayStart(localDate(now))) return false;
    if (last !== null && lastStatus === "failed" && now - last < METRICS_GH_RETRY_MS) return false;
    this.running = true;
    try {
      const { attempted, failed, stopped } = await this.run();
      // 全失败，或者连续失败停下来（剩下的没跑）：记 failed，30 分钟后再试；已经读到的会去重、已有的基线不重读。
      if ((attempted > 0 && failed === attempted) || stopped) this.d.jobs.record(JOB_METRICS_GH, this.d.now(), "failed", `${failed} gh call(s) failed`);
      else this.d.jobs.record(JOB_METRICS_GH, this.d.now(), "ok", failed > 0 ? `${failed} of ${attempted} gh call(s) failed` : null);
      return true;
    } catch (e) {
      this.d.log("metrics: gh job failed", e);
      this.d.jobs.record(JOB_METRICS_GH, this.d.now(), "failed", e instanceof Error ? e.message : String(e));
      return true;
    } finally {
      this.running = false;
    }
  }

  /** 跑一遍（不看今天跑没跑过）。返回 gh 调用的次数和失败次数。 */
  async run(): Promise<{ attempted: number; failed: number; stopped: boolean }> {
    const prs = this.d.prs();
    const slugs = [...new Set([...this.d.slugs(), ...prs.map((p) => p.slug)])].sort();
    const ticketPr = new Set(prs.map((p) => `${ownerRepo(p.slug)}#${p.number}`));
    const now = this.d.now();
    const cutoff = this.d.cutoff();
    const details: Task[] = [];
    const counts = { attempted: 0, failed: 0, consecutive: 0 };
    // 先列（revert、重开、基线列表），再读要补的基线 PR：两批都同时最多 2 个 gh。
    await this.pool(
      [
        ...slugs.map((slug) => () => this.reverts(slug, prs)),
        ...reopenCandidates(prs, now).map((p) => () => this.reopens(p)),
        ...slugs.map((slug) => () => this.baseline(slug, cutoff, ticketPr, details)),
      ],
      counts,
    );
    await this.pool(details, counts);
    const stopped = counts.consecutive >= MAX_CONSECUTIVE_FAILURES;
    if (stopped) this.d.log(`metrics: gh job stopped after ${counts.consecutive} failures in a row`);
    return { attempted: counts.attempted, failed: counts.failed, stopped };
  }

  private async pool(tasks: Task[], c: { attempted: number; failed: number; consecutive: number }): Promise<void> {
    const queue = [...tasks];
    const worker = async (): Promise<void> => {
      for (;;) {
        if (c.consecutive >= MAX_CONSECUTIVE_FAILURES) return;
        const t = queue.shift();
        if (!t) return;
        c.attempted++;
        const ok = await t().catch((e: unknown) => {
          this.d.log("metrics: gh task threw", e);
          return false;
        });
        if (ok) c.consecutive = 0;
        else {
          c.failed++;
          c.consecutive++;
        }
      }
    };
    await Promise.all(Array.from({ length: GH_PARALLEL }, worker));
  }

  private async reverts(slug: string, prs: readonly JobPr[]): Promise<boolean> {
    const list = await this.d.gh.searchMergedPrs(this.d.home, slug, "Revert in:title sort:created-desc", REVERT_SCAN_LIMIT, METRICS_GH_TIMEOUT_MS);
    if (list === null) {
      this.d.log(`metrics: revert scan failed for ${slug}`);
      return false;
    }
    for (const rev of list) {
      for (const p of revertTargets(rev, slug, prs)) {
        this.d.record("pr_reverted", { prId: p.id, ticketKey: p.ticketKey, repoSlug: p.slug, at: rev.mergedAt ?? undefined, data: { revert: rev.number }, dedupeKey: `revert:${p.id}` });
      }
    }
    return true;
  }

  private async reopens(p: JobPr): Promise<boolean> {
    const events = await this.d.gh.issueEvents(this.d.home, p.slug, p.number, METRICS_GH_TIMEOUT_MS);
    if (events === null) {
      this.d.log(`metrics: reading events failed for ${p.slug}#${p.number}`);
      return false;
    }
    for (const e of events) {
      if (e.event !== "reopened") continue;
      this.d.record("pr_reopened", { prId: p.id, ticketKey: p.ticketKey, repoSlug: p.slug, at: e.at, dedupeKey: `reopen:${p.id}:${e.id}` });
    }
    return true;
  }

  /** 列出基线 PR；每个要读的 PR 排成一个任务放进 details，列完以后再读。 */
  private async baseline(slug: string, cutoff: number, ticketPr: ReadonlySet<string>, details: Task[]): Promise<boolean> {
    const from = cutoff - BASELINE_DAYS * DAY_MS;
    const list = await this.d.gh.searchMergedPrs(this.d.home, slug, `merged:${isoDay(from)}..${isoDay(cutoff)} sort:created-desc`, BASELINE_LIMIT, METRICS_GH_TIMEOUT_MS, "@me");
    if (list === null) {
      this.d.log(`metrics: baseline list failed for ${slug}`);
      return false;
    }
    for (const item of list) {
      if (item.mergedAt === null || item.mergedAt >= cutoff || item.mergedAt < from) continue;
      if (ticketPr.has(`${ownerRepo(slug)}#${item.number}`) || this.d.baseline.hasBaseline(slug, item.number)) continue;
      details.push(() => this.baselinePr(slug, item));
    }
    return true;
  }

  private async baselinePr(slug: string, item: SearchedPr): Promise<boolean> {
    const pr = await this.d.gh.prStatus(this.d.home, item.url, METRICS_GH_TIMEOUT_MS);
    const inline = pr ? await this.d.gh.reviewComments(this.d.home, item.number, METRICS_GH_TIMEOUT_MS, slug) : null;
    if (!pr || inline === null) {
      this.d.log(`metrics: reading baseline PR failed for ${slug}#${item.number}`);
      return false;
    }
    const bots = await this.d.gh.reviewAuthors(this.d.home, item.number, METRICS_GH_TIMEOUT_MS, slug);
    const row = baselineOf(slug, pr, inline, this.d.now(), bots);
    if (row) this.d.baseline.upsertBaseline(row);
    return true;
  }
}
