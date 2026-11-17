import { prUrlKey } from "../../shared/pr-url";

/**
 * 能交给系统浏览器打开的 GitHub 链接：https，链接里没有用户名或密码，主机是 github.com，
 * 或者某个已知三段 slug（企业版 GitHub，host/owner/repo）的主机。主机名整串比较，不做前缀 / 后缀匹配。
 */
export function isAllowedGithubUrl(url: string, knownSlugs: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return false;
  if (u.hostname === "github.com") return true;
  return knownSlugs.some((slug) => {
    const parts = slug.split("/");
    return parts.length === 3 && parts[0].toLowerCase() === u.hostname;
  });
}

export type PrOpenResult = { ok: true } | { ok: false; reason: "bad_url" };

/** 打开 PR 链接：只开某个 ticket 链接过的 PR，并且主机要过 isAllowedGithubUrl。 */
export function openKnownPr(
  url: string,
  d: { prs: { byUrl(url: string): readonly unknown[]; slugs(): readonly string[] }; openExternal: (url: string) => void },
): PrOpenResult {
  if (d.prs.byUrl(prUrlKey(url)).length === 0 || !isAllowedGithubUrl(url, d.prs.slugs())) return { ok: false, reason: "bad_url" };
  d.openExternal(url);
  return { ok: true };
}
