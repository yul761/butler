import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { GIT_SAFE_ARGS, gitBinary } from "../util/git-path";
import { gitEnv } from "../tickets/git";

/** 栈操作用的 git 调用：参数数组、不经 shell、带超时、不弹凭据提示。非零退出不抛（调用方看 code）。 */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOpts {
  env?: Record<string, string>;
  timeoutMs?: number;
  /** 放在子命令前的 -c 之类。 */
  pre?: string[];
}

export class StackGitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

export const GIT_TIMEOUT_MS = 30_000;
export const NET_TIMEOUT_MS = 60_000;
export const REBASE_TIMEOUT_MS = 120_000;

export function runGit(cwd: string, args: string[], o: GitOpts = {}): Promise<GitResult> {
  return new Promise((done, fail) => {
    let bin: string;
    try {
      bin = gitBinary();
    } catch (e) {
      fail(new StackGitError((e as Error).message, ""));
      return;
    }
    const env = { ...gitEnv(process.env), GIT_TERMINAL_PROMPT: "0", ...o.env };
    execFile(
      bin,
      [...GIT_SAFE_ARGS, ...(o.pre ?? []), ...args],
      { cwd, env, windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: o.timeoutMs ?? GIT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        if (e && typeof e.code !== "number") {
          fail(new StackGitError(e.killed ? `git ${args[0]} timed out` : e.message, String(stderr)));
          return;
        }
        done({ code: e ? Number(e.code) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** 成功返回去掉首尾空白的 stdout，失败抛 StackGitError。 */
export async function gitOk(cwd: string, args: string[], o: GitOpts = {}): Promise<string> {
  const r = await runGit(cwd, args, o);
  if (r.code !== 0) throw new StackGitError(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`, r.stderr);
  return r.stdout.trim();
}

// ---- 版本 ----

export function parseGitVersion(out: string): [number, number] | null {
  const m = /git version (\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function supportsUpdateRefs(v: [number, number] | null): boolean {
  return v !== null && (v[0] > 2 || (v[0] === 2 && v[1] >= 38));
}

let versionCache: Promise<[number, number] | null> | null = null;

/** 本机 git 的版本（进程内缓存；读不到为 null，按不支持 --update-refs 处理）。 */
export function gitVersion(): Promise<[number, number] | null> {
  versionCache ??= runGit(process.cwd(), ["--version"]).then((r) => parseGitVersion(r.stdout)).catch(() => null);
  return versionCache;
}

// ---- 查询 ----

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * 几个完整的 ref 一次读（BTL-275：栈 tick 原来每层、trunk 各起一个 rev-parse）。只认完全相同的名字（for-each-ref 的模式按前缀和通配匹配，
 * 结果再按名字过滤）；名字里有通配符的单独 revParse。标签取它指向的提交，同 revParse 的 ^{commit}。不存在的不在结果里。
 */
export async function refTips(cwd: string, refs: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const plain = [...new Set(refs.filter((r) => !/[*?[\\]/.test(r)))];
  for (const r of refs.filter((x) => !plain.includes(x))) {
    const sha = await revParse(cwd, r);
    if (sha) out.set(r, sha);
  }
  if (plain.length === 0) return out;
  const want = new Set(plain);
  const lines = await gitOk(cwd, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(*objectname)%09%(objecttype)%09%(*objecttype)", ...plain]);
  for (const line of lines.split(/\r?\n/)) {
    const [name, sha, peeled, type, peeledType] = line.split("\t");
    if (!name || !want.has(name)) continue;
    if (type === "commit") out.set(name, sha!);
    else if (peeledType === "commit") out.set(name, peeled!);
  }
  return out;
}

/** a 是不是 b 的祖先（相等也算）。 */
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  const r = await runGit(cwd, ["merge-base", "--is-ancestor", a, b]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new StackGitError(`git merge-base --is-ancestor failed: ${r.stderr.trim()}`, r.stderr);
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  const r = await runGit(cwd, ["merge-base", a, b]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** 分支 → 检出它的 worktree 目录（主检出也算）。 */
export async function worktreeBranches(cwd: string): Promise<Map<string, string>> {
  const out = await gitOk(cwd, ["worktree", "list", "--porcelain"]);
  return parseWorktreeList(out);
}

export function parseWorktreeList(out: string): Map<string, string> {
  const map = new Map<string, string>();
  let path: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && path) map.set(line.slice("branch refs/heads/".length), resolve(path));
    else if (line === "") path = null;
  }
  return map;
}

export async function unmergedFiles(cwd: string): Promise<string[]> {
  const out = await gitOk(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  return [...new Set(out.split("\0").filter(Boolean))];
}

/** 已跟踪的文件有没有改动（未跟踪的不算：reset --keep 不碰它们）。 */
export async function trackedDirty(cwd: string): Promise<boolean> {
  const out = await gitOk(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return out.length > 0;
}

/**
 * 把检出从 from 换到 to 时会被盖掉的未跟踪文件（reset --keep 会拒绝）：from..to 之间改动过的路径里、这个目录下没被跟踪的。
 */
export async function untrackedInTheWay(cwd: string, from: string, to: string): Promise<string[]> {
  const changed = new Set((await gitOk(cwd, ["diff", "--name-only", "--no-renames", from, to])).split(/\r?\n/).filter(Boolean));
  if (changed.size === 0) return [];
  const untracked = (await gitOk(cwd, ["ls-files", "--others", "--exclude-standard", "--full-name"])).split(/\r?\n/).filter(Boolean);
  return untracked.filter((f) => changed.has(f));
}

export async function treeOf(cwd: string, commit: string): Promise<string> {
  return gitOk(cwd, ["rev-parse", `${commit}^{tree}`]);
}

/** from..to 的提交标题，从旧到新。 */
export async function subjects(cwd: string, from: string | null, to: string): Promise<string[]> {
  const out = await gitOk(cwd, ["log", "--format=%s", "--reverse", "--no-merges", from ? `${from}..${to}` : to, "-n", "200"]);
  return out ? out.split(/\r?\n/) : [];
}

/** tip 落后 trunk 多少个提交，以及最早那个没合进来的提交的提交时间（毫秒）。 */
export async function behind(cwd: string, tip: string, trunk: string): Promise<{ commits: number; oldestAt: number | null }> {
  const n = Number(await gitOk(cwd, ["rev-list", "--count", `${tip}..${trunk}`])) || 0;
  if (n === 0) return { commits: 0, oldestAt: null };
  const out = await gitOk(cwd, ["log", "--format=%ct", "--reverse", `${tip}..${trunk}`]);
  const first = out.split(/\r?\n/)[0];
  return { commits: n, oldestAt: first ? Number(first) * 1000 : null };
}

export async function hasFixups(cwd: string, from: string, to: string): Promise<boolean> {
  const s = await subjects(cwd, from, to);
  return s.some((x) => /^(fixup|squash|amend)! /.test(x));
}

/** trunk 跟的 remote（`branch.<trunk>.remote`），没有就 origin。 */
export async function remoteFor(cwd: string, trunk: string): Promise<string> {
  const r = await runGit(cwd, ["config", "--get", `branch.${trunk}.remote`]);
  const v = r.code === 0 ? r.stdout.trim() : "";
  return v && v !== "." ? v : "origin";
}

export async function remoteTip(cwd: string, remote: string, branch: string): Promise<string | null> {
  return revParse(cwd, `refs/remotes/${remote}/${branch}`);
}

// ---- 写 ----

export async function fetchRemote(cwd: string, remote: string): Promise<GitResult> {
  return runGit(cwd, ["fetch", "--prune", "--quiet", remote], { timeoutMs: NET_TIMEOUT_MS });
}

/** CAS：只有 ref 现在等于 old（null = 现在不存在）才改成 next。 */
export async function updateRefCas(cwd: string, ref: string, next: string, old: string | null): Promise<void> {
  await gitOk(cwd, ["update-ref", ref, next, old ?? "0000000000000000000000000000000000000000"]);
}

export async function deleteRef(cwd: string, ref: string): Promise<void> {
  await runGit(cwd, ["update-ref", "-d", ref]);
}

/**
 * 推一个分支：推的是 sha 这个提交（查过冲突标记的那个，BTL-278），不是推的那一刻分支指着的提交（查和推之间 session 可能又提交了）。
 * expected 为远端现在的提交时用 --force-with-lease（只在远端还是它时覆盖）；
 * expected 为 null 时远端还没有这个分支：普通 push，再设上游（session 之后 git push 直接能用；推的是 sha，git 自己的 --set-upstream 不管用）。
 */
export async function pushBranch(cwd: string, remote: string, branch: string, expected: string | null, sha: string): Promise<void> {
  const spec = `${sha}:refs/heads/${branch}`;
  const args = expected
    ? ["push", "--porcelain", `--force-with-lease=refs/heads/${branch}:${expected}`, remote, spec]
    : ["push", "--porcelain", remote, spec];
  await gitOk(cwd, args, { timeoutMs: NET_TIMEOUT_MS });
  if (expected) return;
  // 设不上不算推送失败（已经推上去了）
  await gitOk(cwd, ["config", `branch.${branch}.remote`, remote]).catch(() => undefined);
  await gitOk(cwd, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]).catch(() => undefined);
}

/** 列出某个前缀下的引用。 */
export async function refsUnder(cwd: string, prefix: string): Promise<{ ref: string; sha: string }[]> {
  const out = await gitOk(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [ref, sha] = l.split(" ");
      return { ref: ref!, sha: sha! };
    });
}
