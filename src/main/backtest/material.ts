// 回测素材（工作流 F 第 3.1 节）：最近合并的 PR 的 diff、行内评论（带评审人当时看的提交和行）、规矩出处评论那个提交上的文件。
// 全部缓存在库里（backtest_prs / backtest_comments / backtest_files / backtest_repos），库就是断点：让路或重启以后接着拿没拿到的。
import type { BacktestRepo } from "../db/backtest-repo";
import { fileAt, prDiff, reviewCommentAnchors, type CommentAnchor, type FileAt } from "./gh-backtest";
import { mergedPrs, probeGh, LESSON_GH_TIMEOUT_MS } from "../tickets/gh";
import { normalizePath } from "../../shared/glob";

/** 一个仓库拿素材失败几次以后当作 gh 不可用（这个仓库的回测记成跳过）。 */
export const MAX_REPO_ATTEMPTS = 3;

export interface BacktestGh {
  /** 最近合并的 PR，失败返回 null。 */
  mergedPrs(cwd: string, limit: number): Promise<{ number: number; mergedAt: number | null }[] | null>;
  prDiff(cwd: string, n: number): Promise<string | null>;
  anchors(cwd: string, n: number): Promise<CommentAnchor[] | null>;
  fileAt(cwd: string, sha: string, path: string): Promise<FileAt>;
  /** gh 装着能执行吗（只在调用失败后问）：没装就不再重试。 */
  available?(): Promise<boolean>;
}

/** 真的 gh：cwd 是本地 clone，gh 自己认出仓库。 */
export function realBacktestGh(): BacktestGh {
  return {
    mergedPrs: async (cwd, limit) => {
      const r = await mergedPrs(cwd, null, limit, LESSON_GH_TIMEOUT_MS * 2);
      return r === null ? null : r.map((p) => ({ number: p.number, mergedAt: Date.parse(p.mergedAt) || null }));
    },
    prDiff: (cwd, n) => prDiff(cwd, n, null),
    anchors: (cwd, n) => reviewCommentAnchors(cwd, n, null),
    fileAt: (cwd, sha, path) => fileAt(cwd, null, sha, path),
    available: () => probeGh(LESSON_GH_TIMEOUT_MS),
  };
}

/** 规矩出处：哪个 PR、哪个文件哪一行、谁说的（D 补的，可能缺）。 */
export interface SourceRef {
  id: number;
  prNumber: number;
  path: string | null;
  line: number | null;
  reviewer: string | null;
}

/** 出处对应的评论：同一个文件；知道评审人就要同一个人；知道行就要 line 或 original_line 对上。 */
export function anchorsFor(s: SourceRef, anchors: readonly CommentAnchor[]): CommentAnchor[] {
  if (!s.path) return [];
  const path = normalizePath(s.path);
  return anchors.filter(
    (a) =>
      a.path !== null &&
      normalizePath(a.path) === path &&
      (s.reviewer === null || a.author === "" || a.author.toLowerCase() === s.reviewer.toLowerCase()) &&
      (s.line === null || a.line === s.line || a.originalLine === s.line),
  );
}

export interface PrefetchDeps {
  repo: BacktestRepo;
  gh: BacktestGh;
  now: () => number;
  log?: (msg: string, e?: unknown) => void;
}

export interface PrefetchInput {
  slug: string;
  cwd: string;
  recentPrs: number;
  /** 规矩出处（召回要用它们所在 PR 的评论和文件，可能比窗口老）。 */
  sources: readonly SourceRef[];
}

export type PrefetchResult = { kind: "ok"; window: number[]; fetched: number } | { kind: "failed"; gaveUp: boolean } | { kind: "aborted" };

