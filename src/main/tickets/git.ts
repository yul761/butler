import { execFile } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ScanResult } from "../../shared/types";
import { GIT_SAFE_ARGS, gitBinary } from "../util/git-path";

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

/**
 * git 的报错消息用英文：gitErrorSummary 按 fatal: / error: 前缀解析。只改 LC_MESSAGES，
 * 其他分类（钩子、凭据助手等）保持用户自己的 locale；LANGUAGE 会被 gettext 优先采用，所以去掉。
 * 不碰用户自己设置的 LC_ALL。
 */
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LC_MESSAGES: "C" };
  delete env.LANGUAGE;
  return env;
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    let bin: string;
    try {
      bin = gitBinary();
    } catch (e) {
      fail(new GitError((e as Error).message, ""));
      return;
    }
    execFile(bin, [...GIT_SAFE_ARGS, ...args], { cwd, env: gitEnv(process.env), windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new GitError(`git ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`, String(stderr)));
      else done(String(stdout).trim());
    });
  });
}

/** git 在 Windows 上返回正斜杠路径，resolve 统一成本平台格式。 */
export async function repoRoot(dir: string): Promise<string> {
  return resolve(await git(dir, ["rev-parse", "--show-toplevel"]));
}

/** dir 自己就是 git 仓库的根目录（不是在别的仓库里面的普通目录）。 */
async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    // git 给的是真实路径：经过 symlink 的目录要先展开再比。
    return (await repoRoot(dir)) === resolve(await realpath(dir));
  } catch {
    return false;
  }
}

/**
 * 选目录时用（设计文档 2026-10-26）：dir 在仓库里 → 那个仓库的根目录；不在 → 它下一层里的仓库（不进隐藏目录，按名字排序）；
 * 下一层也没有 → none。
 */
export async function scanRepos(dir: string): Promise<ScanResult> {
  try {
    return { kind: "repo", root: await repoRoot(dir) };
  } catch {
    // 不是仓库：往下找一层。
  }
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return { kind: "none" };
  }
  const repos: string[] = [];
  for (const name of names.sort()) {
    const child = join(resolve(dir), name);
    if (await isRepoRoot(child)) repos.push(child);
  }
  return repos.length > 0 ? { kind: "parent", repos } : { kind: "none" };
}

export function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain"])).length > 0;
}

/** 新建分支时从 start 开始（省略就是当前 HEAD）。 */
export async function addWorktree(repo: string, path: string, branch: string, createBranch: boolean, start?: string): Promise<void> {
  await git(repo, createBranch ? ["worktree", "add", "-b", branch, path, ...(start ? [start] : [])] : ["worktree", "add", path, branch]);
}

/** 让 worktree 离开它的分支（HEAD 停在同一个提交上），分支就能在别处检出；目录和里面的文件原样保留。 */
export async function detachHead(cwd: string): Promise<void> {
  await git(cwd, ["checkout", "--detach"]);
}

/**
 * 有没有未提交的改动或未跟踪的文件，不管用户的 status.showUntrackedFiles 怎么设（设成 no 时普通的 status 看不到未跟踪文件）。
 * 被 .gitignore 忽略的不算。
 */
export async function hasLocalChanges(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain", "--untracked-files=all"])).length > 0;
}

/**
 * 删掉一个 worktree（目录和登记）。不加 --force：有改动或未跟踪文件时 git 会拒绝；git 自己的这道检查也读 status.showUntrackedFiles，
 * 这里强制成 normal，免得未跟踪文件被当成干净的一起删掉。分支保留。
 */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ["-c", "status.showUntrackedFiles=normal", "worktree", "remove", path]);
}

/** 清掉目录已经不在了的 worktree 登记，否则在同一路径上重新 add 会被 git 拒绝。 */
export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

/** 在 cwd 里切到 branch；分支不存在时从当前 HEAD 新建。 */
export async function switchTo(cwd: string, branch: string, create: boolean, start?: string): Promise<void> {
  await git(cwd, create ? ["checkout", "-b", branch, ...(start ? [start] : [])] : ["checkout", branch]);
}

/** HEAD 上不属于任何分支的提交数（游离 HEAD 上新做的提交）。离开这个 HEAD 之后它们只剩 reflog 能找到。 */
export async function unbranchedCommits(cwd: string): Promise<number> {
  const out = await git(cwd, ["rev-list", "--count", "HEAD", "--not", "--branches"]);
  return Number(out) || 0;
}

/**
 * path 是不是 repo 登记过的 worktree（不含主工作区）。git 在 Windows 上给的是正斜杠路径，resolve 后再比；
 * Windows 的路径不分大小写。
 */
export async function isWorktreeOf(repo: string, path: string): Promise<boolean> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const want = norm(path);
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .slice(1)
    .some((l) => norm(l.slice("worktree ".length)) === want);
}

export async function createBranch(cwd: string, branch: string, start?: string): Promise<void> {
  await git(cwd, ["branch", branch, ...(start ? [start] : [])]);
}

export async function checkout(cwd: string, branch: string): Promise<void> {
  await git(cwd, ["checkout", branch]);
}

/** 仓库是否至少有一个提交。空仓库没有 HEAD，建分支和 worktree 都会失败。 */
export async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 用 git 自己的规则校验分支名。`git check-ref-format --branch` 会把 `@{-1}` 这类写法展开成别的分支，
 * 所以输出必须和输入完全相同才算合法；以 `-` 开头的名字会被当成选项，直接拒绝。
 */
export async function isValidBranchName(cwd: string, name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;
  try {
    return (await git(cwd, ["check-ref-format", "--branch", name])) === name;
  } catch {
    return false;
  }
}

export const GIT_SUMMARY_LIMIT = 300;

/** git 报错里给用户看的那一句：第一行 fatal:/error: 的原因，去掉前缀，最多 300 字符。 */
export function gitErrorSummary(e: GitError): string {
  const lines = e.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? e.message;
  return line.replace(/^(fatal|error):\s*/i, "").slice(0, GIT_SUMMARY_LIMIT);
}
