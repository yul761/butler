import { lessonApplies } from "../../shared/lesson-scope";
import type { Lesson } from "../../shared/lessons";
import type { LessonsRepo } from "../db/lessons-repo";

/** 预审最多带多少条规矩（设计 §4.3）。 */
export const PRE_REVIEW_MAX_LESSONS = 300;

export { lessonApplies };

/**
 * 这些仓库（和它们所属产品）的已确认规矩里，和改动相关的（设计 §0）：去掉 converted（已由检查管）和合并掉的，
 * 按出现次数排，最多 300 条。total 是筛完、截断之前的条数。
 */
export function relevantLessons(repo: LessonsRepo, slugs: readonly string[], files: readonly string[], max = PRE_REVIEW_MAX_LESSONS): { lessons: Lesson[]; total: number } {
  const seen = new Set<number>();
  const all: Lesson[] = [];
  const productIds = new Set<number>();
  const add = (l: Lesson) => {
    if (seen.has(l.id) || l.mergedInto !== null || l.checkability === "converted") return;
    seen.add(l.id);
    if (lessonApplies(l, files)) all.push(l);
  };
  for (const slug of slugs) {
    for (const l of repo.lessons({ status: ["confirmed"], scope: { kind: "repo", slug } })) add(l);
    for (const p of repo.productsOf(slug)) productIds.add(p.id);
  }
  for (const productId of productIds) for (const l of repo.lessons({ status: ["confirmed"], scope: { kind: "product", productId } })) add(l);
  all.sort((a, b) => b.hits - a.hits || b.lastSeenAt - a.lastSeenAt || a.id - b.id);
  return { lessons: all.slice(0, max), total: all.length };
}
