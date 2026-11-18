// 回测素材的 gh / git 调用（工作流 F 第 3.1 节）：合并 PR 的 diff、行内评论指向的提交和行、某个提交上的文件。
// 都不抛错：失败返回 null（或 status: failed），由调用方记下来下次再试。
import { execFile } from "node:child_process";
import { repoEnv, runGhDetail } from "../tickets/gh";

export const BACKTEST_GH_TIMEOUT_MS = 30_000;
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;

export interface CommentAnchor {
  id: number;
  author: string;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  originalCommit: string | null;
}

export interface FileAt {
  status: "ok" | "missing" | "too_large" | "binary" | "failed";
  content: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** gh pr diff <n>：统一 diff。超过 MAX_DIFF_BYTES 或失败返回 null。 */
export async function prDiff(cwd: string, number: number, repo: string | null, timeoutMs = BACKTEST_GH_TIMEOUT_MS): Promise<string | null> {
  const r = await runGhDetail(cwd, ["pr", "diff", String(number), "--color", "never"], timeoutMs, MAX_DIFF_BYTES, repoEnv(repo));
  return r.stdout;
}

/** 行内评论：REST 的 original_commit_id / original_line 是评审人当时看的提交和行。失败返回 null。 */
export async function reviewCommentAnchors(cwd: string, number: number, repo: string | null, timeoutMs = BACKTEST_GH_TIMEOUT_MS): Promise<CommentAnchor[] | null> {
  const r = await runGhDetail(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate", "--jq", ".[]"], timeoutMs, 16 * 1024 * 1024, repoEnv(repo));
  return parseAnchors(r.stdout);
}

export function parseAnchors(stdout: string | null): CommentAnchor[] | null {
  if (stdout === null) return null;
  const out: CommentAnchor[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      return null;
    }
    const c = obj(v);
    const id = num(c?.id);
    if (!c || id === null) continue;
    out.push({
      id,
      author: typeof obj(c.user)?.login === "string" ? (obj(c.user)?.login as string) : "",
      path: typeof c.path === "string" ? c.path : null,
      line: num(c.line),
      originalLine: num(c.original_line),
      originalCommit: typeof c.original_commit_id === "string" ? c.original_commit_id : null,
    });
  }
  return out;
}

const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

function classify(buf: Buffer): FileAt {
  if (buf.length > MAX_FILE_BYTES) return { status: "too_large", content: null };
  if (buf.subarray(0, 8192).includes(0)) return { status: "binary", content: null };
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { status: "ok", content: text };
}

function gitShow(cwd: string, sha: string, path: string, timeoutMs: number): Promise<Buffer | "missing" | null> {
  return new Promise((done) => {
    execFile("git", ["-c", "core.quotepath=off", "show", `${sha}:${path}`], { cwd, timeout: timeoutMs, windowsHide: true, encoding: "buffer", maxBuffer: MAX_FILE_BYTES + 1 }, (err, stdout, stderr) => {
      if (!err) return done(stdout);
      const msg = String(stderr ?? "");
      // 提交在本地，但这个路径在那个提交上不存在：确定是没有，不用再问 GitHub。
      done(/does not exist in|exists on disk, but not in/.test(msg) ? "missing" : null);
    });
  });
}

/** 某个提交上的文件：先看本地 clone（快、不占 API 额度），提交不在本地再问 GitHub（raw）。 */
export async function fileAt(cwd: string, repo: string | null, sha: string, path: string, timeoutMs = BACKTEST_GH_TIMEOUT_MS): Promise<FileAt> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha) || path === "" || path.startsWith("-")) return { status: "failed", content: null };
  const local = await gitShow(cwd, sha, path, timeoutMs);
  if (local === "missing") return { status: "missing", content: null };
  if (local) return classify(local);
  const r = await runGhDetail(cwd, ["api", "-H", "Accept: application/vnd.github.raw", `repos/{owner}/{repo}/contents/${encodePath(path)}?ref=${sha}`], timeoutMs, MAX_FILE_BYTES + 1, repoEnv(repo));
  if (r.stdout === null) return { status: /HTTP 404|Not Found/i.test(r.stderr) ? "missing" : "failed", content: null };
  return classify(Buffer.from(r.stdout, "utf8"));
}
