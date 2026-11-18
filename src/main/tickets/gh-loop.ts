import { repoEnv, runGhDetail } from "./gh";

/**
 * 评论闭环和 CI 分类（工作流 I）用到的 gh 调用。都是 execFile + 参数数组，不经过 shell（Windows 上 cmd 不会改写引号）。
 * {owner}/{repo} 占位符由 gh 从 cwd 的仓库解析；不是 ticket 仓库的 PR 传 slug（GH_REPO / GH_HOST）。
 */

export const LOOP_GH_TIMEOUT_MS = 30_000;

export interface ThreadComment {
  /** REST 的数字 id（= pulls/N/comments 的 id，pr_stage_events 的去重键用它）。 */
  databaseId: number;
  author: string;
  /** GraphQL 的 __typename：Bot / User / …。 */
  authorType: string;
  body: string;
  createdAt: string;
  url: string;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  commit: string | null;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  comments: ThreadComment[];
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes {
      id isResolved isOutdated path line originalLine
      comments(first: 50) { nodes { databaseId author { __typename login } body createdAt url path line originalLine commit { oid } } }
    } }
  } }
}`;

const RESOLVE_MUTATION = `mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }`;

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const nodes = (v: unknown): unknown[] => {
  const n = obj(v)?.nodes;
  return Array.isArray(n) ? n : [];
};

/** graphql 的 reviewThreads 输出 → 线程列表；形状不对返回 null。 */
export function parseReviewThreads(text: string | null): ReviewThread[] | null {
  if (text === null) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const pr = obj(obj(obj(obj(j)?.data)?.repository)?.pullRequest);
  if (!pr) return null;
  const out: ReviewThread[] = [];
  for (const t of nodes(pr.reviewThreads)) {
    const r = obj(t);
    if (!r || typeof r.id !== "string") continue;
    const comments: ThreadComment[] = [];
    for (const c of nodes(r.comments)) {
      const x = obj(c);
      const id = intOrNull(x?.databaseId);
      if (!x || id === null) continue;
      const author = obj(x.author);
      comments.push({
        databaseId: id, author: str(author?.login), authorType: str(author?.__typename), body: str(x.body), createdAt: str(x.createdAt), url: str(x.url),
        path: strOrNull(x.path), line: intOrNull(x.line), originalLine: intOrNull(x.originalLine), commit: strOrNull(obj(x.commit)?.oid),
      });
    }
    if (comments.length === 0) continue;
    out.push({
      id: r.id, isResolved: r.isResolved === true, isOutdated: r.isOutdated === true, path: strOrNull(r.path), line: intOrNull(r.line), originalLine: intOrNull(r.originalLine), comments,
    });
  }
  return out;
}

/** 一个 PR 的 review thread（GraphQL）。失败返回 null。 */
export async function reviewThreads(cwd: string, number: number, timeoutMs: number, repo?: string | null): Promise<ReviewThread[] | null> {
  const r = await runGhDetail(
    cwd,
    ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`, "-f", `query=${THREADS_QUERY}`],
    timeoutMs, 8 * 1024 * 1024, repoEnv(repo),
  );
  return parseReviewThreads(r.stdout);
}

export type GhWrite = { ok: true; url: string | null } | { ok: false; error: string };

const writeResult = (r: { stdout: string | null; stderr: string }): GhWrite => {
  if (r.stdout === null) return { ok: false, error: r.stderr.trim().slice(0, 500) || "gh failed" };
  let url: string | null = null;
  try {
    url = strOrNull(obj(JSON.parse(r.stdout))?.html_url);
  } catch {
    // 没有 JSON 输出也算成功。
  }
  return { ok: true, url };
};

