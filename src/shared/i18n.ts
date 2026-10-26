/**
 * 界面语言（设计文档 2026-10-26 中英文切换）。渲染进程也会 import：这里不能 import Node 模块。
 */
export type Lang = "zh" | "en";

/** 设置 language 的取值：auto 跟系统语言。 */
export const LANG_SETTINGS = ["auto", "zh", "en"] as const;
export type LangSetting = (typeof LANG_SETTINGS)[number];

const isLang = (v: string | undefined): v is Lang => v === "zh" || v === "en";

/**
 * 当前语言：环境变量 BUTLER_LANG（zh / en）优先，其次是设置；设置是 auto（或者坏掉了）时看系统首选语言，
 * 以 zh 开头（简体、繁体都算）就是中文，其他一律英文。
 */
export function resolveLang(setting: string, systemLocales: readonly string[], override?: string): Lang {
  if (isLang(override)) return override;
  if (isLang(setting)) return setting;
  return /^zh\b/i.test(systemLocales[0] ?? "") ? "zh" : "en";
}
