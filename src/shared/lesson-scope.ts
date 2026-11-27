// 规矩的适用范围（scopeGlobs / scopeLang）怎么对文件：预审、session 说明的补送 hook、lessons 工具共用一份。
// 纯函数，不引 Node 模块：hook 打包时也带上它。
import { inScope } from "./glob";

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

export interface LessonScopeFields {
  scopeGlobs: readonly string[];
  scopeLang: string | null;
}

/** 这条规矩适不适用于这些文件（路径相对仓库根；scopeGlobs 和 scopeLang 都要满足）。 */
export function lessonApplies(l: LessonScopeFields, files: readonly string[]): boolean {
  if (files.length === 0) return false;
  const lang = l.scopeLang?.trim().toLowerCase();
  const exts = lang ? (LANG_EXTS[lang] ?? [lang]) : null;
  return files.some((f) => inScope(f, l.scopeGlobs) && (!exts || exts.includes(extOf(f))));
}

/** 有没有限定范围：没有 glob、也没有语言的规矩在整个仓库都适用。 */
export const lessonScoped = (l: LessonScopeFields): boolean => l.scopeGlobs.length > 0 || !!l.scopeLang?.trim();
