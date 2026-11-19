import { isEmptyLessonFilter, matchesLessonFilter, type LessonCheckabilityFilter, type LessonFilter } from "../../shared/lesson-filter";
import { LESSON_BULK_VERBS, type Lesson, type LessonAdmission, type LessonBulkVerb, type LessonStatus } from "../../shared/lessons";
import type { ImportMode, ImportPreview, PreviewRow, Resolution } from "../../shared/config-io";
import type { BatchView } from "../../shared/batches";
import type { UiStrings } from "./strings";

/** 页面上的筛选条件（范围另给）：空数组 / 空字符串 = 不限。 */
export interface BulkFilterUi {
  status: LessonStatus[];
  admission: LessonAdmission[];
  checkability: LessonCheckabilityFilter[];
  shelvedReason: string[];
  text: string;
  /** 下面四个是文本框里的原样输入；不合法就当没填。分数 0..1，次数和批次是正整数。 */
  minScore: string;
  maxScore: string;
  minHits: string;
  batchId: string;
  /** 可验证性（0..1，F 的回测）。 */
  minVerifiability: string;
  maxVerifiability: string;
  degradedOnly: boolean;
  untestedOnly: boolean;
}

export const EMPTY_BULK_FILTER: BulkFilterUi = {
  status: [], admission: [], checkability: [], shelvedReason: [], text: "", minScore: "", maxScore: "", minHits: "", batchId: "", minVerifiability: "", maxVerifiability: "", degradedOnly: false, untestedOnly: false,
};

/** 搁置原因的筛选项（流水线会写的那几种）。 */
export const SHELVED_REASONS = ["conflict", "generality", "low_score", "clarity", "backtest_fp", "backtest_recall", "untested", "covered", "duplicate", "below_drop"] as const;

const scoreInput = (raw: string): number | undefined => {
  const v = raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
};
const intInput = (raw: string, min: number): number | undefined => {
  const v = raw.trim() === "" ? NaN : Number(raw);
  return Number.isSafeInteger(v) && v >= min ? v : undefined;
};

/** 页面上能选的状态（state 里没有 rejected：已拒绝的不在页面上出现）。 */
export const BULK_STATUSES: readonly LessonStatus[] = ["pending", "confirmed", "disabled"];

/** 范围（左边选中的仓库 / 产品，或者全部）+ 筛选条件 → 发给主进程的 LessonFilter。 */
export function bulkFilter(base: LessonFilter, ui: BulkFilterUi): LessonFilter {
  const f: LessonFilter = { ...base };
  if (ui.status.length) f.status = [...ui.status];
  if (ui.admission.length) f.admission = [...ui.admission];
  if (ui.checkability.length) f.checkability = [...ui.checkability];
  if (ui.shelvedReason.length) f.shelvedReason = [...ui.shelvedReason];
  if (ui.text.trim()) f.text = ui.text.trim();
  const minScore = scoreInput(ui.minScore);
  if (minScore !== undefined) f.minScore = minScore;
  const maxScore = scoreInput(ui.maxScore);
  if (maxScore !== undefined) f.maxScore = maxScore;
  const minHits = intInput(ui.minHits, 0);
  if (minHits !== undefined) f.minHits = minHits;
  const batchId = intInput(ui.batchId, 1);
  if (batchId !== undefined) f.batchId = batchId;
  const minV = scoreInput(ui.minVerifiability);
  if (minV !== undefined) f.minVerifiability = minV;
  const maxV = scoreInput(ui.maxVerifiability);
  if (maxV !== undefined) f.maxVerifiability = maxV;
  if (ui.degradedOnly) f.degraded = true;
  if (ui.untestedOnly) f.untested = true;
  return f;
}

/** 每个动作真正会改的行（和主进程 LessonBatchService.applies 一致）。 */
const APPLIES: Record<LessonBulkVerb, (l: Lesson) => boolean> = {
  confirm: (l) => l.status === "pending",
  reject: (l) => l.status !== "rejected",
  disable: (l) => l.status === "confirmed",
  enable: (l) => l.status === "disabled",
  delete: () => true,
};

/**
 * 「删除全部」发出去的条件：没选状态时限定在页面上看得见的状态，
 * 不然会连带删掉页面上看不到（也没算进数字里）的已拒绝规矩。
 */
export function verbFilter(verb: LessonBulkVerb, f: LessonFilter): LessonFilter {
  return verb === "delete" && !f.status ? { ...f, status: [...BULK_STATUSES] } : f;
}

export interface BulkCounts {
  matched: number;
  verbs: Record<LessonBulkVerb, number>;
  /** 待确认、admission = auto（「接受全部推荐」）。 */
  recommended: number;
}

export function bulkCounts(lessons: Lesson[], f: LessonFilter): BulkCounts {
  const hit = lessons.filter((l) => matchesLessonFilter(l, f));
  const verbs = Object.fromEntries(LESSON_BULK_VERBS.map((v) => [v, hit.filter((l) => matchesLessonFilter(l, verbFilter(v, f)) && APPLIES[v](l)).length])) as Record<LessonBulkVerb, number>;
  return { matched: hit.length, verbs, recommended: hit.filter((l) => l.status === "pending" && l.admission === "auto").length };
}

