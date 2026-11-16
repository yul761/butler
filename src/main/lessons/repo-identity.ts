import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitBinary, GIT_SAFE_ARGS } from "../util/git-path";

/** 把 git remote URL 变成 "owner/repo"（小写）；非 github.com 的主机名保留在前面。解析不出返回 null。 */
export function parseRemoteSlug(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  let host: string;
  let path: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(u);
  if (scheme) [, host, path] = scheme as unknown as [string, string, string];
  else if (scp) [, host, path] = scp as unknown as [string, string, string];
  else return null;
  const parts = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  const slug = parts.join("/").toLowerCase();
  const h = host.toLowerCase();
  return h === "github.com" ? slug : `${h}/${slug}`;
}

/** origin 的 URL；确定没有 origin remote 时返回 null（git 退出码 2）。超时、找不到 git、不是仓库等其他失败都抛出，不当成结论。 */
function defaultGit(path: string): string | null {
  try {
    return execFileSync(gitBinary(), [...GIT_SAFE_ARGS, "-C", path, "remote", "get-url", "origin"], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    if ((e as { status?: unknown }).status === 2) return null;
    throw e;
  }
}

/** 仓库路径 -> 仓库身份（来自 origin remote）。成功的结果和“确定没有 origin”按路径缓存，app 运行期间不过期；超时和出错不缓存。 */
export class RepoIdentity {
  private readonly git: (path: string) => string | null;
  private readonly cache = new Map<string, string | null>();

  constructor(d: { git?: (path: string) => string | null } = {}) {
    this.git = d.git ?? defaultGit;
  }

  slugOf(path: string): string | null {
    if (this.cache.has(path)) return this.cache.get(path) ?? null;
    let url: string | null;
    try {
      url = this.git(path);
    } catch {
      return null; // 超时或出错：这次没结果，但不缓存，下次再查。
    }
    const slug = url ? parseRemoteSlug(url) : null;
    this.cache.set(path, slug);
    return slug;
  }

  /** 页面用：解析不出时说明原因。 */
  resolve(path: string): { slug: string } | { reason: "no_remote" | "not_git" } {
    const slug = this.slugOf(path);
    if (slug) return { slug };
    return { reason: existsSync(join(path, ".git")) ? "no_remote" : "not_git" };
  }
}
