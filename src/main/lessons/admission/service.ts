import type { BatchOrigin, BatchOutcome } from "../../../shared/batches";
import type { BatchReviewView } from "../../../shared/lesson-admission";
import type { LessonCheckability, LessonTarget } from "../../../shared/lessons";
import type { Db } from "../../db/database";
import type { LessonBatchService } from "../lesson-batches";
import { acceptPlan, type AcceptOutcome } from "./accept";
import { BatchReviews, type BatchMetricsProvider } from "./batch-review";
import { AdmissionPipeline, isCandidate, type AdmissionScope, type JudgeOptions, type JudgeResult, type PipelineDeps } from "./pipeline";

/**
 * 规矩准入的门面（addendum 第 4 到 6 节）：判（流水线 + 计划批次 + 抽查）、接受、改了分类以后重判一条。
 * 向导、规矩页的「全部接受推荐」和自动准入都走这里。
 */

export interface AdmissionServiceDeps extends PipelineDeps {
  db: Db;
  batches: Pick<LessonBatchService, "resolve" | "calibrate">;
  checks: PipelineDeps["checks"] & Pick<import("../../checks/checks-service").ChecksService, "saveIn" | "notifyChanged">;
  metrics?: BatchMetricsProvider | null;
  notify?: () => void;
  log?: (msg: string, err?: unknown) => void;
  /** 设置 lessonsAutoAdmit。 */
  autoAdmitEnabled?: () => boolean;
}

/** 一个仓库连着分析好几个 PR 时，等最后一个之后这么久再判一次。 */
export const AUTO_ADMIT_DEBOUNCE_MS = 60_000;

export interface JudgeAndReview extends JudgeResult {
  reviewId: number | null;
}

export class AdmissionService {
  readonly pipeline: AdmissionPipeline;
  readonly reviews: BatchReviews;
  private busy = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly d: AdmissionServiceDeps) {
    this.pipeline = new AdmissionPipeline(d);
    this.reviews = new BatchReviews({ db: d.db, now: d.now, metrics: d.metrics ?? null });
  }

  /** 判一个范围，写计划批次，再对被推荐的规矩抽查（seed 固定抽样，向导用运行 id）。 */
  async judge(scope: AdmissionScope, opts: JudgeOptions & { seed?: number; review?: boolean; reviewBatch?: number | null } = {}): Promise<JudgeAndReview> {
    const r = await this.pipeline.judge(scope, opts);
    let reviewId: number | null = null;
    // 这次什么都没变（没有新的计划批次）时，复核挂在调用方给的那个批次上（向导：这次运行上一个计划批次）。
    const batchId = r.planBatch ?? opts.reviewBatch ?? null;
    if (opts.review !== false && batchId !== null) {
      reviewId = await this.reviews.review({
        batchId, ctx: r.ctx, admitted: r.admitted, producer: r.producer, verdicts: r.verdicts, policy: this.reviewPolicy(scope), seed: opts.seed ?? batchId,
      });
    }
    this.d.notify?.();
    return { ...r, reviewId };
  }

  review(id: number, scope: AdmissionScope): BatchReviewView | null {
    return this.reviews.get(id, this.reviewPolicy(scope));
  }

  /** 线按范围的策略算：一个仓库、一个产品按它那层，全部按全局。 */
  reviewPolicy(scope: AdmissionScope) {
    return this.pipeline.policyOf(scope.kind === "all" ? { kind: "global" } : scope);
  }

  /** 全部接受（向导的「全部接受」和规矩页的「全部接受推荐」）。 */
  accept(target?: LessonTarget, opts: { origin?: BatchOrigin } = {}): AcceptOutcome & BatchOutcome {
    const out = acceptPlan({ ...this.d, pipeline: this.pipeline, batches: this.d.batches }, target, opts);
    this.d.notify?.();
    return { ...out, affected: out.confirmed + out.merged, skipped: 0 };
  }

  /**
   * 人改了一条规矩的分类：之前是流水线分的（有分类理由）就记一个校准样本；还是候选的话按新分类重判这一条
   * （闸门 1、2 不看分类，不重做；只重做普遍性、覆盖、清晰度、打分和草稿）。
   */
  async onClassified(lessonId: number, before: LessonCheckability | null, after: LessonCheckability | null, beforeReason: string | null): Promise<void> {
    const l = this.d.repo.get(lessonId);
    if (!l) return;
    if (before !== null && beforeReason !== null && before !== after) {
      this.d.db
        .prepare(`INSERT INTO score_calibration (entity, lesson_id, entity_id, auto_verdict, human_verdict, score, score_parts, at, source) VALUES ('checkability', ?, ?, ?, ?, ?, ?, ?, 'override')`)
        .run(lessonId, lessonId, before, after ?? "none", l.score, l.scoreParts === null ? null : JSON.stringify(l.scoreParts), this.d.now());
    }
    if (!isCandidate(l) || l.mergedInto !== null) return;
    const scope: AdmissionScope = l.scope.kind === "repo" ? { kind: "repo", slug: l.scope.slug } : { kind: "product", productId: l.scope.productId };
    try {
      await this.pipeline.judge(scope, { only: [lessonId], skipDedupe: true, kind: "admission_rejudge", origin: "manual" });
      this.d.notify?.();
    } catch (e) {
      this.d.log?.(`lesson ${lessonId}: re-judging after a category change failed`, e);
    }
  }

  /** 分析加了或命中了规矩：开了自动准入就（防抖之后）判那个仓库。 */
  scheduleAuto(slug: string, delayMs = AUTO_ADMIT_DEBOUNCE_MS): void {
    if (!this.d.autoAdmitEnabled?.()) return;
    const prev = this.timers.get(slug);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(slug);
      void this.autoAdmit(slug);
    }, delayMs);
    t.unref?.();
    this.timers.set(slug, t);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * 自动准入：判那个仓库（计划批次 origin auto，只推荐）；策略 admission.autoConfirm 开着而且抽查没越线时，
   * 再以 origin auto 接受这次推荐的。同一个仓库同时只跑一次。
   */
  async autoAdmit(slug: string): Promise<void> {
    const key = `repo:${slug}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const r = await this.judge({ kind: "repo", slug }, { origin: "auto" });
      const autoConfirm = this.pipeline.policyOf({ kind: "repo", slug })["admission.autoConfirm"] === true;
      if (autoConfirm && r.reviewId !== null && !this.review(r.reviewId, { kind: "repo", slug })?.blocked) {
        const ids = r.verdicts.filter((v) => v.verdict === "admit" || v.verdict === "merged").map((v) => v.lessonId);
        const keepers = r.verdicts.filter((v) => v.verdict === "merged" && v.ref !== null).map((v) => v.ref!);
        if (ids.length) this.accept({ ids: [...new Set([...ids, ...keepers])] }, { origin: "auto" });
      }
    } catch (e) {
      this.d.log?.(`automatic admission for ${slug} failed`, e);
    } finally {
      this.busy.delete(key);
    }
  }
}
