import type { Lang } from "../../shared/i18n";

/**
 * watcher 和 dev server 的仓库级规则（WS-M I，设计 §10）：给 E2 的仓库档案留的钩子。
 * - "end"：休眠时结束这个仓库的 watcher 和 dev server，session 说明里也加一句「别让它们一直跑着」；
 * - "keep"：休眠时留着它们；
 * - null：没有规定，按设置 hibernateEndWatchers。
 * 默认没有注册（全部 null）；E2 只需要调 setWatcherPolicy。
 */
export type WatcherPolicy = "end" | "keep" | null;

let policy: (repoPath: string) => WatcherPolicy = () => null;

export function setWatcherPolicy(fn: ((repoPath: string) => WatcherPolicy) | null): void {
  policy = fn ?? (() => null);
}

/** 这个仓库的规定；注册的函数抛错时当作没有规定。 */
export function watcherPolicy(repoPath: string): WatcherPolicy {
  try {
    return policy(repoPath);
  } catch {
    return null;
  }
}

/** 休眠时结束不结束 watcher：仓库有规定按规定，没有按设置。 */
export function endWatchersOnHibernate(repoPaths: string[], setting: boolean): boolean {
  const rules = repoPaths.map(watcherPolicy);
  if (rules.includes("end")) return true;
  if (rules.length > 0 && rules.every((r) => r === "keep")) return false;
  return setting;
}

/** 仓库规定 "end" 时 session 说明里加的那一句；否则 null。 */
export function watcherGuideLine(lang: Lang, repoPath: string): string | null {
  if (watcherPolicy(repoPath) !== "end") return null;
  return lang === "zh"
    ? "这个仓库不要让 watch 模式的命令（vitest、tsc -w、nodemon 这类）或 dev server 一直在后台跑：测试和类型检查用一次性的命令，dev server 用完就停掉。"
    : "In this repo, do not leave watch-mode commands (vitest, tsc -w, nodemon and the like) or dev servers running in the background: run tests and type checks once, and stop a dev server when you are done with it.";
}

/** 几个仓库的说明行，去重。 */
export function watcherGuideLines(lang: Lang, repoPaths: string[]): string[] {
  return [...new Set(repoPaths.map((p) => watcherGuideLine(lang, p)).filter((l): l is string => l !== null))];
}