/** 在行内评论的 thread 里回复（REST replies）。 */
export async function replyToReviewComment(cwd: string, number: number, commentId: number, body: string, timeoutMs: number, repo?: string | null): Promise<GhWrite> {
  return writeResult(await runGhDetail(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/comments/${commentId}/replies`, "-f", `body=${body}`], timeoutMs, 1024 * 1024, repoEnv(repo)));
}

/** 在 PR 上发一条评论（PR 级评论、review 正文没有「回复」）。 */
export async function commentOnPr(cwd: string, number: number, body: string, timeoutMs: number, repo?: string | null): Promise<GhWrite> {
  return writeResult(await runGhDetail(cwd, ["api", `repos/{owner}/{repo}/issues/${number}/comments`, "-f", `body=${body}`], timeoutMs, 1024 * 1024, repoEnv(repo)));
}

/** resolve 一个 review thread（GraphQL mutation）。 */
export async function resolveReviewThread(cwd: string, threadId: string, timeoutMs: number, repo?: string | null): Promise<GhWrite> {
  const r = await runGhDetail(cwd, ["api", "graphql", "-f", `id=${threadId}`, "-f", `query=${RESOLVE_MUTATION}`], timeoutMs, 1024 * 1024, repoEnv(repo));
  if (r.stdout === null) return writeResult(r);
  try {
    const j = obj(JSON.parse(r.stdout));
    if (Array.isArray(j?.errors) && j.errors.length > 0) return { ok: false, error: str(obj(j.errors[0])?.message).slice(0, 500) || "graphql error" };
  } catch {
    // 不是 JSON：按 gh 的退出码算成功。
  }
  return { ok: true, url: null };
}

/** gh run rerun <id> --failed：只重跑失败的 job。 */
export async function rerunFailed(cwd: string, runId: number, timeoutMs: number, repo?: string | null): Promise<GhWrite> {
  const r = await runGhDetail(cwd, ["run", "rerun", String(runId), "--failed"], timeoutMs, 1024 * 1024, repoEnv(repo));
  return r.stdout === null ? writeResult(r) : { ok: true, url: null };
}

export interface RunStep { name: string; conclusion: string; number: number }
export interface RunJob { name: string; status: string; conclusion: string; startedAt: string | null; completedAt: string | null; steps: RunStep[] }
export interface RunInfo { attempt: number; status: string; conclusion: string; jobs: RunJob[] }

/** gh run view --json 的输出 → RunInfo；形状不对返回 null。status / conclusion 统一小写。 */
export function parseRunInfo(text: string | null): RunInfo | null {
  if (text === null) return null;
  let j: Record<string, unknown> | null;
  try {
    j = obj(JSON.parse(text));
  } catch {
    return null;
  }
  if (!j) return null;
  const jobs: RunJob[] = [];
  for (const x of Array.isArray(j.jobs) ? j.jobs : []) {
    const r = obj(x);
    if (!r) continue;
    const steps: RunStep[] = [];
    for (const s of Array.isArray(r.steps) ? r.steps : []) {
      const o = obj(s);
      if (o) steps.push({ name: str(o.name), conclusion: str(o.conclusion).toLowerCase(), number: intOrNull(o.number) ?? 0 });
    }
    jobs.push({ name: str(r.name), status: str(r.status).toLowerCase(), conclusion: str(r.conclusion).toLowerCase(), startedAt: strOrNull(r.startedAt), completedAt: strOrNull(r.completedAt), steps });
  }
  return { attempt: intOrNull(j.attempt) ?? 1, status: str(j.status).toLowerCase(), conclusion: str(j.conclusion).toLowerCase(), jobs };
}

/** 一个 run 的 attempt、结论和 job（失败在哪一步、有没有分到 runner）。失败返回 null。 */
export async function runInfo(cwd: string, runId: number, timeoutMs: number, repo?: string | null): Promise<RunInfo | null> {
  const r = await runGhDetail(cwd, ["run", "view", String(runId), "--json", "attempt,status,conclusion,jobs"], timeoutMs, 4 * 1024 * 1024, repoEnv(repo));
  return parseRunInfo(r.stdout);
}
