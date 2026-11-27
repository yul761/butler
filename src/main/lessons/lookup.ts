import type { DripRoot } from "../../shared/lesson-drip";
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

export interface LookupResult {
  lessons: LookupLesson[];
  /** 筛完、截断之前有几条。 */
  total: number;
  truncated: boolean;
}

/** 文件在哪个仓库：绝对路径按目录找（最长的优先）；相对路径在每个仓库里都算一遍（多仓库 ticket 最好给绝对路径）。 */
function resolvePaths(paths: readonly string[], roots: readonly DripRoot[], fold: boolean): { slug: string; rel: string }[] {
  const out: { slug: string; rel: string }[] = [];
  const key = (p: string) => (fold ? p.toLowerCase() : p);
  for (const raw of paths) {
    const abs = /^([a-zA-Z]:)?[\\/]/.test(raw);
    if (!abs) {
      const rel = normalizePath(raw);
      for (const r of roots) out.push({ slug: r.slug, rel });
      continue;
    }
    const f = normalizePath(raw);
    let best: { slug: string; rel: string; len: number } | null = null;
    for (const r of roots) {
      for (const dir of r.dirs) {
        const d = normalizePath(dir).replace(/\/+$/, "");
        if (!d || !key(f).startsWith(`${key(d)}/`) || (best && best.len >= d.length)) continue;
        best = { slug: r.slug, rel: f.slice(d.length + 1), len: d.length };
      }
    }
    if (best) out.push({ slug: best.slug, rel: best.rel });
  }
  return out;
}

/**
 * lessons 工具（BTL-274）：这个 ticket 的仓库（和所属产品）已确认的规矩全文，按 paths（适用范围，仓库对上才算）和 query（关键词或 #编号）筛。
 * 送法和开 session 时同一套算法。
 */
export function lookupLessons(
  repo: LessonsRepo, identity: RepoIdentity, repoPaths: string[], roots: DripRoot[],
  q: { paths?: string[]; query?: string }, opts: GuideLessonOptions = {}, platform: NodeJS.Platform = process.platform,
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
  const files = q.paths?.length ? resolvePaths(q.paths, roots, platform === "win32" || platform === "darwin") : null;
  const query = q.query?.trim() ?? "";
  const idQuery = /^#?(\d+)$/.exec(query);
  const words = idQuery ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
  const order = new Map(ids.map((id, i) => [id, i]));
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
  return { lessons: out.slice(0, LOOKUP_MAX), total: out.length, truncated: out.length > LOOKUP_MAX };
}
