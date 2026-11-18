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

  private calibrate(ctxBatch: { lesson: Lesson; human: Verdict; auto: Verdict | null }[], batchId: number | null, now: number): void {
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
        r.remove(l.id);
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
          ctx.track("lesson", l.id);
          this.change(verb, l, now, opts.keepAdmission ?? false);
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
    const base: LessonFilter = { status: ["pending"], admission: ["auto"] };
    const t: LessonTarget = !target ? { filter: base } : "ids" in target ? target : { filter: { ...target.filter, ...base } };
    if ("ids" in t) {
      const ids = this.resolve(t).filter((l) => l.status === "pending" && l.admission === "auto").map((l) => l.id);
      return this.bulk("confirm", { ids }, { kind: "accept_recommended", keepAdmission: true });
    }
    return this.bulk("confirm", t, { kind: "accept_recommended", keepAdmission: true });
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

  private single(kind: string, id: number, fn: (ctx: BatchContext) => void): LessonActResult {
    const { outcome } = this.d.recorder.run({ kind, origin: "manual", entity: "lesson", scope: { ids: 1 }, now: this.d.now() }, (ctx) => {
      ctx.track("lesson", id);
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
    const r = this.single("delete", id, () => this.repo.remove(id));
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
      for (const m of this.repo.lessons({ includeMerged: true }).filter((x) => x.mergedInto === dropId)) ctx.track("lesson", m.id);
      this.repo.merge(keepId, dropId, text, now);
    });
  }
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
