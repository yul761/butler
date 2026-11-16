import type { Lesson, LessonProductView, LessonsState } from "../../shared/lessons";

export type LessonsSelection = { kind: "repo"; slug: string } | { kind: "product"; id: number };

/** 左侧列表：每个产品一组（下面缩进列出它的仓库），然后是不属于任何产品的仓库；一个仓库属于多个产品时，在每个产品下面都出现。 */
export function lessonsTree(s: LessonsState): Array<{ product: LessonProductView | null; slugs: string[] }> {
  const inProduct = new Set(s.products.flatMap((p) => p.slugs));
  const tree: Array<{ product: LessonProductView | null; slugs: string[] }> = s.products.map((p) => ({ product: p, slugs: p.slugs }));
  const loose = s.repos.map((r) => r.slug).filter((slug) => !inProduct.has(slug));
  if (loose.length > 0) tree.push({ product: null, slugs: loose });
  return tree;
}

/** 选中的仓库或产品自己的规矩，分成待确认和已确认（含停用的，停用的排在最后）。 */
export function lessonsFor(s: LessonsState, sel: LessonsSelection): { pending: Lesson[]; confirmed: Lesson[] } {
  const mine = s.lessons.filter((l) =>
    sel.kind === "repo" ? l.scope.kind === "repo" && l.scope.slug === sel.slug : l.scope.kind === "product" && l.scope.productId === sel.id,
  );
  const live = mine.filter((l) => l.status === "confirmed");
  const off = mine.filter((l) => l.status === "disabled");
  return { pending: mine.filter((l) => l.status === "pending"), confirmed: [...live, ...off] };
}
