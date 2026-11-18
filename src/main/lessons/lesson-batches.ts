import type { Db } from "../db/database";
import type { LessonsRepo } from "../db/lessons-repo";
import { BatchRecorder, type BatchContext, type Snapshot } from "../batches/batch-recorder";
import { matchesLessonFilter, type LessonFilter } from "../../shared/lesson-filter";
import { MAX_TARGET_IDS, type Lesson, type LessonActResult, type LessonBulkVerb, type LessonTarget } from "../../shared/lessons";
import type { BatchOrigin, BatchOutcome } from "../../shared/batches";

export { MAX_TARGET_IDS };

export type Verdict = "admit" | "shelve" | "reject";

/** 一条规矩现在的「判断」：确认了或被推荐 = admit，搁置 = shelve，拒绝 / 停用 / 删掉 = reject；还待定返回 null。 */
export function verdictOf(s: { status?: unknown; admission?: unknown } | null): Verdict | null {
  if (s === null) return "reject";
  if (s.status === "rejected" || s.status === "disabled") return "reject";
  if (s.admission === "shelved") return "shelve";
  if (s.status === "confirmed" || s.admission === "auto") return "admit";
  return null;
}

export interface LessonBatchDeps {
  db: Db;
  repo: LessonsRepo;
  recorder: BatchRecorder;
  now: () => number;
  /** 准入策略的某一层被改了（撤销恢复了策略、删产品连带删了它的策略层）：策略版本要加一。 */
  onPolicyChanged?: () => void;
  /** 检查被改了（撤销恢复了检查、删产品连带删了它的检查）：重写 hook 读的快照（契约 4.5）。 */
  onChecksChanged?: () => void;
}

/**
 * 删一条规矩，连同合并进它的那些（merged_into 是 ON DELETE SET NULL：只删保留的那条，合并进去的会重新冒出来）。
 * 合并进去的先记：撤销倒着恢复，保留的那条先回来，合并进去的再指回它。
 */
export function removeLessonTracked(ctx: BatchContext, repo: LessonsRepo, id: number): void {
  const merged = repo.mergedIds(id);
  for (const m of merged) ctx.track("lesson", m);
  ctx.track("lesson", id);
  for (const m of merged) repo.remove(m);
  repo.remove(id);
}

const NOT_FOUND = { ok: false as const, reason: "not_found" };

/**
 * 规矩的批量动作（契约 4.4）：每个动作一个事务、一个可撤销的批次。
 * 单条动作（确认、拒绝、停用、删除、编辑、合并）也走这里，所以页面上的每次改动都能撤销。
 */
export class LessonBatchService {
  constructor(private readonly d: LessonBatchDeps) {}

  private get repo(): LessonsRepo {
    return this.d.repo;
  }

  /** 解析目标：合并过的行从不命中；id 列表里不存在的忽略。在事务里调用，数量和改动不会对不上。 */
  resolve(target: LessonTarget): Lesson[] {
    if ("ids" in target) {
      if (target.ids.length > MAX_TARGET_IDS) throw new Error("too many ids");
      return this.repo.lessons({ ids: [...new Set(target.ids)] });
    }
    return this.repo.lessons().filter((l) => matchesLessonFilter(l, target.filter));
  }

  /** 页面预览：命中多少、其中真会变的多少。 */
  preview(verb: LessonBulkVerb, target: LessonTarget): { matched: number; changes: number } {
    const all = this.resolve(target);
    return { matched: all.length, changes: all.filter((l) => this.applies(verb, l)).length };
  }

  private applies(verb: LessonBulkVerb, l: Lesson): boolean {
    switch (verb) {
      case "confirm":
        return l.status === "pending";
      case "reject":
        return l.status !== "rejected";
      case "disable":
        return l.status === "confirmed";
      case "enable":
        return l.status === "disabled";
      case "delete":
        return true;
    }
  }

