import { execFile } from "node:child_process";
import { resolve } from "node:path";
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

export async function addWorktree(repo: string, path: string, branch: string, createBranch: boolean): Promise<void> {
  await git(repo, createBranch ? ["worktree", "add", "-b", branch, path] : ["worktree", "add", path, branch]);
}

export async function createBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ["branch", branch]);
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
