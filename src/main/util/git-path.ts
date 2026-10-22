import { absolutePathEntries, findOnPath } from "../claude/locate";

/** 每个 git 调用都带上：仓库配置里的 fsmonitor 钩子能执行任意程序（计划 3 遗留）。 */
export const GIT_SAFE_ARGS = ["-c", "core.fsmonitor=false"];

/**
 * git 的绝对路径：只在 PATH 的绝对目录里找。Windows 上直接执行 "git" 会先在当前目录找 git.exe，
 * 在一个自带 git.exe 的仓库里建 ticket 就会执行它；只认 git.exe（git.cmd 要经 cmd.exe）。找不到时返回 null。
 */
export function resolveGit(pathValue: string, platform: NodeJS.Platform, exists?: (p: string) => boolean): string | null {
  return findOnPath("git", absolutePathEntries(pathValue, platform), platform, ".EXE", exists);
}

export class GitUnavailableError extends Error {
  constructor() {
    super("git not found; install Git for Windows or set PATH");
  }
}

/** null：没找到 git 且在 Windows 上，拒绝执行（裸 "git" 会先在当前目录里找）。 */
let binary: string | null = "git";
let resolved = false;
let warned = false;

export function setGitBinary(p: string): void {
  binary = p;
  resolved = true;
}

/** 测试用：回到“还没解析过”的初始状态。 */
export function resetGitBinary(): void {
  binary = "git";
  resolved = false;
  warned = false;
}

/**
 * 记录一次解析结果。找到了就（重新）采用它，登录 shell 的 PATH 可以覆盖更早的结果；没找到时不会降级已有的结果。
 * 一直没找到：Windows 上拒绝执行 git，其他平台退回裸 "git"；整个进程只警告一次。
 */
export function applyGitResolution(found: string | null, platform: NodeJS.Platform, log: (msg: string) => void): void {
  if (found) {
    setGitBinary(found);
    return;
  }
  if (resolved) return;
  binary = platform === "win32" ? null : "git";
  if (!warned) {
    warned = true;
    log(platform === "win32" ? "git not found on PATH: git operations are disabled" : "git not found on PATH: falling back to plain git");
  }
}

/** 抛 GitUnavailableError 表示不能执行 git。 */
export function gitBinary(): string {
  if (binary === null) throw new GitUnavailableError();
  return binary;
}