  /** 记校准样本（人对流水线结论的判断）；规矩准入的「全部接受」也用它（工作流 D）。 */
  calibrate(ctxBatch: { lesson: Lesson; human: Verdict; auto: Verdict | null }[], batchId: number | null, now: number): void {
    if (batchId === null) return;
    const ins = this.d.db.prepare(
      `INSERT INTO score_calibration (entity, lesson_id, entity_id, auto_verdict, human_verdict, score, score_parts, batch_id, at) VALUES ('lesson', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of ctxBatch) {
      if (c.auto === null || c.auto === c.human) continue;
      const exists = this.repo.get(c.lesson.id) !== null;
      ins.run(exists ? c.lesson.id : null, c.lesson.id, c.auto, c.human, c.lesson.score, c.lesson.scoreParts === null ? null : JSON.stringify(c.lesson.scoreParts), batchId, now);
    }
  }

  /** 人推翻了流水线的判断吗：被推荐 / 自动准入的拒掉，或搁置的确认了。 */
  private overridden(l: Lesson, human: Verdict): { lesson: Lesson; human: Verdict; auto: Verdict | null } {
    const auto = l.admission === "auto" ? "admit" : l.admission === "shelved" ? "shelve" : null;
    return { lesson: l, human, auto };
  }

  private change(verb: LessonBulkVerb, l: Lesson, now: number, keepAdmission: boolean): void {
    const r = this.repo;
    switch (verb) {
      case "confirm":
        r.setStatus(l.id, "confirmed", now);
        if (!keepAdmission) r.setFields(l.id, { admission: "manual", shelvedReason: null, shelvedRef: null }, now);
        return;
      case "reject":
        r.setStatus(l.id, "rejected", now);
        r.setFields(l.id, { admission: "manual" }, now);
        return;
      case "disable":
        r.setStatus(l.id, "disabled", now);
        return;
      case "enable":
        r.setStatus(l.id, "confirmed", now);
        return;
      case "delete":
        // 由调用方的 removeLessonTracked 删（要先记下合并进来的行）。
        return;
    }
  }

  private humanVerdict(verb: LessonBulkVerb): Verdict | null {
    return verb === "confirm" || verb === "enable" ? "admit" : verb === "reject" || verb === "disable" || verb === "delete" ? "reject" : null;
  }

  /** 批量确认 / 拒绝 / 停用 / 启用 / 删除。已经是目标状态的跳过并计数。 */
  bulk(verb: LessonBulkVerb, target: LessonTarget, opts: { origin?: BatchOrigin; kind?: string; keepAdmission?: boolean; extra?: (ctx: BatchContext, l: Lesson) => void } = {}): BatchOutcome {
    const now = this.d.now();
    const cal: { lesson: Lesson; human: Verdict; auto: Verdict | null }[] = [];
    const { outcome } = this.d.recorder.run(
      { kind: opts.kind ?? verb, origin: opts.origin ?? "manual", entity: "lesson", scope: "ids" in target ? { ids: target.ids.length } : { filter: target.filter }, now },
      (ctx) => {
        for (const l of this.resolve(target)) {
          if (!this.applies(verb, l)) {
            ctx.skip();
            continue;
          }
          if (verb === "delete") removeLessonTracked(ctx, this.repo, l.id);
          else {
            ctx.track("lesson", l.id);
            this.change(verb, l, now, opts.keepAdmission ?? false);
          }
          opts.extra?.(ctx, l);
          const human = this.humanVerdict(verb);
          if (human && (opts.origin ?? "manual") === "manual") cal.push(this.overridden(l, human));
        }
      },
    );
    this.calibrate(cal, outcome.batchId, now);
    return outcome;
  }

  /** 接受全部推荐：待确认而且流水线推荐（admission = auto）的全部确认，admission 留着 auto。target 再缩小范围。 */
  acceptRecommended(target?: LessonTarget): BatchOutcome {
    const t = recommendedTarget(target);
    if ("ids" in t) return this.bulk("confirm", { ids: this.recommendedTargets(target).map((l) => l.id) }, { kind: "accept_recommended", keepAdmission: true });
    return this.bulk("confirm", t, { kind: "accept_recommended", keepAdmission: true });
  }

  /** 「接受全部推荐」会确认的那些。 */
  recommendedTargets(target?: LessonTarget): Lesson[] {
    return this.resolve(recommendedTarget(target)).filter((l) => l.status === "pending" && l.admission === "auto");
  }

  /** 推荐了多少（按钮上的数）。 */
  recommendedCount(filter: LessonFilter = {}): number {
    return this.repo.lessons({ status: ["pending"] }).filter((l) => l.admission === "auto" && matchesLessonFilter(l, filter)).length;
  }

  /** 整批撤销。撤销的是自动批次时，每条恢复的规矩记一个校准样本（人推翻了流水线）。 */
  undo(batchId: number): LessonActResult {
    const now = this.d.now();
    const r = this.d.recorder.undo(batchId, now);
    if (!r.ok) return r;
    if (r.restored.some((x) => x.entity === "policy")) this.d.onPolicyChanged?.();
    if (r.restored.some((x) => x.entity === "check" || x.entity === "product")) this.d.onChecksChanged?.();
    if (r.original.origin === "auto") {
      const cal: { lesson: Lesson; human: Verdict; auto: Verdict | null }[] = [];
      for (const x of r.restored) {
        if (x.entity !== "lesson") continue;
        const auto = verdictOf(x.before as Snapshot | null);
        const human = verdictOf(x.after as Snapshot | null) ?? "reject";
        const l = this.repo.get(x.id) ?? snapshotLesson(x.before as Snapshot | null, x.id);
        if (l) cal.push({ lesson: l, human, auto });
      }
      this.calibrate(cal, r.outcome.batchId ?? batchId, now);
    }
    return { ok: true, batchId: r.outcome.batchId, affected: r.outcome.affected, skipped: r.outcome.skipped };
  }

  // ---- 单条动作：形状和检查跟以前一样，只是也记批次。

  private live(id: number): Lesson | null {
    const l = this.repo.get(id);
    return l && l.mergedInto === null ? l : null;
  }

  private single(kind: string, id: number, fn: (ctx: BatchContext) => void, summary?: Record<string, unknown>): LessonActResult {
    const { outcome } = this.d.recorder.run({ kind, origin: "manual", entity: "lesson", scope: { ids: 1 }, summary, now: this.d.now() }, (ctx) => {
      if (kind !== "delete") ctx.track("lesson", id);
      fn(ctx);
    });
    return { ok: true, batchId: outcome.batchId, affected: outcome.affected, skipped: outcome.skipped };
  }

  confirmOne(id: number, text?: string): LessonActResult {
    const l = this.live(id);
    if (!l) return NOT_FOUND;
    // 只有待确认的能确认：已拒绝或已停用的不能靠这个翻回来。
    if (l.status !== "pending") return { ok: false, reason: "bad_status" };
    const now = this.d.now();
    const r = this.single("confirm", id, () => {
      if (text !== undefined) this.repo.setText(id, text, now);
      this.change("confirm", l, now, false);
    });
    this.calibrate([this.overridden(l, "admit")], r.ok ? (r.batchId ?? null) : null, now);
    return r;
  }

  rejectOne(id: number): LessonActResult {
    const l = this.live(id);
    if (!l) return NOT_FOUND;
    const now = this.d.now();
    const r = this.single("reject", id, () => this.change("reject", l, now, false));
    this.calibrate([this.overridden(l, "reject")], r.ok ? (r.batchId ?? null) : null, now);
    return r;
  }

  editOne(id: number, text: string): LessonActResult {
    if (!this.live(id)) return NOT_FOUND;
    const now = this.d.now();
    return this.single("edit", id, () => this.repo.setText(id, text, now));
  }

  setDisabledOne(id: number, disabled: boolean): LessonActResult {
    const l = this.live(id);
    if (!l) return NOT_FOUND;
    // 只在已确认和停用之间切换：待确认的不能靠这个绕过确认。
    if (l.status !== "confirmed" && l.status !== "disabled") return { ok: false, reason: "bad_status" };
    const now = this.d.now();
    const r = this.single(disabled ? "disable" : "enable", id, () => this.repo.setStatus(id, disabled ? "disabled" : "confirmed", now));
    if (disabled) this.calibrate([this.overridden(l, "reject")], r.ok ? (r.batchId ?? null) : null, now);
    return r;
  }

  deleteOne(id: number): LessonActResult {
    const l = this.live(id);
    if (!l) return NOT_FOUND;
    const now = this.d.now();
    const r = this.single("delete", id, (ctx) => removeLessonTracked(ctx, this.repo, id));
    this.calibrate([this.overridden(l, "reject")], r.ok ? (r.batchId ?? null) : null, now);
    return r;
  }

  mergeOne(keepId: number, dropId: number, text: string): LessonActResult {
    if (keepId === dropId) return { ok: false, reason: "same_lesson" };
    const keep = this.live(keepId);
    const drop = this.live(dropId);
    if (!keep || !drop) return NOT_FOUND;
    if (!sameScope(keep, drop)) return { ok: false, reason: "scope_mismatch" };
    const now = this.d.now();
    return this.single("merge", keepId, (ctx) => {
      ctx.track("lesson", dropId);
      // 已经合并进 drop 的那些也会改指向 keep：一起记下，撤销时改回来。
      for (const m of this.repo.mergedIds(dropId)) ctx.track("lesson", m);
      this.repo.merge(keepId, dropId, text, now);
      // 合并的两边要一起撤销：只撤一半会留下重复的规矩和加过的次数。
    }, { atomic: true });
  }

  /**
   * 删一个产品（连同它的规矩、合并进去的行和它的策略层，外键会连带删掉）：一个批次，可以撤销。
   * 先记规矩和策略层、最后记产品：撤销倒着恢复，产品先回来。
   */
  deleteProduct(productId: number): LessonActResult {
    if (!this.repo.product(productId)) return NOT_FOUND;
    const now = this.d.now();
    let policy = false;
    const { outcome } = this.d.recorder.run({ kind: "delete_product", origin: "manual", entity: "product", scope: { productId }, now }, (ctx) => {
      for (const l of this.repo.lessons({ scope: { kind: "product", productId }, includeMerged: true })) ctx.track("lesson", l.id);
      const layer = this.d.db.prepare(`SELECT id FROM admission_policies WHERE scope_kind = 'product' AND product_id = ?`).get(productId) as { id: number } | undefined;
      if (layer) {
        ctx.track("policy", Number(layer.id));
        policy = true;
      }
      for (const c of this.d.db.prepare(`SELECT id FROM checks WHERE scope_kind = 'product' AND product_id = ?`).all(productId) as { id: number }[]) ctx.track("check", Number(c.id));
      ctx.track("product", productId);
      this.repo.deleteProduct(productId);
    });
    if (policy) this.d.onPolicyChanged?.();
    this.d.onChecksChanged?.();
    return { ok: true, batchId: outcome.batchId, affected: outcome.affected, skipped: outcome.skipped };
  }
}

function recommendedTarget(target?: LessonTarget): LessonTarget {
  const base: LessonFilter = { status: ["pending"], admission: ["auto"] };
  return !target ? { filter: base } : "ids" in target ? target : { filter: { ...target.filter, ...base } };
}

export const sameScope = (a: Lesson, b: Lesson): boolean =>
  a.scope.kind === "repo" ? b.scope.kind === "repo" && a.scope.slug === b.scope.slug : b.scope.kind === "product" && a.scope.productId === b.scope.productId;

/** 行已经不在了（撤销把它删了）：从快照里取校准需要的字段。 */
function snapshotLesson(s: Snapshot | null, id: number): Lesson | null {
  if (!s) return null;
  let parts: Lesson["scoreParts"];
  try {
    parts = typeof s.score_parts === "string" ? (JSON.parse(s.score_parts) as Lesson["scoreParts"]) : null;
  } catch {
    parts = null;
  }
  return { id, score: typeof s.score === "number" ? s.score : null, scoreParts: parts } as Lesson;
}
