import { absolutePathEntries, findOnPath } from "../claude/locate";

/** 每个 git 调用都带上：仓库配置里的 fsmonitor 钩子能执行任意程序（计划 3 遗留）。 */
export const GIT_SAFE_ARGS = ["-c", "core.fsmonitor=false"];

let binary = "git";

/**
 * git 的绝对路径：只在 PATH 的绝对目录里找。Windows 上直接执行 "git" 会先在当前目录找 git.exe，
 * 在一个自带 git.exe 的仓库里建 ticket 就会执行它；只认 git.exe（git.cmd 要经 cmd.exe）。找不到时返回 null。
 */
export function resolveGit(pathValue: string, platform: NodeJS.Platform, exists?: (p: string) => boolean): string | null {
  return findOnPath("git", absolutePathEntries(pathValue, platform), platform, ".EXE", exists);
}

export function setGitBinary(p: string): void {
  binary = p;
}

export function gitBinary(): string {
  return binary;
}
