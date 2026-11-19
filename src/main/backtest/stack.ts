// 工作流 F 装在一起：回测服务、自动升降级、阈值复查、批次指标、「现在」页通知、检查页的视图和动作。
// index.ts 只建一次，接上队列、hit ingest、准入流水线和向导。
import type { Db } from "../db/database";
import { BacktestRepo } from "../db/backtest-repo";
import type { LessonsRepo } from "../db/lessons-repo";
import type { ChecksService } from "../checks/checks-service";
import type { LessonBatchService } from "../lessons/lesson-batches";
import type { AdmissionPolicyService } from "../lessons/admission-policies";
import type { AdmissionRunner } from "../lessons/admission/call";
import type { JudgmentCache } from "../lessons/admission/judgments";
import type { BgJobContext, BgJobResult } from "../background/queue";
import type { BgJob } from "../db/background-repo";
import type { AdmissionPolicy } from "../../shared/admission-policy";
import type { BacktestActResult, BacktestAction, BacktestView, CheckF } from "../../shared/backtest";
import type { CheckRow, CheckScope } from "../../shared/checks";
import type { AdmissionScope } from "../../shared/lesson-admission";
import type { NowNotice } from "../../shared/types";
import { lessonCommentTrend } from "../review-effect/stats";
import { BacktestService, type BacktestPayload } from "./service";
import type { Evaluator } from "./evaluator";
import type { BacktestGh, SourceRef } from "./material";
import { judgeHits } from "./judge";
import { Lifecycle } from "./lifecycle";
import { ThresholdReview } from "./thresholds";
import { backtestBatchMetrics } from "./batch-metrics";

/** 复查多久一次。 */
export const REVIEW_INTERVAL_MS = 60 * 60_000;
/** 「现在」页上的升降级通知留多久。 */
export const NOTICE_DAYS = 14;

export interface BacktestStackDeps {
  db: Db;
  /** hit ingest 比这里先建，绕过记录先写进同一个 repo。 */
  repo?: BacktestRepo;
  lessons: LessonsRepo;
  checks: ChecksService;
  batches: LessonBatchService;
  policies: AdmissionPolicyService;
  queue: { enqueue(kind: "backtest", payload: BacktestPayload, o?: { dedupeKey?: string | null; notBefore?: number | null; priority?: number }): number };
  jobs: { get(id: number): Pick<BgJob, "state" | "error"> | null; active?(kind: "backtest"): { payload: unknown }[] };
  gh: BacktestGh;
  evaluate: Evaluator;
  run: AdmissionRunner;
  judgments: JudgmentCache;
  lang: () => "zh" | "en";
  localPath: (slug: string) => string | null;
  ticketPattern: () => string;
  legacy?: { run(checkId: number, slug: string): Promise<{ ok: true; scan: { scanId: number; count: number; status: string } } | { ok: false; message: string }> };
  /** 阈值复查上次跑的时间（存在设置里）。 */
  lastReview: { get(): number | null; set(at: number): void };
  onMaterial?: (slug: string) => void;
  record?: (kind: string, data: Record<string, unknown>) => void;
  onChanged?: () => void;
  onChecksChanged?: () => void;
  fallbackCwd: string;
  now: () => number;
  log?: (msg: string, e?: unknown) => void;
}

const asRef = (scope: CheckScope) => scope;