/** 拿一个仓库的素材。每拿一个 PR 就写库，中途让路（signal）返回 aborted，下次从没拿到的接着拿。 */
export async function prefetchRepo(d: PrefetchDeps, input: PrefetchInput, signal: AbortSignal): Promise<PrefetchResult> {
  const { slug, cwd } = input;
  const list = await d.gh.mergedPrs(cwd, input.recentPrs);
  if (list === null) {
    const missing = d.gh.available ? !(await d.gh.available()) : false;
    d.repo.setRepoState(slug, "failed", null, d.now(), missing ? "gh not available" : "gh pr list failed", missing ? MAX_REPO_ATTEMPTS : undefined);
    const st = d.repo.repoState(slug);
    return { kind: "failed", gaveUp: (st?.attempts ?? 0) >= MAX_REPO_ATTEMPTS };
  }
  const window = list
    .slice()
    .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0) || b.number - a.number)
    .slice(0, input.recentPrs)
    .map((p) => p.number);
  d.repo.transaction(() => {
    d.repo.upsertPrs(slug, list.filter((p) => window.includes(p.number)));
    d.repo.dropOutside(slug, window);
    for (const s of input.sources) d.repo.ensurePr(slug, s.prNumber);
  });
  let fetched = 0;
  for (const n of d.repo.diffsToFetch(slug, window)) {
    if (signal.aborted) return { kind: "aborted" };
    d.repo.setDiff(slug, n, await d.gh.prDiff(cwd, n), d.now());
    fetched++;
  }
  const sourcePrs = [...new Set(input.sources.map((s) => s.prNumber))];
  for (const n of d.repo.commentsToFetch(slug, [...new Set([...window, ...sourcePrs])])) {
    if (signal.aborted) return { kind: "aborted" };
    d.repo.setComments(slug, n, await d.gh.anchors(cwd, n), d.now());
    fetched++;
  }
  const comments = d.repo.comments(slug, sourcePrs);
  for (const s of input.sources) {
    for (const a of anchorsFor(s, comments.get(s.prNumber) ?? [])) {
      if (!a.originalCommit || !a.path) continue;
      const have = d.repo.file(slug, a.originalCommit, a.path);
      if (have && have.status !== "failed") continue;
      if (signal.aborted) return { kind: "aborted" };
      d.repo.putFile(slug, a.originalCommit, a.path, await d.gh.fileAt(cwd, a.originalCommit, a.path), d.now());
      fetched++;
    }
  }
  d.repo.setRepoState(slug, "ok", window, d.now());
  return { kind: "ok", window, fetched };
}

/** 素材的状态：能用（窗口 + 出处评论都有了或放弃了）、还要拿、拿不到（gh 不能用）。 */
export type MaterialState = { kind: "ready"; window: number[] } | { kind: "missing"; prs: number[] } | { kind: "no_gh" };

export function materialState(repo: BacktestRepo, slug: string, sources: readonly SourceRef[]): MaterialState {
  const st = repo.repoState(slug);
  const sourcePrs = [...new Set(sources.map((s) => s.prNumber))];
  if (!st || (st.status !== "ok" && st.window.length === 0)) {
    if (st && st.attempts >= MAX_REPO_ATTEMPTS) return { kind: "no_gh" };
    return { kind: "missing", prs: sourcePrs };
  }
  // 出处所在的 PR 还没拿评论（新规矩的出处比上次拿素材晚）：先拿。拿了三次都失败的不等。
  const fetched = repo.commentsFetched(slug, sourcePrs);
  const gaveUp = repo.commentsGaveUp(slug, sourcePrs);
  const todo = sourcePrs.filter((n) => !fetched.has(n) && !gaveUp.has(n));
  if (todo.length) return { kind: "missing", prs: todo };
  // 出处评论对上了提交、但文件还没拿（或上次失败）：也要拿。
  const comments = repo.comments(slug, sourcePrs);
  for (const s of sources)
    for (const a of anchorsFor(s, comments.get(s.prNumber) ?? [])) {
      if (!a.originalCommit || !a.path) continue;
      const f = repo.file(slug, a.originalCommit, a.path);
      if (!f) return { kind: "missing", prs: [s.prNumber] };
    }
  return { kind: "ready", window: st.window };
}
