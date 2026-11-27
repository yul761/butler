import { locateInRoots, type DripRoot } from "../../shared/lesson-drip";
import type { LessonDelivery } from "../../shared/lessons";
import { lessonApplies } from "../../shared/lesson-scope";
import { normalizePath } from "../../shared/glob";
import type { LessonsRepo } from "../db/lessons-repo";
import type { RepoIdentity } from "./repo-identity";
import { guidePlan, type GuideLessonOptions } from "./select";

/** lessons 工具一次最多回几条（再多叫它缩小范围）。 */
export const LOOKUP_MAX = 60;

export interface LookupLesson {
  id: number;
  /** 仓库 slug 或产品名。 */
  label: string;
  text: string;
  why: string;
  scope: { globs: string[]; lang: string | null };
  /** 这个 session 里它怎么送到。 */
  delivery: LessonDelivery;
  /** 它归进的原则（有的话）。 */
  principle?: string;
  /** 给了 paths 时：它适用于哪几个（仓库 slug:相对路径）。 */
  matched?: string[];
}

const DELIVERY_RANK: Record<string, number> = { index: 0, drip: 1, principle: 2, full: 3, check: 4 };

export interface LookupResult {
  lessons: LookupLesson[];
  /** 筛完、截断之前有几条。 */
  total: number;
  truncated: boolean;
  /** 认不出属于哪个仓库的路径（相对路径又不在任何一个仓库的目录里）：换成绝对路径再查。 */
  unresolved?: string[];
}

/**
 * 文件在哪个仓库：按目录找（最长的优先）。相对路径按调用的 session 的工作目录（cwd）补成绝对路径；
 * 只有一个仓库时也可以直接算在它头上。认不出的不猜（多仓库 ticket 里同名相对路径不能把别的仓库的规矩带进来），放进 unresolved。
 */
function resolvePaths(
  paths: readonly string[], roots: readonly DripRoot[], platform: NodeJS.Platform, cwd: string | undefined,
): { files: { slug: string; rel: string }[]; unresolved: string[] } {
  const files: { slug: string; rel: string }[] = [];
  const unresolved: string[] = [];
  const isAbs = (p: string) => /^([a-zA-Z]:)?[\\/]/.test(p);
  const locate = (abs: string) => locateInRoots(abs, roots, platform);
  const slugs = [...new Set(roots.map((r) => r.slug))];
  for (const raw of paths) {
    let at: { slug: string; rel: string } | null = null;
    if (isAbs(raw)) at = locate(raw);
    else {
      if (cwd && isAbs(cwd)) at = locate(`${normalizePath(cwd).replace(/\/+$/, "")}/${normalizePath(raw).replace(/^\.\//, "")}`);
      if (!at && slugs.length === 1) at = { slug: slugs[0], rel: normalizePath(raw).replace(/^\.\//, "") };
    }
    if (at) files.push(at);
    else unresolved.push(raw);
  }
  return { files, unresolved };
}

/**
 * lessons 工具（BTL-274）：这个 ticket 的仓库（和所属产品）已确认的规矩全文，按 paths（适用范围，仓库对上才算）和 query（关键词或 #编号）筛。
 * 送法和开 session 时同一套算法。
 */
export function lookupLessons(
  repo: LessonsRepo, identity: RepoIdentity, repoPaths: string[], roots: DripRoot[],
  q: { paths?: string[]; query?: string; cwd?: string }, opts: GuideLessonOptions = {}, platform: NodeJS.Platform = process.platform,
): LookupResult {
  const plan = guidePlan(repo, identity, repoPaths, opts);
  const ids = [...plan.modes.keys()];
  const lessons = repo.lessons({ ids });
  const principleTexts = repo.principleTexts(lessons.flatMap((l) => (l.principleId !== null ? [l.principleId] : [])));
  const slugs = roots.map((r) => r.slug);
  const productSlugs = new Map<number, string[]>();
  for (const slug of slugs) for (const p of repo.productsOf(slug)) productSlugs.set(p.id, [...(productSlugs.get(p.id) ?? []), slug]);
  const labels = new Map<number, string>();
  for (const p of repo.products()) labels.set(p.id, p.name);
  const resolved = q.paths?.length ? resolvePaths(q.paths, roots, platform, q.cwd) : null;
  const files = resolved?.files ?? null;
  const query = q.query?.trim() ?? "";
  const idQuery = /^#?(\d+)$/.exec(query);
  const words = idQuery ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
  // 说明里没写全文的排前面（截断时先丢的是 session 已经看过全文的），同一种送法里按说明的顺序。
  const order = new Map(ids.map((id, i) => [id, (DELIVERY_RANK[plan.modes.get(id) ?? "full"] ?? 0) * 1e6 + i]));
  const out: LookupLesson[] = [];
  for (const l of [...lessons].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))) {
    if (idQuery && l.id !== Number(idQuery[1])) continue;
    if (words.length) {
      const hay = `${l.text}\n${l.why}\n${l.scopeGlobs.join(" ")}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    let matched: string[] | undefined;
    if (files) {
      const own = l.scope.kind === "repo" ? [l.scope.slug] : (productSlugs.get(l.scope.productId) ?? []);
      matched = files.filter((f) => own.includes(f.slug) && lessonApplies(l, [f.rel])).map((f) => `${f.slug}:${f.rel}`);
      if (matched.length === 0) continue;
    }
    const principle = l.principleId !== null ? principleTexts.get(l.principleId)?.text : undefined;
    out.push({
      id: l.id,
      label: l.scope.kind === "repo" ? l.scope.slug : (labels.get(l.scope.productId) ?? String(l.scope.productId)),
      text: l.text,
      why: l.why,
      scope: { globs: l.scopeGlobs, lang: l.scopeLang },
      delivery: plan.modes.get(l.id) ?? "full",
      ...(principle !== undefined && { principle }),
      ...(matched && { matched }),
    });
  }
  return {
    lessons: out.slice(0, LOOKUP_MAX), total: out.length, truncated: out.length > LOOKUP_MAX,
    ...(resolved && resolved.unresolved.length > 0 && { unresolved: resolved.unresolved }),
  };
}
