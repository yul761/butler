/** 解析一次；不允许时返回 null。isAllowedGithubUrl 和 openKnownPr 用的是同一个解析结果。 */
function allowedGithubUrl(url: string, knownSlugs: readonly string[]): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "") return null;
  if (u.hostname === "github.com") return u;
  const known = knownSlugs.some((slug) => {
    const parts = slug.split("/");
    return parts.length === 3 && parts[0].toLowerCase() === u.hostname;
  });
  return known ? u : null;
}

/**
 * 能交给系统浏览器打开的 GitHub 链接：https，链接里没有用户名、密码或端口，主机是 github.com，
 * 或者某个已知三段 slug（企业版 GitHub，host/owner/repo）的主机。主机名整串比较，不做前缀 / 后缀匹配。
 */
export function isAllowedGithubUrl(url: string, knownSlugs: readonly string[]): boolean {
  return allowedGithubUrl(url, knownSlugs) !== null;
}

export type PrOpenResult = { ok: true } | { ok: false; reason: "bad_url" };

/**
 * 打开 PR 链接：只开某个 ticket 链接过的 PR，主机要过 isAllowedGithubUrl。
 * 允许的主机只来自 trustedSlugs（git remote 认出来的仓库），不来自 ticket_prs：那里的 slug 是从 PR 链接本身算的。
 * 交给浏览器的是检查过的那次解析的 href，不是原始输入。
 */
export function openKnownPr(
  url: string,
  d: { prs: { byUrl(url: string): readonly unknown[] }; trustedSlugs: () => readonly string[]; openExternal: (url: string) => void },
): PrOpenResult {
  const u = d.prs.byUrl(url).length > 0 ? allowedGithubUrl(url, d.trustedSlugs()) : null;
  if (!u) return { ok: false, reason: "bad_url" };
  d.openExternal(u.href);
  return { ok: true };
}
