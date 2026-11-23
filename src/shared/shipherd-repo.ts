// Shipherd 自己的 GitHub 仓库（BTL-253）。仓库名只写在这里：更新检查、release 页、反馈的 issue 页都从它拼。

export const SHIPHERD_REPO = "yul761/shipherd";

/** 最新 release 的页面。 */
export function releasesLatestUrl(): string {
  return `https://github.com/${SHIPHERD_REPO}/releases/latest`;
}

/** 是不是 Shipherd 仓库的 release 页：https、主机正好是 github.com、没有用户名、路径以 /<SHIPHERD_REPO>/releases/ 开头（大小写不敏感）。 */
export function isShipherdReleaseUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port !== "" || u.username !== "" || u.password !== "") return false;
  return u.pathname.toLowerCase().startsWith(`/${SHIPHERD_REPO.toLowerCase()}/releases/`);
}
