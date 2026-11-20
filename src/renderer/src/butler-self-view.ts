import type { LessonsState } from "../../shared/lessons";
import type { LessonsSelection } from "./lessons-view";

/** 待确认的规矩有几条（和侧边栏角标是同一个意思）。 */
export function pendingLessons(s: Pick<LessonsState, "lessons">): number {
  return s.lessons.filter((l) => l.status === "pending").length;
}

/**
 * 「逐条看」从哪里开始：先是有待确认规矩的产品，再是仓库，各按列表顺序。
 * 只返回现在还在的产品或仓库（指向已经没了的，页面会把选中丢掉）；都没有返回 null。
 */
export function firstPendingSelection(s: LessonsState): LessonsSelection | null {
  const pending = s.lessons.filter((l) => l.status === "pending");
  const product = s.products.find((p) => pending.some((l) => l.scope.kind === "product" && l.scope.productId === p.id));
  if (product) return { kind: "product", id: product.id };
  const repo = s.repos.find((r) => pending.some((l) => l.scope.kind === "repo" && l.scope.slug === r.slug));
  return repo ? { kind: "repo", slug: repo.slug } : null;
}

/** 审计里一条记录都没有（模型调用和对外动作都是 0）。 */
export function auditIsEmpty(a: { llmEntries: number; externalEntries: number }): boolean {
  return a.llmEntries === 0 && a.externalEntries === 0;
}

export const EFFECT_TABS = ["overview", "trend", "spend", "rework", "automation"] as const;
