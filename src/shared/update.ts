// 更新提示（BTL-253）：版本比较和界面要的视图。只提示，不下载、不安装（Ruling P5-R4）。

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识（rc.1 → ["rc", "1"]）；正式版是空的。 */
  pre: string[];
}

const NUM = "(0|[1-9]\\d*)";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION_RE = new RegExp(`^[vV]?${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** SemVer 2.0 的 X.Y.Z[-pre][+build]，前面可以有 v。不是版本号返回 null。 */
export function parseVersion(v: string): ParsedVersion | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

function comparePre(a: string[], b: string[]): number {
  // 没有预发布的比有预发布的高。
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字标识比字母的低
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/** a 比 b 新为正、旧为负、一样为 0（build 元数据不算）；有一边不是版本号返回 null。 */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch || comparePre(x.pre, y.pre);
}

/** 这个 release 是不是比当前版本新的正式版：draft、prerelease、tag 带预发布后缀的都不算；版本号解析不了也不算。 */
export function isNewerRelease(r: { tag: string; draft: boolean; prerelease: boolean }, current: string): boolean {
  if (r.draft || r.prerelease) return false;
  const v = parseVersion(r.tag);
  if (!v || v.pre.length > 0) return false;
  const c = compareVersions(r.tag, current);
  return c !== null && c > 0;
}

/** 版本号去掉前面的 v，用来显示和存「跳过的版本」。 */
export function displayVersion(tag: string): string {
  return tag.trim().replace(/^[vV](?=\d)/, "");
}

/** 查到的一个 release（存进设置 updateLatest）。 */
export interface ReleaseInfo {
  /** 去掉 v 的版本号。 */
  version: string;
  tag: string;
  /** release 页（html_url）。 */
  url: string;
  /** 发布时间（毫秒）；没有为 null。 */
  publishedAt: number | null;
  /** release notes 原文（最多 RELEASE_NOTES_LIMIT 字）。 */
  notes: string;
}

export const RELEASE_NOTES_LIMIT = 20_000;

/** 查不了的原因（手动检查时写给用户看）。 */
export const UPDATE_FAIL_REASONS = ["no_gh", "not_logged_in", "offline", "rate_limited", "no_release", "bad_response", "failed"] as const;
export type UpdateFailReason = (typeof UPDATE_FAIL_REASONS)[number];

/** 一次检查的结果。 */
export type UpdateCheckResult =
  | { kind: "latest"; current: string; latest: string; at: number }
  | { kind: "available"; release: ReleaseInfo; at: number }
  | { kind: "failed"; reason: UpdateFailReason; detail: string; at: number };

/** 界面要的状态（update:state）。 */
export interface UpdateView {
  /** 正在跑的 Butler 的版本。 */
  current: string;
  /** 设置 updateCheckEnabled。 */
  enabled: boolean;
  /** 上次检查（自动或手动）的时间；没查过为 null。 */
  lastCheckedAt: number | null;
  /** 顶部提示条要显示的新版本：比当前新、没跳过、这次运行没关掉，并且开关开着（或者是这次手动查到的）。没有为 null。 */
  banner: ReleaseInfo | null;
  /** 正在查。 */
  checking: boolean;
  /** 这次运行里最近一次手动检查的结果（「关于」里显示）；没手动查过为 null。 */
  lastManual: UpdateCheckResult | null;
}

/** 应用菜单发给界面的动作（app:menu）。 */
export type AppMenuAction = "checkUpdates" | "sendFeedback";