export function createBacktestStack(d: BacktestStackDeps) {
  const repo = d.repo ?? new BacktestRepo(d.db);
  const policyOf = (scope: CheckScope): AdmissionPolicy => d.policies.resolve(asRef(scope)).value;
  const slugsOf = (scope: CheckScope): string[] =>
    scope.kind === "repo" ? [scope.slug] : scope.kind === "product" ? (d.lessons.product(scope.productId)?.slugs ?? []) : d.lessons.repos().map((r) => r.slug);
  const lessonOf = (row: CheckRow) => {
    if (row.lessonId === null) return null;
    const l = d.lessons.get(row.lessonId);
    return l ? { text: l.text, sources: l.sources } : null;
  };
  const sourcesOf = (slug: string): SourceRef[] =>
    d.lessons.lessons({}).flatMap((l) => l.sources.filter((s) => s.slug === slug));
  const slugsOfScope = (scope: AdmissionScope): string[] =>
    scope.kind === "repo" ? [scope.slug] : scope.kind === "product" ? (d.lessons.product(scope.productId)?.slugs ?? []) : d.lessons.repos().map((r) => r.slug);

  /** 复查（lifecycle、thresholds 在下面建，任务跑起来时才用）：升降级，然后看要不要阈值复查；完了推到下一个小时（同一个任务一直排着）。 */
  const onReview = async (ctx: BgJobContext): Promise<BgJobResult> => {
    // 出错也要排下一次：失败的任务不会再跑，复查就停到重启。
    let waitUntil: number | null = null;
    try {
      waitUntil = (await lifecycle.tick(ctx.signal)).waitUntil;
    } catch (e) {
      d.log?.("backtest: review failed", e);
    }
    if (ctx.signal.aborted) return { defer: true };
    try {
      thresholds.run();
    } catch (e) {
      d.log?.("backtest: threshold review failed", e);
    }
    try {
      queueMissing();
    } catch (e) {
      d.log?.("backtest: queueing backtests failed", e);
    }
    const next = d.now() + REVIEW_INTERVAL_MS;
    return { defer: true, notBefore: waitUntil !== null ? Math.min(next, Math.max(waitUntil, d.now() + 60_000)) : next, reason: "next review" };
  };

  /** 启用着、还没有当前定义回测结果的检查（手写的、导入的、改过的）：排上回测（同一条检查只排一个）。 */
  const queueMissing = (): number => {
    let n = 0;
    for (const row of d.checks.repo.all()) {
      if (!row.enabled || row.type === "run_command" || service.summaryOf(row) !== null) continue;
      service.enqueueCheck(row.id);
      n++;
    }
    return n;
  };

  const service = new BacktestService({
    repo, gh: d.gh, evaluate: d.evaluate, judge: { run: d.run, judgments: d.judgments, lang: d.lang, now: d.now },
    localPath: d.localPath, policy: (slug) => d.policies.resolve({ kind: "repo", slug }).value, ticketPattern: d.ticketPattern,
    queue: d.queue, jobs: d.jobs, sourcesOf, checks: { get: (id) => d.checks.repo.get(id), slugsOf, lessonOf }, slugsOfScope,
    legacy: d.legacy, onMaterial: d.onMaterial, onReview, onChanged: d.onChanged, fallbackCwd: d.fallbackCwd, now: d.now, log: d.log,
  });

  const lifecycle = new Lifecycle({
    db: d.db, repo, checks: d.checks, policy: (row) => policyOf(row.scope), policyVersion: () => d.policies.version(),
    backtestOf: (row) => service.summaryOf(row),
    lessonParts: (row) => (row.lessonId === null ? null : (d.lessons.get(row.lessonId)?.scoreParts ?? null)),
    lessonText: (row) => lessonOf(row)?.text ?? row.message,
    trend: (row, since) => (row.lessonId === null ? null : lessonCommentTrend(d.db, { lessonId: row.lessonId, checkId: row.id, since })),
    judge: (rule, hits) => judgeHits({ run: d.run, judgments: d.judgments, lang: d.lang, cwd: d.fallbackCwd, now: d.now }, "shadow_fp", rule, hits),
    record: d.record,
    onChanged: () => {
      d.onChecksChanged?.();
      d.onChanged?.();
    },
    now: d.now, log: d.log,
  });

  const thresholds = new ThresholdReview({
    db: d.db, repo, policy: () => d.policies.resolve({ kind: "global" }).value, policies: d.policies,
    lastRun: d.lastReview.get, setLastRun: d.lastReview.set, onPolicyChanged: d.onChanged, now: d.now,
  });

  d.batches.onUndone((original, restored) => {
    lifecycle.batchUndone(original, restored);
  });
  d.checks.onModeChanged((e) => {
    lifecycle.modeChanged(e);
  });

  const metrics = backtestBatchMetrics({ db: d.db, repo });

  /** 检查页的 F 部分。 */
  const checkF = (row: CheckRow, stats: { bypassed: number; ignored: number }): CheckF => {
    let progress: CheckF["progress"] = null;
    try {
      progress = lifecycle.assess(row).progress;
    } catch (e) {
      d.log?.(`backtest: progress of check ${row.id} failed`, e);
    }
    const sc = repo.score(row.id);
    return {
      checkId: row.id, backtest: service.summaryOf(row), score: sc ? { score: sc.score, parts: sc.parts as NonNullable<CheckF["score"]>["parts"], scoredAt: sc.scoredAt } : null,
      lifecycle: repo.lifecycle(row.id), progress, bypassed: stats.bypassed, ignored: stats.ignored,
    };
  };

  const running = (): number[] => {
    const xs = d.jobs.active?.("backtest") ?? [];
    return xs.flatMap((j) => {
      const p = j.payload as Partial<BacktestPayload> | null;
      return p && p.op === "check" && typeof (p as { checkId?: unknown }).checkId === "number" ? [(p as { checkId: number }).checkId] : [];
    });
  };

  const view = (): BacktestView => {
    const stats = d.checks.repo.stats(d.now());
    const checks = d.checks.repo.all().map((row) => {
      const s = stats.get(row.key);
      return checkF(row, { bypassed: s?.bypassed ?? 0, ignored: s?.ignored ?? 0 });
    });
    const c = repo.eventCounts();
    return {
      checks, reviews: thresholds.reviews(), running: running(),
      calibration: { promotions: c.promote, promotionsUndone: c.promoteUndone, demotions: c.demote, demotionsUndone: c.demoteUndone },
    };
  };

  const act = (a: BacktestAction): BacktestActResult => {
    switch (a.op) {
      case "rerun":
        if (!d.checks.repo.get(a.checkId)) return { ok: false, error: "not_found" };
        service.enqueueCheck(a.checkId);
        d.onChanged?.();
        return { ok: true };
      case "clearReview":
        return lifecycle.clearReview(a.checkId) ? { ok: true } : { ok: false, error: "not_found" };
      case "undo": {
        const r = d.batches.undo(a.batchId);
        return r.ok ? { ok: true, batchId: r.batchId ?? null } : { ok: false, error: r.reason };
      }
      case "dismissNotice": {
        const ok = repo.dismissEvent(a.eventId, d.now());
        if (ok) d.onChanged?.();
        return ok ? { ok: true } : { ok: false, error: "not_found" };
      }
      case "applyThreshold": {
        const r = thresholds.apply(a.id);
        if (r.ok) d.onChanged?.();
        return r;
      }
      case "dismissThreshold": {
        const ok = thresholds.dismiss(a.id);
        if (ok) d.onChanged?.();
        return ok ? { ok: true } : { ok: false, error: "not_found" };
      }
    }
  };

  /** 「现在」页：最近两周没关、没撤回的自动升降级。 */
  const notices = (): NowNotice[] =>
    repo.openEvents(d.now() - NOTICE_DAYS * 86_400_000).map((e): NowNotice =>
      e.kind === "promote"
        ? { kind: "check_promoted", eventId: e.id, batchId: e.batchId, names: e.checks.map((c) => c.name), at: e.at }
        : { kind: "check_demoted", eventId: e.id, batchId: e.batchId, names: e.checks.map((c) => c.name), reason: e.checks[0]?.reason ?? null, flagged: e.kind === "flag", at: e.at },
    );

  /** 启动：排上复查（已经排着就不重复）。 */
  const start = () => d.queue.enqueue("backtest", { op: "review" }, { dedupeKey: "review", notBefore: d.now() + 5 * 60_000 });

  return { repo, service, lifecycle, thresholds, metrics, view, act, notices, start, handler: service.handler };
}

export type BacktestStack = ReturnType<typeof createBacktestStack>;
