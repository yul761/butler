import { existsSync } from "node:fs";
import type {
  Lesson, LessonAction, LessonActResult, LessonFinding, LessonProductView, LessonQueueRowStatus, LessonQueueRowView, LessonQueueView, LessonRepoView,
  LessonRunDetail, LessonRunSummary, LessonsState, LessonUnknownRepo,
} from "../../shared/lessons";
import type { ClaudeAvailability, LessonsGate } from "../claude/availability";
import type { LessonRunRow, LessonRunsRepo } from "../db/lesson-runs-repo";
import type { LessonQueueRow, LessonsRepo } from "../db/lessons-repo";
import { AnalysisSchema } from "./analyze";
import { isAllowedGithubUrl } from "../util/github-url";
import type { OpenSessionResult } from "../../shared/types";
import type { LessonRunner } from "./lesson-runner";
import type { RepoIdentity } from "./repo-identity";
import { overflowFor, productSuggestions } from "./select";

export interface LessonsServiceDeps {
  repo: LessonsRepo;
  identity: RepoIdentity;
  runs: LessonRunsRepo;
  availability: Pick<ClaudeAvailability, "lessonsGate" | "pauseLessons" | "resumeLessons">;
  runner: Pick<LessonRunner, "backfill" | "cancel" | "retry" | "retryFailed" | "runNow" | "running">;
  /** Butler 知道的所有仓库根路径（ticket_repos、feature_repos、epic_repos 的 repo_path 去重）。 */
  knownRepoPaths: () => string[];
  /** 每个 ticket 和每个 feature 的仓库根路径，一组一个数组，给归组建议用。 */
  repoGroups: () => string[][];
  /** 路径是否存在，默认 existsSync。不存在的已知路径整个跳过。 */
  exists?: (p: string) => boolean;
  ghAvailable: () => boolean;
  openExternal: (url: string) => void;
  /** 写好这次运行的记录文件，在复盘分析 session 里打开它（repoPath：这个仓库的本地路径）。 */
  openRun: (d: LessonRunDetail, repoPath: string) => Promise<OpenSessionResult>;
  now: () => number;
  notify: () => void;
}

export type { LessonActResult };

/** 队列项在页面上的状态（limited 只在限额暂停期间显示，闸门开了或手动暂停都不算）：running、limited、waiting、cancelled 是从底层状态加上最近一次运行推出来的。now 由调用方传入。 */
export function queueRowStatus(row: Pick<LessonQueueRow, "status" | "error" | "notBefore">, lastRun: Pick<LessonRunSummary, "status"> | null, now: number, gate: Pick<LessonsGate, "paused"> & { reason?: string } = { paused: false }): LessonQueueRowStatus {
  if (row.status === "running") return "running";
  if (row.status === "queued") {
    if (lastRun?.status === "limited" && gate.paused && gate.reason !== "manual") return "limited";
    if (row.notBefore !== null && row.notBefore > now) return "waiting";
    return "queued";
  }
  if (row.status === "skipped" && row.error === "cancelled") return "cancelled";
  return row.status;
}

const summary = (r: LessonRunRow): LessonRunSummary => ({
  id: r.id, status: r.status, reason: r.reason, startedAt: r.startedAt, finishedAt: r.finishedAt,
  created: r.created, hit: r.hit, dropped: r.dropped, costUsd: r.costUsd, durationMs: r.durationMs,
});

/** 存的 findings 按分析输出的格式解析；解析不出来（被截断、格式不对）返回 null。 */
function parseFindings(raw: unknown): LessonFinding[] | null {
  if (raw === null) return null;
  const p = AnalysisSchema.safeParse({ findings: raw });
  if (!p.success) return null;
  return p.data.findings.map((f) => ({
    summary: f.summary,
    avoidable: f.avoidable,
    whyMissed: f.why_missed,
    rule: f.rule ? { text: f.rule.text, why: f.rule.why, scope: f.rule.scope } : null,
    commentUrl: f.comment_url,
  }));
}

const fromRunner = (r: "ok" | "not_found" | "bad_status"): LessonActResult => (r === "ok" ? { ok: true } : { ok: false, reason: r });
const NOT_FOUND = { ok: false, reason: "not_found" } as const;
const PRODUCT_NOT_FOUND = { ok: false, reason: "product_not_found" } as const;

