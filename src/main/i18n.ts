import type { Lang } from "../shared/i18n";

/**
 * 主进程的当前语言（设计文档 2026-10-26 中英文切换）：启动时和保存 language 设置之后由 index.ts 设定。
 * 默认中文：测试和老代码不设语言时行为不变。
 */
let lang: Lang = "zh";
const listeners = new Set<(l: Lang) => void>();

export function currentLang(): Lang {
  return lang;
}

export function setLang(l: Lang): void {
  if (l === lang) return;
  lang = l;
  for (const cb of listeners) cb(l);
}

export function onLangChange(cb: (l: Lang) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
