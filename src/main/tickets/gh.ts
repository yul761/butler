import { execFile } from "node:child_process";

/**
 * 执行的 gh：启动时和登录 shell 的 PATH 读到之后各解析一次（resolveGh）；没找到就用裸 "gh"。
 * null：没找到 gh 且在 Windows 上，不执行（裸 "gh" 会先在仓库目录里找 gh.exe，I5，和 git-path 一样）。
 */
let binary: string | null = "gh";
let resolved = false;
let warned = false;
/** 这个 gh 不认 prStatus 新增的 --json 字段（报过 Unknown JSON field）：之后直接用最初的字段，不再每轮多调一次。换 gh 时重置。 */
let oldPrFields = false;

export function setGhBinary(p: string): void {
  binary = p;
  resolved = true;
  oldPrFields = false;
}

/** 测试用：回到“还没解析过”的初始状态。 */
export function resetGhBinary(): void {
  binary = "gh";
  resolved = false;
  warned = false;
  oldPrFields = false;
}

/**
 * 记录一次解析结果：找到了就（重新）采用；没找到时不降级已有的结果。一直没找到：Windows 上不执行 gh（PR、CI 读成 unknown），
 * 其他平台用裸 "gh"；整个进程只警告一次。
 */
export function applyGhResolution(found: string | null, platform: NodeJS.Platform, log: (msg: string) => void): void {
  if (found) {
    setGhBinary(found);
    return;
  }
  if (resolved) return;
  binary = platform === "win32" ? null : "gh";
  if (warned) return;
  warned = true;
  log(platform === "win32" ? "gh not found on PATH: PR and CI checks are disabled" : "gh not found on PATH: falling back to plain gh");
}

/** null：不能执行 gh（Windows 上没找到）。 */
export function ghBinary(): string | null {
  return binary;
}

export interface PrInfo {
  number: number;
  url: string;
  head: string;
  base: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  autoMerge: boolean;
}

/** gh pr view [pr]：pr 为 null 时看 cwd 当前分支的 PR。gh 没装、没登录、超时、输出不对都返回 null，从不抛错。 */
export function prInfo(cwd: string, pr: string | null, timeoutMs: number): Promise<PrInfo | null> {
  const bin = ghBinary();
  if (bin === null) return Promise.resolve(null);
  return new Promise((done) => {
    const args = ["pr", "view", ...(pr === null ? [] : [pr]), "--json", "number,url,headRefName,baseRefName,state,autoMergeRequest"];
    execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return done(null);
      try {
        const j = JSON.parse(String(stdout)) as Record<string, unknown>;
        if (typeof j.number !== "number" || typeof j.url !== "string" || typeof j.headRefName !== "string" || typeof j.baseRefName !== "string") return done(null);
        if (j.state !== "OPEN" && j.state !== "MERGED" && j.state !== "CLOSED") return done(null);
        done({ number: j.number, url: j.url, head: j.headRefName, base: j.baseRefName, state: j.state, autoMerge: j.autoMergeRequest !== null && j.autoMergeRequest !== undefined });
      } catch {
        done(null);
      }
    });
  });
}

export type CiState = "pending" | "passing" | "failing" | "none" | "unknown";
export interface CiCheck {
  name: string;
  state: "pending" | "passing" | "failing";
  runId: number | null;
  /** 失败日志的末尾，PrWatcher 填（Task 5）。 */
  log?: string;
}
export interface PrReview {
  id: string;
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  submittedAt: number;
}
export interface PrComment {
  id: string;
  author: string;
  body: string;
  createdAt: number;
  url: string | null;
  path: string | null;
  line: number | null;
  reviewId: string | null;
}
export interface PrStatus {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  review: "pending" | "changes_requested" | "approved" | null;
  headSha: string;
  checks: CiCheck[];
  ci: CiState;
  author: string;
  reviews: PrReview[];
  comments: PrComment[];
  /** PR 里最早一个 commit 的作者时间（毫秒）；旧版 gh 没有这个字段时为 null。 */
  firstCommitAt: number | null;
  /** PR 的创建、合并、关闭时间（毫秒）；没有为 null。 */
  createdAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
}
export interface BranchRuns {
  headSha: string;
  checks: CiCheck[];
  ci: CiState;
}