/** 复盘规矩页：拼出整页的状态，执行页面上的操作。 */
export class LessonsService {
  constructor(private readonly d: LessonsServiceDeps) {}

  /** 只打开 github.com，或者某个已知仓库自己的主机（企业版 GitHub，slug 是 host/owner/repo）上的 https 链接。 */
  private allowedUrl(url: string): boolean {
    return isAllowedGithubUrl(url, this.d.repo.repos().map((r) => r.slug));
  }

  /** 先把 knownRepoPaths 里解析得出、且表里还没有（或路径变了）的 upsertRepo，再拼视图。 */
  state(): LessonsState {
    const { repo, identity } = this.d;
    const exists = this.d.exists ?? existsSync;
    const unknownRepos: LessonUnknownRepo[] = [];
    let rows = repo.repos();
    const known = new Map(rows.map((r) => [r.slug, r.localPath]));
    const candidates = new Map<string, string[]>(); // slug -> 存在的候选路径（按出现顺序）
    for (const path of new Set(this.d.knownRepoPaths())) {
      if (!exists(path)) continue;
      const r = identity.resolve(path);
      if (!("slug" in r)) {
        unknownRepos.push({ path, reason: r.reason });
        continue;
      }
      (candidates.get(r.slug) ?? candidates.set(r.slug, []).get(r.slug)!).push(path);
    }
    let changed = false;
    for (const [slug, paths] of candidates) {
      const stored = known.get(slug);
      // 已存的路径还在候选里就不动；否则写第一个候选。
      if (stored !== undefined && paths.includes(stored)) continue;
      repo.upsertRepo(slug, paths[0], this.d.now());
      changed = true;
    }
    if (changed) rows = repo.repos();
    const repos: LessonRepoView[] = rows
      .map((r) => ({
        slug: r.slug,
        localPath: r.localPath,
        lastAnalyzedAt: r.lastAnalyzedAt,
        analyzedCount: r.analyzedCount,
        ...repo.queueCounts(r.slug),
        backfilled: r.backfilledAt !== null,
        overflow: overflowFor(repo, r.slug),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const products = repo.products();
    const groups = this.d.repoGroups().map((g) => g.flatMap((p) => identity.slugOf(p) ?? []));
    return {
      repos,
      unknownRepos,
      products,
      suggestions: productSuggestions(groups, products),
      lessons: repo.lessons().filter((l) => l.status !== "rejected"),
      ghAvailable: this.d.ghAvailable(),
      queue: this.queueView(),
    };
  }

  private queueView(): LessonQueueView {
    const gate = this.d.availability.lessonsGate(this.d.now());
    return {
      running: this.d.runner.running(),
      queued: this.d.repo.queuedTotal(),
      pause: gate.paused ? { reason: gate.reason, until: gate.until, message: gate.message } : null,
    };
  }

  /** 某个仓库的队列项，各带最近一次运行。 */
  runs(slug: string): LessonQueueRowView[] {
    const now = this.d.now();
    const gate = this.d.availability.lessonsGate(now);
    return this.d.repo.queueRows(slug).map((q) => {
      const run = q.lastRunId === null ? null : this.d.runs.get(q.lastRunId);
      const lastRun = run ? summary(run) : null;
      return {
        queueId: q.id,
        prNumber: q.prNumber,
        prTitle: run?.prTitle ?? null,
        origin: q.origin,
        status: queueRowStatus(q, lastRun, now, gate),
        reason: q.error,
        message: q.errorMessage,
        attempts: q.attempts,
        enqueuedAt: q.enqueuedAt,
        finishedAt: q.finishedAt,
        notBefore: q.notBefore,
        lastRun,
      };
    });
  }

  /** 一次运行的全部细节；运行已被清理时为 null。 */
  run(id: number): LessonRunDetail | null {
    const r = this.d.runs.get(id);
    if (!r) return null;
    return {
      ...summary(r),
      slug: r.slug, prNumber: r.prNumber, prUrl: r.prUrl, prTitle: r.prTitle, origin: r.origin,
      message: r.message, stderrTail: r.stderrTail, ghStderr: r.ghStderr, material: r.material, rawOutput: r.rawOutput, trimmed: r.trimmed,
      findings: parseFindings(r.findings),
      model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      lessons: this.d.repo.runLessons(r.id),
      attempts: this.d.runs.forPr(r.slug, r.prNumber).filter((a) => a.id !== r.id).map(summary),
    };
  }

  pendingCount(): number {
    return this.d.repo.pendingCount();
  }

  async act(a: LessonAction): Promise<LessonActResult> {
    const r = await this.dispatch(a);
    if (r.ok) this.d.notify();
    return r;
  }

  private async dispatch(a: LessonAction): Promise<LessonActResult> {
    const { repo } = this.d;
    const now = this.d.now();
    switch (a.op) {
      case "confirm": {
        const l = repo.get(a.id);
        if (!l) return NOT_FOUND;
        // 只有待确认的能确认：已拒绝或已停用的不能靠这个翻回来。
        if (l.status !== "pending") return { ok: false, reason: "bad_status" };
        repo.transaction(() => {
          if (a.text !== undefined) repo.setText(a.id, a.text, now);
          repo.setStatus(a.id, "confirmed", now);
        });
        return { ok: true };
      }
      case "reject":
        if (!repo.get(a.id)) return NOT_FOUND;
        repo.setStatus(a.id, "rejected", now);
        return { ok: true };
      case "edit":
        if (!repo.get(a.id)) return NOT_FOUND;
        repo.setText(a.id, a.text, now);
        return { ok: true };
      case "setDisabled": {
        const l = repo.get(a.id);
        if (!l) return NOT_FOUND;
        // 只在已确认和停用之间切换：待确认的不能靠这个绕过确认。
        if (l.status !== "confirmed" && l.status !== "disabled") return { ok: false, reason: "bad_status" };
        repo.setStatus(a.id, a.disabled ? "disabled" : "confirmed", now);
        return { ok: true };
      }
      case "delete":
        if (!repo.get(a.id)) return NOT_FOUND;
        repo.remove(a.id);
        return { ok: true };
      case "merge": {
        if (a.keepId === a.dropId) return { ok: false, reason: "same_lesson" };
        const keep = repo.get(a.keepId);
        const drop = repo.get(a.dropId);
        if (!keep || !drop) return NOT_FOUND;
        if (!sameScope(keep, drop)) return { ok: false, reason: "scope_mismatch" };
        repo.merge(a.keepId, a.dropId, a.text, now);
        return { ok: true };
      }
      case "createProduct":
        if (repo.products().some((p: LessonProductView) => p.name === a.name)) return { ok: false, reason: "name_taken" };
        repo.createProduct(a.name, a.slugs, now);
        return { ok: true };
      case "deleteProduct":
        if (!repo.product(a.id)) return PRODUCT_NOT_FOUND;
        repo.deleteProduct(a.id);
        return { ok: true };
      case "addToProduct":
        if (!repo.product(a.id) || !repo.repo(a.slug)) return PRODUCT_NOT_FOUND;
        repo.addToProduct(a.id, a.slug);
        return { ok: true };
      case "removeFromProduct":
        if (!repo.product(a.id)) return PRODUCT_NOT_FOUND;
        repo.removeFromProduct(a.id, a.slug);
        return { ok: true };
      case "backfill":
        return this.d.runner.backfill(a.slug);
      case "retry":
        return fromRunner(this.d.runner.retry(a.queueId));
      case "retryFailed":
        this.d.runner.retryFailed(a.slug);
        return { ok: true };
      case "cancel":
        return fromRunner(this.d.runner.cancel(a.queueId));
      case "pauseQueue":
        this.d.availability.pauseLessons();
        return { ok: true };
      case "resumeQueue":
        this.d.availability.resumeLessons();
        return { ok: true };
      case "runNow":
        this.d.runner.runNow();
        return { ok: true };
      case "openInClaude": {
        const d = this.run(a.runId);
        const local = d ? repo.repo(d.slug)?.localPath : undefined;
        if (!d || !local) return NOT_FOUND;
        const r = await this.d.openRun(d, local);
        return r.ok ? { ok: true, sessionId: r.termId } : { ok: false, reason: r.reason };
      }
      case "openSource": {
        const url = repo.source(a.sourceId)?.url;
        if (!url || !this.allowedUrl(url)) return { ok: false, reason: "bad_url" };
        this.d.openExternal(url);
        return { ok: true };
      }
    }
  }
}

const sameScope = (a: Lesson, b: Lesson): boolean =>
  a.scope.kind === "repo" ? b.scope.kind === "repo" && a.scope.slug === b.scope.slug : b.scope.kind === "product" && a.scope.productId === b.scope.productId;
