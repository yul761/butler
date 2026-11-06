import { absolutePathEntries, findOnPath } from "../claude/locate";

/**
 * gh 的绝对路径，和 resolveGit 一样只在 PATH 的绝对目录里找：从 Finder / Dock 打开的 Butler 的 PATH 里通常没有 Homebrew，
 * 裸 "gh" 找不到；Windows 上裸 "gh" 还会先在当前目录里找。只认 gh.exe。找不到时返回 null。
 */
export function resolveGh(pathValue: string, platform: NodeJS.Platform, exists?: (p: string) => boolean): string | null {
  return findOnPath("gh", absolutePathEntries(pathValue, platform), platform, ".EXE", exists);
}