const FAILING = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * status/conclusion 换算成检查状态；真实输出里 pr view 是大写、run list 是小写，统一转大写比较。
 * 已结束的检查只有失败类结论算失败，其余（SUCCESS、NEUTRAL、SKIPPED，以及 STALE、空、以后新加的）都算通过：
 * 不能算 pending，不然 CI 永远出不了结论。
 */
function runState(status: unknown, conclusion: unknown): CiCheck["state"] {
  if (str(status).toUpperCase() !== "COMPLETED") return "pending";
  return FAILING.has(str(conclusion).toUpperCase()) ? "failing" : "passing";
}

function runIdOf(url: unknown): number | null {
  const m = /\/actions\/runs\/(\d+)/.exec(str(url));
  return m ? Number(m[1]) : null;
}

/** 纯函数：statusCheckRollup 的数组 → CiCheck[]。CheckRun 看 status/conclusion，StatusContext 看 state。 */
export function checksOf(rollup: unknown): CiCheck[] {
  if (!Array.isArray(rollup)) return [];
  const out: CiCheck[] = [];
  for (const item of rollup) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (r.__typename === "StatusContext") {
      const s = str(r.state).toUpperCase();
      const state = s === "SUCCESS" ? "passing" : s === "FAILURE" || s === "ERROR" ? "failing" : "pending";
      out.push({ name: str(r.context), state, runId: runIdOf(r.targetUrl) });
    } else {
      out.push({ name: str(r.name), state: runState(r.status, r.conclusion), runId: runIdOf(r.detailsUrl) });
    }
  }
  return out;
}

/** 有 failing → failing；否则有 pending → pending；有检查 → passing；空 → none。 */
export function ciOf(checks: CiCheck[]): CiState {
  if (checks.some((c) => c.state === "failing")) return "failing";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return checks.length > 0 ? "passing" : "none";
}

/** 跑 gh，成功返回 stdout，任何失败返回 null，从不抛错。不能执行 gh（Windows 上没找到）时不启动进程，直接 null。 */
function runGh(cwd: string, args: string[], timeoutMs: number, maxBuffer: number): Promise<string | null> {
  return runGhDetail(cwd, args, timeoutMs, maxBuffer).then((r) => r.stdout);
}

/** 同 runGh，另外带回 stderr（失败时用来分辨原因）。 */
function runGhDetail(cwd: string, args: string[], timeoutMs: number, maxBuffer: number): Promise<{ stdout: string | null; stderr: string }> {
  const bin = ghBinary();
  if (bin === null) return Promise.resolve({ stdout: null, stderr: "" });
  return new Promise((done) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer }, (err, stdout, stderr) =>
      done({ stdout: err ? null : String(stdout), stderr: String(stderr ?? "") }));
  });
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);
/** gh pr view 给的 author 不带 [bot] 后缀，GitHub App 要靠名字认；authoritative 的判断是 REST 的 user.type（reviewAuthors）。 */
const BOT_LOGINS = [
  "github-actions", "dependabot", "renovate", "chatgpt-codex-connector", "coderabbitai", "gemini-code-assist", "sourcery-ai",
  "codecov", "sonarcloud", "vercel", "netlify", "github-advanced-security", "cursor",
];

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function loginOf(v: unknown): string {
  return str(obj(v)?.login);
}

