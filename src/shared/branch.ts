/**
 * 分支名模板（设计文档 4.1、2026-10-26）。渲染进程也用它显示预览：这里不能 import Node 模块。
 * 占位符：{key}（ticket 号原样）、{key_lower}（小写）、{title}（标题的 slug）。
 */

const TITLE_SLUG_MAX = 50;

/** 标题转成分支名里的一段：小写，非 a-z0-9 换成 -，合并、去掉首尾的 -，最长 50。没有可用的字符时是空串。 */
export function titleSlug(title: string | null | undefined): string {
  const slug = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, TITLE_SLUG_MAX).replace(/-+$/, "");
}

/**
 * 代入模板。{title} 为空时连同它旁边的一个分隔符一起去掉（{key_lower}-{title} → dms-1234，feature/{title}/{key} → feature/A-1）；
 * 别的地方原样保留，模板本身的问题（例如以 - 开头）留给校验去发现。
 */
export function renderBranch(template: string, key: string, title?: string | null): string {
  const slug = titleSlug(title);
  const filled = slug
    ? template.replaceAll("{title}", slug)
    : template.replace(/[-/]\{title\}|\{title\}[-/]?/g, "");
  return filled.replaceAll("{key_lower}", key.toLowerCase()).replaceAll("{key}", key);
}
