import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

function defaultGit(path: string): string | null {
  try {
    return execFileSync("git", ["-C", path, "remote", "get-url", "origin"], {
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** 仓库路径 -> 仓库身份（来自 origin remote）。结果按路径缓存，app 运行期间不过期。 */
export class RepoIdentity {
  private readonly git: (path: string) => string | null;
  private readonly cache = new Map<string, string | null>();

  constructor(d: { git?: (path: string) => string | null } = {}) {
    this.git = d.git ?? defaultGit;
  }

  slugOf(path: string): string | null {
    if (this.cache.has(path)) return this.cache.get(path) ?? null;
    const url = this.git(path);
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
