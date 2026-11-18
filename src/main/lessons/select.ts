import { MAX_SESSION_LESSONS, type Lesson, type LessonProductSuggestion, type LessonProductView, type SessionLesson } from "../../shared/lessons";
import type { LessonsRepo } from "../db/lessons-repo";
import type { RepoIdentity } from "./repo-identity";

/** 出现次数降序，再最后出现时间降序，再 id 升序。 */
const byRank = (a: Lesson, b: Lesson): number => b.hits - a.hits || b.lastSeenAt - a.lastSeenAt || a.id - b.id;

/** 这些 slug 的仓库规矩和所属产品规矩（已确认，按产品去重），带上 label，已排好序。 */
function confirmedFor(repo: LessonsRepo, slugs: string[]): { lesson: Lesson; label: string }[] {
  const out: { lesson: Lesson; label: string }[] = [];
  const products = new Map<number, string>();
  for (const slug of slugs) {
    for (const lesson of repo.lessons({ status: ["confirmed"], scope: { kind: "repo", slug } })) out.push({ lesson, label: slug });
    for (const p of repo.productsOf(slug)) products.set(p.id, p.name);
  }
  for (const [productId, name] of products) {
    for (const lesson of repo.lessons({ status: ["confirmed"], scope: { kind: "product", productId } })) out.push({ lesson, label: name });
  }
  return out.sort((a, b) => byRank(a.lesson, b.lesson));
}

/** 这些仓库路径 → slug（去重、去掉解析不出的）→ 仓库的规矩和这些仓库所属产品的规矩，只要 confirmed；排序后取前 limit 条。 */
export function sessionLessons(repo: LessonsRepo, identity: RepoIdentity, repoPaths: string[], limit = MAX_SESSION_LESSONS): SessionLesson[] {
  const slugs = [...new Set(repoPaths.map((p) => identity.slugOf(p)).filter((s): s is string => !!s))];
  return confirmedFor(repo, slugs)
    .slice(0, limit)
    .map(({ lesson, label }) => ({ label, text: lesson.text }));
}

/** 只开这一个仓库时，已确认的规矩（仓库的加上所属产品的）超过 limit 的条数。 */
export function overflowFor(repo: LessonsRepo, slug: string, limit = MAX_SESSION_LESSONS): number {
  return Math.max(0, confirmedFor(repo, [slug]).length - limit);
}

/** 同一个 ticket 或 feature 里一起出现过 ≥2 次的仓库组合（按 slug），已经全在同一个产品里的不算。 */
export function productSuggestions(groups: string[][], products: LessonProductView[]): LessonProductSuggestion[] {
  const counts = new Map<string, { slugs: string[]; together: number }>();
  for (const g of groups) {
    const slugs = [...new Set(g)].sort();
    if (slugs.length < 2) continue;
    const key = JSON.stringify(slugs);
    const c = counts.get(key);
    if (c) c.together++;
    else counts.set(key, { slugs, together: 1 });
  }
  return [...counts.values()]
    .filter((c) => c.together >= 2 && !products.some((p) => c.slugs.every((s) => p.slugs.includes(s))))
    .sort((a, b) => b.together - a.together || a.slugs.join(",").localeCompare(b.slugs.join(",")));
}

/** 送规矩出错（数据库、解析 slug）时只是这次不带规矩，不能连累整份 session 说明。 */
export function safeSessionLessons(repo: LessonsRepo, identity: RepoIdentity, repoPaths: string[], log?: (msg: string, err?: unknown) => void): SessionLesson[] {
  try {
    return sessionLessons(repo, identity, repoPaths);
  } catch (e) {
    log?.("session lessons failed, guide goes without them", e);
    return [];
  }
}

/** 仓库档案里的「踩过的坑」（工作流 E2）：这个仓库和所属产品已确认的规矩，排好序的前 limit 条文字。 */
export function pitfallsFor(repo: LessonsRepo, slug: string, limit = 5): string[] {
  return confirmedFor(repo, [slug]).slice(0, limit).map(({ lesson }) => lesson.text);
}
