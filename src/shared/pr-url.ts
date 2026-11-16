/** 同一个 PR：按链接认（去掉首尾空白和末尾斜杠、不分大小写）。 */
export function prUrlKey(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * 解析 https://<host>/<owner>/<repo>/pull/<n>[/...]。github.com 的 slug 是 owner/repo，其他主机是 host/owner/repo，全部小写。
 * 不是 PR 链接返回 null。
 */
export function prUrlParts(url: string): { host: string; slug: string; number: number } | null {
  const m = /^https?:\/\/([^/\s@:]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim());
  if (!m) return null;
  const host = m[1].toLowerCase();
  const path = `${m[2]}/${m[3]}`.toLowerCase();
  return { host, slug: host === "github.com" ? path : `${host}/${path}`, number: Number(m[4]) };
}
