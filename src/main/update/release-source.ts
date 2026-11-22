// 经用户自己的 gh 查 Butler 的最新 release（BTL-253）。Butler 自己不发 HTTP 请求（Ruling P5-R4）：
// 就是 `gh api repos/<BUTLER_REPO>/releases/latest`，跑法和别的 gh 调用一样（tickets/gh.ts 的 runGhDetail）。
import { homedir } from "node:os";
import { BUTLER_REPO } from "../../shared/butler-repo";
import { displayVersion, RELEASE_NOTES_LIMIT, type ReleaseInfo, type UpdateFailReason } from "../../shared/update";
import { runGhDetail } from "../tickets/gh";

export const RELEASE_API_PATH = `repos/${BUTLER_REPO}/releases/latest`;
export const RELEASE_TIMEOUT_MS = 20_000;

/** 跑一次 gh：成功时 stdout 不为 null；spawnError 是启动失败的代码（ENOENT：没有 gh）；timedOut：超时被杀掉。 */
export type GhRun = (args: string[], env: NodeJS.ProcessEnv | undefined) => Promise<{ stdout: string | null; stderr: string; spawnError: string | null; timedOut: boolean }>;

export type LatestReleaseResult =
  | { ok: true; release: ReleaseInfo; draft: boolean; prerelease: boolean }
  | { ok: false; reason: UpdateFailReason; detail: string };

/** 真的 gh（cwd 用 home，和 gh search 一样）。 */
export const realGhRun: GhRun = (args, env) =>
  runGhDetail(homedir(), args, RELEASE_TIMEOUT_MS, 4 * 1024 * 1024, env).then((r) => ({
    stdout: r.stdout, stderr: r.stderr, spawnError: r.spawnError ?? null, timedOut: r.timedOut ?? false,
  }));

/** gh 的报错 → 原因。按 gh 和 GitHub 的原文认，认不出是 failed。 */
export function classifyGhFailure(stderr: string): UpdateFailReason {
  const s = stderr.toLowerCase();
  if (/rate limit|http 429|too many requests/.test(s)) return "rate_limited";
  if (/gh auth login|http 401|bad credentials|requires authentication|not logged in|authentication required/.test(s)) return "not_logged_in";
  if (/http 404|not found/.test(s)) return "no_release";
  if (/error connecting to|internet connection|dial tcp|no such host|could not resolve|network is unreachable|connection refused|connection reset|i\/o timeout|tls handshake timeout|context deadline exceeded|timeout awaiting/.test(s)) return "offline";
  return "failed";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** gh api 返回的 JSON → ReleaseInfo；不是一个像样的 release 返回 null。 */
export function parseRelease(j: unknown): { release: ReleaseInfo; draft: boolean; prerelease: boolean } | null {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const r = j as Record<string, unknown>;
  const tag = str(r.tag_name).trim();
  const url = str(r.html_url).trim();
  if (!tag || !url) return null;
  const published = Date.parse(str(r.published_at));
  return {
    release: { version: displayVersion(tag), tag, url, publishedAt: Number.isFinite(published) ? published : null, notes: str(r.body).slice(0, RELEASE_NOTES_LIMIT) },
    draft: r.draft === true,
    prerelease: r.prerelease === true,
  };
}

/** 一行原因细节：gh 报错的第一行非空内容，最多 300 字。 */
function firstLine(s: string): string {
  return (s.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "").slice(0, 300);
}

/** 查最新 release。从不抛错。GH_HOST 固定 github.com：默认主机是企业版的用户也查得到。 */
export async function latestRelease(run: GhRun = realGhRun): Promise<LatestReleaseResult> {
  let r: Awaited<ReturnType<GhRun>>;
  try {
    r = await run(["api", RELEASE_API_PATH], { GH_HOST: "github.com" });
  } catch (e) {
    return { ok: false, reason: "failed", detail: e instanceof Error ? e.message : String(e) };
  }
  if (r.spawnError === "ENOENT") return { ok: false, reason: "no_gh", detail: "" };
  if (r.timedOut) return { ok: false, reason: "offline", detail: "timeout" };
  if (r.stdout === null) return { ok: false, reason: classifyGhFailure(r.stderr), detail: firstLine(r.stderr || r.spawnError || "") };
  let j: unknown;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return { ok: false, reason: "bad_response", detail: "" };
  }
  const p = parseRelease(j);
  return p ? { ok: true, ...p } : { ok: false, reason: "bad_response", detail: "" };
}
