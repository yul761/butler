import { inScope } from "../../shared/glob";
import type { Lesson } from "../../shared/lessons";
import type { LessonsRepo } from "../db/lessons-repo";

/** 预审最多带多少条规矩（设计 §4.3）。 */
export const PRE_REVIEW_MAX_LESSONS = 300;

/** scopeLang（分析时写的短名，如 ts、py、sql）→ 扩展名。没列的语言按「扩展名就是它」。 */
const LANG_EXTS: Record<string, string[]> = {
  ts: ["ts", "tsx", "mts", "cts"], typescript: ["ts", "tsx", "mts", "cts"], js: ["js", "jsx", "mjs", "cjs"], javascript: ["js", "jsx", "mjs", "cjs"],
  py: ["py", "pyi"], python: ["py", "pyi"], go: ["go"], rust: ["rs"], rs: ["rs"], java: ["java"], kotlin: ["kt", "kts"], kt: ["kt", "kts"],
  csharp: ["cs"], cs: ["cs"], ruby: ["rb"], rb: ["rb"], php: ["php"], swift: ["swift"], sql: ["sql"], css: ["css", "scss", "sass", "less"],
  html: ["html", "htm"], shell: ["sh", "bash", "zsh"], sh: ["sh", "bash", "zsh"], yaml: ["yml", "yaml"], md: ["md", "mdx"], markdown: ["md", "mdx"],
};

const extOf = (p: string): string => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/** 这条规矩适不适用于这些改动的文件（scopeGlobs 和 scopeLang 都要满足）。 */
export function lessonApplies(l: Pick<Lesson, "scopeGlobs" | "scopeLang">, files: readonly string[]): boolean {
  if (files.length === 0) return false;
  const lang = l.scopeLang?.trim().toLowerCase();
  const exts = lang ? (LANG_EXTS[lang] ?? [lang]) : null;
  return files.some((f) => inScope(f, l.scopeGlobs) && (!exts || exts.includes(extOf(f))));
}

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
