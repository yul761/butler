import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lang } from "../../shared/i18n";

/** ticket：ticket session 和修复 session；coordinator：ticket 总控、feature 总控、epic session。 */
export type GuideKind = "ticket" | "coordinator";

/** 每段一个函数，按语言返回一段文字（返回 null 表示这个 kind 不需要）；后续计划往里加段落。 */
export const GUIDE_SECTIONS: Array<(lang: Lang, kind: GuideKind) => string | null> = [
  (lang) =>
    lang === "zh"
      ? "Butler 会在后台盯着你的 PR 和 CI。push 之后不要循环查 CI（不要 gh run watch、gh pr checks --watch、sleep 轮询），直接结束这一轮；CI 跑完后 Butler 会把结果发给你。"
      : "Butler watches your PR and CI in the background. After you push, do not poll CI (no gh run watch, gh pr checks --watch, or sleep loops); just end your turn. Butler will send you the result when CI finishes.",
];

export function sessionGuide(lang: Lang, kind: GuideKind): string {
  return GUIDE_SECTIONS.map((s) => s(lang, kind)).filter((s): s is string => !!s).join("\n\n") + "\n";
}

/** 写到 <mcpDir>/guide-<kind>-<lang>.md；内容没变就不重写，返回路径。 */
export function writeSessionGuide(mcpDir: string, lang: Lang, kind: GuideKind): string {
  const file = join(mcpDir, `guide-${kind}-${lang}.md`);
  const text = sessionGuide(lang, kind);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return file;
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(file, text);
  return file;
}
