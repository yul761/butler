import {
  LESSON_ADMISSIONS, LESSON_CHECKABILITIES, LESSON_STATUSES,
  type Lesson, type LessonAdmission, type LessonCheckability, type LessonStatus,
} from "./lessons";

/** 可检查性筛选多一个「还没分类」。 */
export type LessonCheckabilityFilter = LessonCheckability | "unclassified";

/**
 * 批量动作和页面筛选共用的条件（契约 4.4）：每一项都可不给，给了的全部满足才算命中。合并过的行永远不命中。
 * slug / productId 只认规矩自己的归属（仓库规矩 / 产品规矩），不把仓库所属产品的规矩算进来。
 */
export interface LessonFilter {
  slug?: string;
  productId?: number;
  status?: LessonStatus[];
  admission?: LessonAdmission[];
  checkability?: LessonCheckabilityFilter[];
  shelvedReason?: string[];
  minHits?: number;
  minScore?: number;
  maxScore?: number;
  /** 可验证性分项（F 的回测）的范围；没有这一项的不命中。 */
  minVerifiability?: number;
  maxVerifiability?: number;
  /** true：可检查、但没有回测结果（分数封顶的）；false：有回测结果的。 */
  untested?: boolean;
  batchId?: number;
  /** 正文或理由里包含（不分大小写）。 */
  text?: string;
  degraded?: boolean;
  /**
   * 只算 id 不大于它的（页面发批量动作时带上它看到的最大 id）：
   * 点下去之前后台新分析出来的规矩不会被一起改掉。
   */
  maxId?: number;
}

export function matchesLessonFilter(l: Lesson, f: LessonFilter): boolean {
  if (l.mergedInto !== null) return false;
  if (f.slug !== undefined && !(l.scope.kind === "repo" && l.scope.slug === f.slug)) return false;
  if (f.productId !== undefined && !(l.scope.kind === "product" && l.scope.productId === f.productId)) return false;
  if (f.status && !f.status.includes(l.status)) return false;
  if (f.admission && !f.admission.includes(l.admission)) return false;
  if (f.checkability && !f.checkability.includes(l.checkability ?? "unclassified")) return false;
  if (f.shelvedReason && !(l.shelvedReason !== null && f.shelvedReason.includes(l.shelvedReason))) return false;
  if (f.minHits !== undefined && l.hits < f.minHits) return false;
  if (f.minScore !== undefined && (l.score === null || l.score < f.minScore)) return false;
  if (f.maxScore !== undefined && (l.score === null || l.score > f.maxScore)) return false;
  const v = l.scoreParts?.verifiability?.value;
  if (f.minVerifiability !== undefined && (v === undefined || v < f.minVerifiability)) return false;
  if (f.maxVerifiability !== undefined && (v === undefined || v > f.maxVerifiability)) return false;
  if (f.untested !== undefined) {
    const checkable = l.checkability === "checkable" || l.checkability === "converted";
    if (f.untested ? !(checkable && v === undefined) : v === undefined) return false;
  }
  if (f.batchId !== undefined && l.batchId !== f.batchId) return false;
  if (f.maxId !== undefined && l.id > f.maxId) return false;
  if (f.degraded !== undefined && l.degraded !== f.degraded) return false;
  if (f.text !== undefined && f.text.trim() !== "") {
    const q = f.text.trim().toLowerCase();
    if (!l.text.toLowerCase().includes(q) && !l.why.toLowerCase().includes(q)) return false;
  }
  return true;
}

/** 一个条件都没给（等于「全部」）：页面上要多一步确认。 */
export function isEmptyLessonFilter(f: LessonFilter): boolean {
  return Object.values(f).every((v) => v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "string" && v.trim() === ""));
}

const FILTER_TEXT_LIMIT = 500;
const intIn = (v: unknown, min: number): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw new Error("invalid lesson filter");
  return v;
};
const scoreIn = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new Error("invalid lesson filter");
  return v;
};
function listOf<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v) || v.length > allowed.length) throw new Error("invalid lesson filter");
  for (const x of v) if (!allowed.includes(x as T)) throw new Error("invalid lesson filter");
  return [...new Set(v as T[])];
}

/** 从 IPC 来的筛选条件：不认识的键、类型不对的值都拒绝。 */
export function parseLessonFilter(v: unknown): LessonFilter {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid lesson filter");
  const o = v as Record<string, unknown>;
  const allowedKeys = ["slug", "productId", "status", "admission", "checkability", "shelvedReason", "minHits", "minScore", "maxScore", "minVerifiability", "maxVerifiability", "untested", "batchId", "text", "degraded", "maxId"];
  for (const k of Object.keys(o)) if (!allowedKeys.includes(k)) throw new Error("invalid lesson filter");
  const f: LessonFilter = {};
  if (o.slug !== undefined) {
    if (typeof o.slug !== "string" || !o.slug || o.slug.length > 300) throw new Error("invalid lesson filter");
    f.slug = o.slug;
  }
  if (o.productId !== undefined) f.productId = intIn(o.productId, 1);
  if (o.status !== undefined) f.status = listOf(o.status, LESSON_STATUSES);
  if (o.admission !== undefined) f.admission = listOf(o.admission, LESSON_ADMISSIONS);
  if (o.checkability !== undefined) f.checkability = listOf(o.checkability, [...LESSON_CHECKABILITIES, "unclassified"] as const);
  if (o.shelvedReason !== undefined) {
    if (!Array.isArray(o.shelvedReason) || o.shelvedReason.length > 50 || o.shelvedReason.some((x) => typeof x !== "string" || x.length > 100)) throw new Error("invalid lesson filter");
    f.shelvedReason = o.shelvedReason as string[];
  }
  if (o.minHits !== undefined) f.minHits = intIn(o.minHits, 0);
  if (o.minScore !== undefined) f.minScore = scoreIn(o.minScore);
  if (o.maxScore !== undefined) f.maxScore = scoreIn(o.maxScore);
  if (o.minVerifiability !== undefined) f.minVerifiability = scoreIn(o.minVerifiability);
  if (o.maxVerifiability !== undefined) f.maxVerifiability = scoreIn(o.maxVerifiability);
  if (o.untested !== undefined) {
    if (typeof o.untested !== "boolean") throw new Error("invalid lesson filter");
    f.untested = o.untested;
  }
  if (o.batchId !== undefined) f.batchId = intIn(o.batchId, 1);
  if (o.maxId !== undefined) f.maxId = intIn(o.maxId, 0);
  if (o.text !== undefined) {
    if (typeof o.text !== "string" || o.text.length > FILTER_TEXT_LIMIT) throw new Error("invalid lesson filter");
    f.text = o.text;
  }
  if (o.degraded !== undefined) {
    if (typeof o.degraded !== "boolean") throw new Error("invalid lesson filter");
    f.degraded = o.degraded;
  }
  return f;
}
