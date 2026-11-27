import { LESSON_DELIVERIES, type Lesson, type LessonDeliveryCounts, type LessonsState } from "../../shared/lessons";
import { scopeLabel } from "./lessons-view";

export interface DeliveryRow {
  slug: string;
  counts: LessonDeliveryCounts;
  overBudget: boolean;
}

/** 有已确认规矩的仓库，每个一行：单独开它的 session 时每种送法各几条（BTL-274）。 */
export function deliveryRows(s: Pick<LessonsState, "repos">): DeliveryRow[] {
  return s.repos
    .filter((r) => LESSON_DELIVERIES.some((d) => r.delivery[d] > 0))
    .map((r) => ({ slug: r.slug, counts: r.delivery, overBudget: r.overBudget }));
}

/** 合并建议里一共有几条规矩（按钮上的数）。 */
export const mergeLessonCount = (s: Pick<LessonsState, "mergeProposals">): number => s.mergeProposals.reduce((n, p) => n + p.ids.length, 0);

/** 能转成检查、还没转的已确认规矩。 */
export const checkableLessons = (s: Pick<LessonsState, "lessons">): Lesson[] => s.lessons.filter((l) => l.status === "confirmed" && l.checkability === "checkable");

/** 建议的范围名（仓库 slug 或产品名）。 */
export const proposalLabel = (p: LessonsState["mergeProposals"][number], s: Pick<LessonsState, "products">): string => scopeLabel({ scope: p.scope }, s);

/** 建议里的规矩原文（按 id 从列表里找，找不到的跳过）。 */
export const proposalMembers = (p: LessonsState["mergeProposals"][number], s: Pick<LessonsState, "lessons">): Lesson[] => {
  const byId = new Map(s.lessons.map((l) => [l.id, l]));
  return p.ids.map((id) => byId.get(id)).filter((l): l is Lesson => !!l);
};
