import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitBinary, GIT_SAFE_ARGS } from "../util/git-path";
import { parseRemoteSlug } from "../../shared/repo-slug";

export { parseRemoteSlug };

/** remote（默认 origin）的 URL；确定没有这个 remote 时返回 null（git 退出码 2）。超时、找不到 git、不是仓库等其他失败都抛出，不当成结论。 */
export function defaultGit(path: string, exec: typeof execFileSync = execFileSync, remote = "origin"): string | null {
  try {
    return exec(gitBinary(), [...GIT_SAFE_ARGS, "-C", path, "remote", "get-url", remote], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    if ((e as { status?: unknown }).status === 2) return null;
    throw e;
  }
}

/**
 * 仓库路径 -> 仓库身份（来自 origin remote；remoteSlugsOf 另外看 upstream）。成功的结果、“确定没有 origin”和“存在但不是 git 仓库”按路径缓存，app 运行期间不过期；路径不存在、超时和出错不缓存。
 * 给的是改名后的名字（canonical，BTL-261）：仓库在 GitHub 上改了名，本地 origin 还是旧名字也照样能用，不能让各处按旧名字再写进库里。缓存的是 remote 原样的。
 */
export class RepoIdentity {
  private readonly git: (path: string) => string | null;
  private readonly upstreamGit: (path: string) => string | null;
  private readonly exists: (p: string) => boolean;
  private readonly cache = new Map<string, string | null>();
  private readonly upstreamCache = new Map<string, string | null>();
  private canonical: (slug: string) => string;

  constructor(d: { git?: (path: string) => string | null; upstreamGit?: (path: string) => string | null; exists?: (p: string) => boolean; canonical?: (slug: string) => string } = {}) {
    this.canonical = d.canonical ?? ((s) => s);
    this.git = d.git ?? defaultGit;
    this.upstreamGit = d.upstreamGit ?? ((p) => defaultGit(p, execFileSync, "upstream"));
    this.exists = d.exists ?? existsSync;
  }

  /** 改名服务建好以后接上（它自己要用 slugOf，所以后建）。 */
  useCanonical(canonical: (slug: string) => string): void {
    this.canonical = canonical;
  }

  slugOf(path: string): string | null {
    const s = this.remoteSlug(path, this.cache, this.git);
    return s === null ? null : this.canonical(s);
  }

  /** origin remote 原样的 slug（不换成改名后的）。 */
  rawSlugOf(path: string): string | null {
    return this.remoteSlug(path, this.cache, this.git);
  }

  /** origin 和 upstream 的 slug（有几个给几个，去重）：fork 的工作流里 PR 开在 upstream 上。 */
  remoteSlugsOf(path: string): string[] {
    const out: string[] = [];
    const up = this.remoteSlug(path, this.upstreamCache, this.upstreamGit);
    for (const s of [this.slugOf(path), up === null ? null : this.canonical(up)]) if (s && !out.includes(s)) out.push(s);
    return out;
  }

  private remoteSlug(path: string, cache: Map<string, string | null>, git: (path: string) => string | null): string | null {
    if (cache.has(path)) return cache.get(path) ?? null;
    if (!this.exists(path)) return null; // 路径不在（比如外接盘没挂上）：不缓存，也不起 git。
    if (!this.exists(join(path, ".git"))) {
      cache.set(path, null); // 存在但不是 git 仓库：不用起 git，直接记下。
      return null;
    }
    let url: string | null;
    try {
      url = git(path);
    } catch {
      return null; // 超时或出错：这次没结果，但不缓存，下次再查。
    }
    const slug = url ? parseRemoteSlug(url) : null;
    cache.set(path, slug);
    return slug;
  }

  /** 页面用：解析不出时说明原因。 */
  resolve(path: string): { slug: string } | { reason: "no_remote" | "not_git" } {
    const slug = this.slugOf(path);
    if (slug) return { slug };
    return { reason: this.exists(join(path, ".git")) ? "no_remote" : "not_git" };
  }
}
