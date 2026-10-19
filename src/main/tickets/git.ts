import { execFile } from "node:child_process";
import { resolve } from "node:path";

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