/** 一个条件都没给（范围是全部、也没筛选）：页面上每个动作都要点两次。删除总是要点两次。 */
export function needsSecondClick(verb: LessonBulkVerb | "accept_recommended", f: LessonFilter): boolean {
  return verb === "delete" || isEmptyLessonFilter(f);
}

export type TagTone = "ok" | "warn" | "none" | "info";
export interface LessonTag {
  key: string;
  text: string;
  tone: TagTone;
  title?: string;
}

export const formatScore = (score: number): string => score.toFixed(2);

/** 规矩卡片上的小标签：准入、强度、可检查性、分数、降级模型。没填的字段不出标签。 */
export function lessonTags(l: Lesson, S: UiStrings): LessonTag[] {
  const tags: LessonTag[] = [];
  if (l.admission === "auto") tags.push({ key: "admission", text: S.admissionLabel.auto, tone: "ok" });
  if (l.admission === "shelved") {
    const why = l.shelvedReason ? (S.shelvedReasonLabel[l.shelvedReason] ?? l.shelvedReason) : null;
    tags.push({ key: "admission", text: why ? `${S.admissionLabel.shelved} · ${why}` : S.admissionLabel.shelved, tone: "warn" });
  }
  if (l.strength) tags.push({ key: "strength", text: S.strengthLabel[l.strength], tone: l.strength === "must" ? "info" : "none" });
  if (l.checkability) tags.push({ key: "checkability", text: S.checkabilityLabel[l.checkability], tone: "none" });
  if (l.score !== null) tags.push({ key: "score", text: S.lessonScoreTag(formatScore(l.score)), tone: "none" });
  if (l.degraded) tags.push({ key: "degraded", text: S.lessonDegradedTag, tone: "warn", title: S.lessonDegradedTitle(l.degradedFrom) });
  return tags;
}

/** 页面上看到的最大 id（一条都没有时 0）。 */
export const maxLessonId = (lessons: Lesson[]): number => lessons.reduce((m, l) => Math.max(m, l.id), 0);

/** 勾选里只留还在待确认列表里的。 */
export const livePicked = (picked: number[], pending: Lesson[]): number[] => {
  const ids = new Set(pending.map((l) => l.id));
  return picked.filter((id) => ids.has(id));
};

// ---- 导入预览

export const resolutionKey = (sectionId: string, fingerprint: string) => `${sectionId}:${fingerprint}`;

/** 这一行能不能选（和主进程的 decide 一致）：新增总是加；本地多出来的只有替换时才会删。 */
export function rowChoosable(row: PreviewRow, mode: ImportMode): boolean {
  if (row.status === "changed" || row.status === "conflicting") return true;
  return row.status === "removed" && mode === "replace" && row.localId !== null;
}

/** 这一行按现在的选择会怎样（和主进程 ConfigIoService.apply 的 decide 一致）。 */
export function effectiveResolution(
  sectionId: string, row: PreviewRow, mode: ImportMode, bulk: Resolution | undefined, resolutions: Record<string, Resolution>,
): Resolution {
  const own = resolutions[resolutionKey(sectionId, row.fingerprint)];
  if (own) return own;
  if (row.status === "added" || row.status === "removed") return "imported";
  return bulk ?? (mode === "replace" ? "imported" : "local");
}

/** 「全部用导入的 / 全部保留本地」：把逐行的选择清掉，只留下这一个整体选择。 */
export function applyBulkResolution(preview: ImportPreview, mode: ImportMode, choice: Resolution): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const s of preview.sections) for (const r of s.rows) if (r.status === "removed" && rowChoosable(r, mode)) out[resolutionKey(s.id, r.fingerprint)] = choice;
  return out;
}

/**
 * 按现在的选择导入后，这条规矩会从没确认变成已确认（会开始进 session）：页面上要提醒一下。
 * 只看规矩的状态冲突，并且这一行实际用的是导入的版本。
 */
export function confirmsLesson(sectionId: string, row: PreviewRow, choice: Resolution): boolean {
  if (sectionId !== "lessons" || choice !== "imported" || row.localId === null) return false;
  const d = row.diffs.find((x) => x.field === "status");
  return !!d && d.incoming === "confirmed" && d.local !== "confirmed";
}

/** 预览里一个字段的值写成一行字。 */
export function diffValue(v: unknown, none: string): string {
  if (v === null || v === undefined || v === "") return none;
  if (Array.isArray(v)) return v.length ? v.map((x) => diffValue(x, none)).join(", ") : none;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export const formatKb = (bytes: number): string => (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0);

// ---- 批次历史

/** 批次的标题：动作名；撤销批次写成「撤销：动作名」。不认识的动作照原样显示。 */
export function batchTitle(b: Pick<BatchView, "kind" | "summary" | "entity">, S: UiStrings): string {
  const name = (k: string) => S.batchKind[k] ?? k;
  if (b.kind === "undo" && typeof b.summary.kind === "string") return S.batchUndoTitle(name(b.summary.kind));
  const entity = S.batchEntity[b.entity];
  return b.entity === "lesson" || !entity ? name(b.kind) : `${name(b.kind)} · ${entity}`;
}

/** 备份文件名开头是它的种类（auto- / before-replace- / manual-）。 */
export function backupKind(name: string): "auto" | "before-replace" | "manual" {
  if (name.startsWith("before-replace-")) return "before-replace";
  return name.startsWith("auto-") ? "auto" : "manual";
}
