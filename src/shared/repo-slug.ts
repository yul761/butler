// git remote URL → 仓库 slug。纯函数：主进程（repo-identity）和 hook（检查）都用它。

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