function timeOf(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function reviewsOf(v: unknown): PrReview[] {
  if (!Array.isArray(v)) return [];
  const out: PrReview[] = [];
  for (const item of v) {
    const r = obj(item);
    if (!r || typeof r.id !== "string" || r.id === "" || !REVIEW_STATES.has(str(r.state))) continue;
    const submittedAt = timeOf(r.submittedAt);
    if (submittedAt === null) continue;
    out.push({ id: r.id, author: loginOf(r.author), state: r.state as PrReview["state"], body: str(r.body), submittedAt });
  }
  return out;
}

function commentsOf(v: unknown): PrComment[] {
  if (!Array.isArray(v)) return [];
  const out: PrComment[] = [];
  for (const item of v) {
    const r = obj(item);
    if (!r || typeof r.id !== "string" || r.id === "") continue;
    const createdAt = timeOf(r.createdAt);
    if (createdAt === null) continue;
    out.push({ id: r.id, author: loginOf(r.author), body: str(r.body), createdAt, url: typeof r.url === "string" ? r.url : null, path: null, line: null, reviewId: null });
  }
  return out;
}

function firstCommitOf(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  const times = v.map((c) => timeOf(obj(c)?.authoredDate)).filter((t): t is number => t !== null);
  return times.length > 0 ? Math.min(...times) : null;
}

/** 纯函数：login 归类。PR 作者 → author；含 copilot → copilot；[bot] 结尾或在 BOT_LOGINS 里 → bot；其余 human。 */
export function reviewerKind(login: string, prAuthor: string): "copilot" | "human" | "author" | "bot" {
  if (login === prAuthor) return "author";
  const l = login.toLowerCase();
  if (l.includes("copilot")) return "copilot";
  if (l.endsWith("[bot]") || BOT_LOGINS.includes(l)) return "bot";
  return "human";
}

const REVIEWS = { REVIEW_REQUIRED: "pending", CHANGES_REQUESTED: "changes_requested", APPROVED: "approved" } as const;

// 退回用的最小字段里有 headRefOid，它是 gh v2.18.0（2022-10-18，cli/cli bb252020）才加的；
// 新增的 author、comments、createdAt、closedAt、mergedAt、reviews、statusCheckRollup 在 v1.9.0（2021-04）的 PullRequestFields 里就有，
// commits 最晚 v1.10.0（2021-05）也有。所以认 headRefOid 的 gh 一定认全部字段，"Unknown JSON field" 退回只会发生在连最小字段也不认的旧 gh 上（结果仍是 null）；
// 不需要用 REST 补 reviews、comments。
const PR_FIELDS_MIN = "number,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup";
const PR_FIELDS = `${PR_FIELDS_MIN},author,reviews,comments,commits,createdAt,mergedAt,closedAt`;

/** gh pr view <branch>：没有 PR、gh 不可用、输出不对都返回 null。旧版 gh 不认新增的字段时，退回最初的字段（reviews、comments 为空），并记住，之后直接用最初的字段。 */
export async function prStatus(cwd: string, branch: string, timeoutMs: number): Promise<PrStatus | null> {
  const view = (fields: string) => runGhDetail(cwd, ["pr", "view", branch, "--json", fields], timeoutMs, 8 * 1024 * 1024);
  if (oldPrFields) return parsePr((await view(PR_FIELDS_MIN)).stdout);
  const full = await view(PR_FIELDS);
  // 只在 gh 明说不认字段时退回；没有 PR、超时等失败不重试（不然没有 PR 的分支每轮都多调一次）。
  if (full.stdout !== null || !/Unknown JSON field/i.test(full.stderr)) return parsePr(full.stdout);
  oldPrFields = true;
  return parsePr((await view(PR_FIELDS_MIN)).stdout);
}

function parsePr(text: string | null): PrStatus | null {
  const j = parseJson(text);
  if (typeof j !== "object" || j === null) return null;
  const r = j as Record<string, unknown>;
  if (typeof r.number !== "number" || typeof r.url !== "string" || typeof r.headRefOid !== "string") return null;
  if (r.state !== "OPEN" && r.state !== "MERGED" && r.state !== "CLOSED") return null;
  const checks = checksOf(r.statusCheckRollup);
  return {
    number: r.number,
    url: r.url,
    state: r.state,
    isDraft: r.isDraft === true,
    review: REVIEWS[str(r.reviewDecision) as keyof typeof REVIEWS] ?? null,
    headSha: r.headRefOid,
    checks,
    ci: ciOf(checks),
    author: loginOf(r.author),
    reviews: reviewsOf(r.reviews),
    comments: commentsOf(r.comments),
    firstCommitAt: firstCommitOf(r.commits),
    createdAt: timeOf(r.createdAt),
    mergedAt: timeOf(r.mergedAt),
    closedAt: timeOf(r.closedAt),
  };
}

/** --jq '.[]' 的输出：每行一个紧凑 JSON 对象。空行跳过；任何一行解析失败整体返回 null（丢一个对象会被当成没有数据）。 */
function parseLines(text: string | null): unknown[] | null {
  if (text === null) return null;
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * 行内 review 评论：gh api repos/{owner}/{repo}/pulls/N/comments --paginate。失败返回 null。
 * REST 的 pull_request_review_id 是数字，而 gh pr view 给的 review id 是 GraphQL 的 node id（PRR_…）：再取一次 reviews 列表，把评论的 reviewId 换成 node id。
 */
export async function reviewComments(cwd: string, number: number, timeoutMs: number): Promise<PrComment[] | null> {
  const j = parseLines(await runGh(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate", "--jq", ".[]"], timeoutMs, 8 * 1024 * 1024));
  if (j === null) return null;
  const reviews = parseLines(await runGh(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--paginate", "--jq", ".[] | {id, node_id}"], timeoutMs, 8 * 1024 * 1024));
  if (reviews === null) return null;
  const nodeOf = new Map<number, string>();
  for (const item of reviews) {
    const r = obj(item);
    if (r && typeof r.id === "number" && typeof r.node_id === "string" && r.node_id !== "") nodeOf.set(r.id, r.node_id);
  }
  const out: PrComment[] = [];
  for (const item of j) {
    const r = obj(item);
    if (!r || typeof r.id !== "number") continue;
    const createdAt = timeOf(r.created_at);
    if (createdAt === null) continue;
    out.push({
      id: String(r.id),
      author: loginOf(r.user),
      body: str(r.body),
      createdAt,
      url: typeof r.html_url === "string" ? r.html_url : null,
      path: typeof r.path === "string" ? r.path : null,
      line: typeof r.line === "number" ? r.line : null,
      reviewId: typeof r.pull_request_review_id === "number" ? (nodeOf.get(r.pull_request_review_id) ?? null) : null,
    });
  }
  return out;
}

export interface ReviewAuthors {
  /** user.type 是 Bot 的 review（GraphQL node id）。 */
  botReviewIds: Set<string>;
  /** 这些 review 里 Bot 的 login（小写、去掉 [bot]），用来认同一个人的评论。 */
  botLogins: Set<string>;
}

/** REST 的 reviews 列表里谁是 Bot：gh pr view 给的 author 没有 [bot] 后缀和类型。失败返回 null（调用方退回按名字认）。 */
export async function reviewAuthors(cwd: string, number: number, timeoutMs: number): Promise<ReviewAuthors | null> {
  const rows = parseLines(await runGh(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--paginate", "--jq", ".[] | {node_id, user: {login: .user.login, type: .user.type}}"], timeoutMs, 8 * 1024 * 1024));
  if (rows === null) return null;
  const out: ReviewAuthors = { botReviewIds: new Set(), botLogins: new Set() };
  for (const item of rows) {
    const r = obj(item);
    const user = obj(r?.user);
    if (!r || !user || user.type !== "Bot") continue;
    if (typeof r.node_id === "string" && r.node_id !== "") out.botReviewIds.add(r.node_id);
    if (typeof user.login === "string" && user.login !== "") out.botLogins.add(user.login.toLowerCase().replace(/\[bot\]$/, ""));
  }
  return out;
}

/** gh run list --branch：只看最新的 headSha（列表按时间倒序，第一条即最新）。没有 run 返回 null。 */
export async function branchRuns(cwd: string, branch: string, timeoutMs: number): Promise<BranchRuns | null> {
  const j = parseJson(await runGh(cwd, ["run", "list", "--branch", branch, "--limit", "20", "--json", "databaseId,headSha,status,conclusion,workflowName"], timeoutMs, 1024 * 1024));
  if (!Array.isArray(j)) return null;
  const runs = j.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && typeof (x as Record<string, unknown>).headSha === "string");
  if (runs.length === 0) return null;
  const headSha = runs[0].headSha as string;
  const checks: CiCheck[] = runs
    .filter((r) => r.headSha === headSha)
    .map((r) => ({ name: str(r.workflowName), state: runState(r.status, r.conclusion), runId: typeof r.databaseId === "number" ? r.databaseId : null }));
  return { headSha, checks, ci: ciOf(checks) };
}

/** gh run view <runId> --log-failed，取最后 lines 行；失败返回 null。 */
export async function failedLog(cwd: string, runId: number, lines: number, timeoutMs: number): Promise<string | null> {
  const out = await runGh(cwd, ["run", "view", String(runId), "--log-failed"], timeoutMs, 16 * 1024 * 1024);
  if (out === null) return null;
  return out.replace(/\n+$/, "").split("\n").slice(-lines).join("\n");
}
