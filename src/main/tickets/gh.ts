import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { prUrlParts } from "../../shared/pr-url";
import type { GhAuthState } from "../../shared/types";
import { MERGE_STATES, type PrMergeable, type PrMergeState, type PrReviewer, type PrReviewRequest } from "../../shared/progress";

/**
 * 执行的 gh：启动时和登录 shell 的 PATH 读到之后各解析一次（resolveGh）；没找到就用裸 "gh"。
 * null：没找到 gh 且在 Windows 上，不执行（裸 "gh" 会先在仓库目录里找 gh.exe，I5，和 git-path 一样）。
 */
let binary: string | null = "gh";
let resolved = false;
let warned = false;
/** probeGh 的缓存结果；null：还没探测过。applyGhResolution 会清掉。 */
let probed: boolean | null = null;

export function setGhBinary(p: string): void {
  binary = p;
  resolved = true;
}

/** 测试用：回到“还没解析过”的初始状态。 */
export function resetGhBinary(): void {
  binary = "gh";
  resolved = false;
  warned = false;
  probed = null;
}

/**
 * 记录一次解析结果：找到了就（重新）采用；没找到时不降级已有的结果。一直没找到：Windows 上不执行 gh（PR、CI 读成 unknown），
 * 其他平台用裸 "gh"；整个进程只警告一次。
 */
export function applyGhResolution(found: string | null, platform: NodeJS.Platform, log: (msg: string) => void): void {
  const before = binary;
  if (found) {
    setGhBinary(found);
    if (binary !== before) probed = null;
    return;
  }
  if (resolved) return;
  binary = platform === "win32" ? null : "gh";
  if (binary !== before) probed = null;
  if (warned) return;
  warned = true;
  log(platform === "win32" ? "gh not found on PATH: PR and CI checks are disabled" : "gh not found on PATH: falling back to plain gh");
}

/** null：不能执行 gh（Windows 上没找到）。 */
export function ghBinary(): string | null {
  return binary;
}

/** gh 能用：解析到过路径，或者缓存的探测成功了。没解析到时 binary 是裸 "gh"，要靠 probeGh 确认。 */
export function ghAvailable(): boolean {
  return binary !== null && (resolved || probed === true);
}

/** 异步执行 `<gh> --version`，结果缓存到 applyGhResolution 真的换了 binary 为止。从不抛错。 */
export function probeGh(timeoutMs: number): Promise<boolean> {
  const bin = binary;
  if (bin === null) return Promise.resolve(false);
  return new Promise((done) => {
    execFile(bin, ["--version"], { timeout: timeoutMs, windowsHide: true }, (err) => {
      if (binary === bin) probed = !err;
      done(!err);
    });
  });
}

export type GhState = GhAuthState;

/**
 * gh 装没装、登没登录（BTL-249，向导和环境检查用）：`gh auth token` 只看本机的登录记录，不联网。
 * 输出（就是 token）不接，只看退出码。超时当作能用（说不清的时候不吓唬人）。从不抛错。
 */
export function ghAuthState(timeoutMs: number): Promise<GhState> {
  const bin = binary;
  if (bin === null) return Promise.resolve("missing");
  return new Promise((done) => {
    let child;
    try {
      child = spawn(bin, ["auth", "token"], { stdio: "ignore", timeout: timeoutMs, windowsHide: true });
    } catch {
      done("missing");
      return;
    }
    child.on("error", () => done("missing"));
    child.on("exit", (code) => {
      if (code !== null && binary === bin) probed = true;
      done(code === null || code === 0 ? "ok" : "logged_out");
    });
  });
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
  /** PR 的 head 分支名。 */
  headBranch: string;
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
  /** PR 的 base 分支；旧的假数据、读不到时为 null。 */
  baseBranch: string | null;
  title: string | null;
  labels: string[];
  /** 请了 review、还没给的人和团队。 */
  reviewRequests: PrReviewRequest[];
  mergeable: PrMergeable | null;
  mergeState: PrMergeState | null;
  /** PR 描述原文（工作流 G：就绪度的「描述完整」）；只在主进程里用，不存库、不发给页面。旧的假数据没有。 */
  body?: string | null;
}
export interface BranchPr {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
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
function runGh(cwd: string, args: string[], timeoutMs: number, maxBuffer: number, env?: NodeJS.ProcessEnv): Promise<string | null> {
  return runGhDetail(cwd, args, timeoutMs, maxBuffer, env).then((r) => r.stdout);
}

/**
 * 同 runGh，另外带回 stderr（失败时用来分辨原因）。spawnError：进程没起来时的错误代码（ENOENT：没有 gh；不能执行 gh 时也是 ENOENT）；
 * timedOut：超时被杀掉。
 */
export function runGhDetail(
  cwd: string, args: string[], timeoutMs: number, maxBuffer: number, env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string | null; stderr: string; spawnError?: string | null; timedOut?: boolean }> {
  const bin = ghBinary();
  if (bin === null) return Promise.resolve({ stdout: null, stderr: "", spawnError: "ENOENT", timedOut: false });
  return new Promise((done) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      done({
        stdout: e ? null : String(stdout),
        stderr: String(stderr ?? ""),
        spawnError: e && typeof e.code === "string" ? e.code : null,
        // 超过 maxBuffer 时 Node 也会杀掉进程（killed）：那不是超时。
        timedOut: e?.killed === true && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
    });
  });
}

/** 几次 gh 调用的 stderr 拼在一起，空的跳过。 */
function joinStderr(...parts: string[]): string {
  return parts.map((p) => p.trimEnd()).filter((p) => p !== "").join("\n");
}

/** slug（github.com 上是 owner/repo，其他主机是 host/owner/repo）→ gh 的环境变量（两段的 slug 固定 GH_HOST=github.com，不受环境里的 GH_HOST 影响），让 {owner}/{repo} 从它解析而不是从 cwd。没有 slug 返回 undefined。 */
export function repoEnv(repo: string | null | undefined): NodeJS.ProcessEnv | undefined {
  if (!repo) return undefined;
  const parts = repo.split("/");
  return parts.length === 3 ? { GH_REPO: repo, GH_HOST: parts[0] } : { GH_REPO: repo, GH_HOST: "github.com" };
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
/** AI 审查者：和 Copilot 一样当作 reviewer 处理（记 copilot_review、取行内评论）。比较时去掉 [bot] 后缀。 */
const AI_REVIEWERS = ["chatgpt-codex-connector", "copilot-pull-request-reviewer"];
/** gh pr view 给的 author 不带 [bot] 后缀，GitHub App 要靠名字认；authoritative 的判断是 REST 的 user.type（reviewAuthors）。 */
const BOT_LOGINS = [
  "github-actions", "dependabot", "renovate", "coderabbitai", "gemini-code-assist", "sourcery-ai",
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

function labelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const n = str(obj(x)?.name).trim();
    return n ? [n] : [];
  });
}

/** reviewRequests：用户（和 bot）给 login，团队给 slug（没有 slug 用 name）。 */
function reviewRequestsOf(v: unknown): PrReviewRequest[] {
  if (!Array.isArray(v)) return [];
  const out: PrReviewRequest[] = [];
  for (const item of v) {
    const r = obj(item);
    if (!r) continue;
    if (r.__typename === "Team") {
      const name = str(r.slug) || str(r.name);
      if (name) out.push({ kind: "team", name });
    } else if (str(r.login)) out.push({ kind: "user", name: str(r.login) });
  }
  return out;
}

const MERGEABLE: Record<string, PrMergeable> = { MERGEABLE: "mergeable", CONFLICTING: "conflicting", UNKNOWN: "unknown" };

function mergeableOf(v: unknown): PrMergeable | null {
  if (typeof v !== "string" || v === "") return null;
  return MERGEABLE[v] ?? "unknown";
}

function mergeStateOf(v: unknown): PrMergeState | null {
  if (typeof v !== "string" || v === "") return null;
  const l = v.toLowerCase();
  return (MERGE_STATES as readonly string[]).includes(l) ? (l as PrMergeState) : "unknown";
}

const LATEST_STATE: Partial<Record<PrReview["state"], PrReviewer["state"]>> = {
  APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", DISMISSED: "dismissed", COMMENTED: "commented",
};

/**
 * 纯函数：每个人（不是 PR 作者）最新的态度，和 GitHub 一样：有批准 / 要求修改 / 撤销的取最后一条这样的，之后只留评论不改变态度；
 * 只留过评论的记 commented。PENDING（还没提交的 review）不算。bot、Copilot 标 bot。按最后动静从早到晚。
 */
export function latestReviewers(reviews: PrReview[], prAuthor: string): PrReviewer[] {
  const by = new Map<string, PrReviewer>();
  for (const r of [...reviews].sort((a, b) => a.submittedAt - b.submittedAt)) {
    const state = LATEST_STATE[r.state];
    if (!state || !r.author) continue;
    const kind = reviewerKind(r.author, prAuthor);
    if (kind === "author") continue;
    const prev = by.get(r.author);
    const keep = state === "commented" && prev !== undefined && prev.state !== "commented";
    by.set(r.author, { login: r.author, state: keep ? prev.state : state, at: r.submittedAt, bot: kind !== "human" });
  }
  return [...by.values()].sort((a, b) => a.at - b.at);
}

function firstCommitOf(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  const times = v.map((c) => timeOf(obj(c)?.authoredDate)).filter((t): t is number => t !== null);
  return times.length > 0 ? Math.min(...times) : null;
}

/** 纯函数：login 归类。PR 作者 → author；含 copilot 或在 AI_REVIEWERS 里 → copilot；[bot] 结尾或在 BOT_LOGINS 里 → bot；其余 human。 */
export function reviewerKind(login: string, prAuthor: string): "copilot" | "human" | "author" | "bot" {
  if (login === prAuthor) return "author";
  const l = login.toLowerCase();
  if (l.includes("copilot") || AI_REVIEWERS.includes(l.replace(/\[bot\]$/, ""))) return "copilot";
  if (l.endsWith("[bot]") || BOT_LOGINS.includes(l)) return "bot";
  return "human";
}

/**
 * 纯函数：reviewerKind 归成 copilot 的 login 具体是哪个 AI 审查者（Codex 还是 Copilot），其余 null。
 * 工作流程按这个把 bot 的回复对到「请的是哪个 bot」那一轮（BTL-273）。
 */
export function aiReviewerOf(login: string): "copilot" | "codex" | null {
  if (reviewerKind(login, "") !== "copilot") return null;
  return login.toLowerCase().replace(/\[bot\]$/, "") === "chatgpt-codex-connector" ? "codex" : "copilot";
}

const REVIEWS = { REVIEW_REQUIRED: "pending", CHANGES_REQUESTED: "changes_requested", APPROVED: "approved" } as const;

// 这些字段要 gh >= 2.18（headRefOid，2022-10）；更旧的 gh 报 Unknown JSON field，prStatus 返回 null。
// baseRefName、title、labels、reviewRequests、mergeable、mergeStateStatus 比 headRefOid 早，同一个下限（ws-b：叠放树、轮到谁）。
const PR_FIELDS =
  "number,url,state,isDraft,reviewDecision,headRefOid,headRefName,statusCheckRollup,author,reviews,comments,commits,createdAt,mergedAt,closedAt,baseRefName,title,labels,reviewRequests,mergeable,mergeStateStatus,body";

/** gh pr view <ref>：ref 可以是分支名、PR 号或 PR 的 URL。没有 PR、gh 不可用、输出不对都返回 null。 */
export async function prStatus(cwd: string, ref: string, timeoutMs: number): Promise<PrStatus | null> {
  const r = await prRead(cwd, ref, timeoutMs);
  return r === GH_NOT_FOUND ? null : r;
}

/** GitHub 回答了「没有这个仓库 / 这个 PR」：和 gh 不可用、超时、网络断了不一样，gh 是在线的。 */
export const GH_NOT_FOUND = "not_found" as const;

/**
 * gh 的 stderr 是不是在说这个 PR 不存在，而仓库是看得见的（GraphQL 先解析仓库，再解析 PR 号）。
 * 只有这一种当作 PR 确实不在的强信号：仓库级别的「不存在」和 HTTP 404，当前账号看不到私有仓库时也会这么说
 * （gh auth switch、GH_TOKEN 覆盖、细粒度 PAT），按普通读失败处理。
 */
export function ghPrNotFound(stderr: string): boolean {
  return /Could not resolve to a PullRequest\b/i.test(stderr);
}

/**
 * gh 的 stderr 是不是在说仓库或 PR 不存在（或者当前账号看不到）。改了名的仓库 GitHub 会跳转到新名字，不会走到这里。
 * 「Could not resolve host」是网络问题，不算。
 */
export function ghNotFound(stderr: string): boolean {
  return /Could not resolve to a (?:Repository|PullRequest)\b|\bHTTP 404\b/i.test(stderr);
}

/**
 * 同 prStatus，另外分出 GitHub 说仓库看得见、但没有这个 PR 的（GH_NOT_FOUND，见 ghPrNotFound）；
 * null 是 gh 不可用、超时、输出不对，以及仓库解析不到（可能只是当前账号看不到）。
 */
export async function prRead(cwd: string, ref: string, timeoutMs: number): Promise<PrStatus | typeof GH_NOT_FOUND | null> {
  const r = await runGhDetail(cwd, ["pr", "view", ref, "--json", PR_FIELDS], timeoutMs, 8 * 1024 * 1024);
  if (r.stdout === null) return !r.timedOut && !r.spawnError && ghPrNotFound(r.stderr) ? GH_NOT_FOUND : null;
  return parsePr(r.stdout);
}

/**
 * gh repo view <slug>：GitHub 上这个仓库现在的 slug（小写；github.com 以外的主机带主机名，和 parseRemoteSlug 一样）。
 * 改过名、转过 owner 的，GitHub 跳转到新名字，返回的就和传进来的不一样。GH_NOT_FOUND：仓库不在了或看不到；null：gh 失败。
 */
export async function repoCurrentSlug(cwd: string, slug: string, timeoutMs: number): Promise<string | typeof GH_NOT_FOUND | null> {
  // 和别的按 slug 调的 gh 一样带上主机（repoEnv）：环境里的 GH_HOST 指着企业版时，github.com 的 slug 不能去那边查。
  const r = await runGhDetail(cwd, ["repo", "view", slug, "--json", "nameWithOwner"], timeoutMs, 1024 * 1024, repoEnv(slug));
  if (r.stdout === null) return !r.timedOut && !r.spawnError && ghNotFound(r.stderr) ? GH_NOT_FOUND : null;
  const nwo = obj(parseJson(r.stdout))?.nameWithOwner;
  if (typeof nwo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(nwo)) return null;
  const parts = slug.split("/");
  return (parts.length === 3 ? `${parts[0]}/${nwo}` : nwo).toLowerCase();
}

/** gh pr list --head <branch> --state all：一个分支的所有 PR。[] 是没有 PR，null 是 gh 失败（不可用、超时、输出不对）。给了 repo（slug）时列那个仓库的，不看 cwd。 */
export async function prsForBranch(cwd: string, branch: string, timeoutMs: number, repo?: string | null): Promise<BranchPr[] | null> {
  const j = parseJson(
    await runGh(cwd, ["pr", "list", "--head", branch, "--state", "all", "--limit", "30", "--json", "number,url,state,headRefName,createdAt,mergedAt,closedAt"], timeoutMs, 8 * 1024 * 1024, repoEnv(repo)),
  );
  if (!Array.isArray(j)) return null;
  const out: BranchPr[] = [];
  for (const item of j) {
    const r = obj(item);
    if (!r || typeof r.number !== "number" || typeof r.url !== "string") continue;
    if (r.state !== "OPEN" && r.state !== "MERGED" && r.state !== "CLOSED") continue;
    out.push({ number: r.number, url: r.url, state: r.state, headRefName: str(r.headRefName), createdAt: timeOf(r.createdAt), mergedAt: timeOf(r.mergedAt), closedAt: timeOf(r.closedAt) });
  }
  return out;
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
    headBranch: str(r.headRefName),
    checks,
    ci: ciOf(checks),
    author: loginOf(r.author),
    reviews: reviewsOf(r.reviews),
    comments: commentsOf(r.comments),
    firstCommitAt: firstCommitOf(r.commits),
    createdAt: timeOf(r.createdAt),
    mergedAt: timeOf(r.mergedAt),
    closedAt: timeOf(r.closedAt),
    baseBranch: typeof r.baseRefName === "string" && r.baseRefName !== "" ? r.baseRefName : null,
    title: typeof r.title === "string" && r.title !== "" ? r.title : null,
    labels: labelsOf(r.labels),
    reviewRequests: reviewRequestsOf(r.reviewRequests),
    mergeable: mergeableOf(r.mergeable),
    mergeState: mergeStateOf(r.mergeStateStatus),
    body: typeof r.body === "string" ? r.body : null,
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
export async function reviewComments(cwd: string, number: number, timeoutMs: number, repo?: string | null): Promise<PrComment[] | null> {
  return (await reviewCommentsDetail(cwd, number, timeoutMs, repo)).data;
}

/** 同 reviewComments，另外带回两次 gh 调用的 stderr。 */
async function reviewCommentsDetail(cwd: string, number: number, timeoutMs: number, repo?: string | null): Promise<{ data: PrComment[] | null; stderr: string }> {
  const env = repoEnv(repo);
  const c = await runGhDetail(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate", "--jq", ".[]"], timeoutMs, 8 * 1024 * 1024, env);
  const j = parseLines(c.stdout);
  if (j === null) return { data: null, stderr: c.stderr };
  const rv = await runGhDetail(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--paginate", "--jq", ".[] | {id, node_id}"], timeoutMs, 8 * 1024 * 1024, env);
  const stderr = joinStderr(c.stderr, rv.stderr);
  const reviews = parseLines(rv.stdout);
  if (reviews === null) return { data: null, stderr };
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
  return { data: out, stderr };
}

export interface ReviewAuthors {
  /** user.type 是 Bot 的 review（GraphQL node id）。 */
  botReviewIds: Set<string>;
  /** 这些 review 里 Bot 的 login（小写、去掉 [bot]），用来认同一个人的评论。 */
  botLogins: Set<string>;
}

/** REST 的 reviews 列表里谁是 Bot：gh pr view 给的 author 没有 [bot] 后缀和类型。失败返回 null（调用方退回按名字认）。 */
export async function reviewAuthors(cwd: string, number: number, timeoutMs: number, repo?: string | null): Promise<ReviewAuthors | null> {
  return (await reviewAuthorsDetail(cwd, number, timeoutMs, repo)).data;
}

/** 同 reviewAuthors，另外带回 stderr。 */
async function reviewAuthorsDetail(cwd: string, number: number, timeoutMs: number, repo?: string | null): Promise<{ data: ReviewAuthors | null; stderr: string }> {
  const res = await runGhDetail(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--paginate", "--jq", ".[] | {node_id, user: {login: .user.login, type: .user.type}}"], timeoutMs, 8 * 1024 * 1024, repoEnv(repo));
  const rows = parseLines(res.stdout);
  if (rows === null) return { data: null, stderr: res.stderr };
  const out: ReviewAuthors = { botReviewIds: new Set(), botLogins: new Set() };
  for (const item of rows) {
    const r = obj(item);
    const user = obj(r?.user);
    if (!r || !user || user.type !== "Bot") continue;
    if (typeof r.node_id === "string" && r.node_id !== "") out.botReviewIds.add(r.node_id);
    if (typeof user.login === "string" && user.login !== "") out.botLogins.add(user.login.toLowerCase().replace(/\[bot\]$/, ""));
  }
  return { data: out, stderr: res.stderr };
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
export async function failedLog(cwd: string, runId: number, lines: number, timeoutMs: number, repo?: string | null): Promise<string | null> {
  return (await failedLogDetail(cwd, runId, lines, timeoutMs, repo)).log;
}

/** 取失败日志的结果。log 为 null 时 error 是一行原因，permanent 说这个 run 的日志以后也取不到。 */
export interface FailedLogResult {
  log: string | null;
  /** 失败的原因：gh 的 stderr 第一行（截断）、超时、gh 起不来；成功为 null。 */
  error: string | null;
  /** GitHub 说这个 run 的日志不会再有了：过了保留期（410）、当前账号没权限（403，限流除外）、仓库不存在。 */
  permanent: boolean;
  /** 404、log not found：run 刚结束时日志归档可能还没好，也会短暂 404。调用方连着两次都是这样才当永久。 */
  missing: boolean;
}

/** 日志里记的 stderr 摘要最多这么长。 */
const GH_ERROR_CHARS = 200;

/** gh 失败的一行摘要：超时、gh 起不来，否则 stderr 第一行非空的（截断）。 */
export function ghErrorSummary(r: { stderr: string; spawnError?: string | null; timedOut?: boolean }, timeoutMs: number): string {
  if (r.timedOut) return `timed out after ${timeoutMs / 1000}s`;
  const line = r.stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  if (line) return line.length > GH_ERROR_CHARS ? `${line.slice(0, GH_ERROR_CHARS)}…` : line;
  return r.spawnError ? `gh failed (${r.spawnError})` : "gh failed with no output";
}

/**
 * gh run view --log-failed 的 stderr 在说这个 run 的日志拿不到：gone 是以后也拿不到（410、403 没权限、仓库不存在），
 * missing 是 404、log not found（刚跑完的 run 也会这样，再试一次才知道），null 是临时的。
 * 403 只算没权限，限流（rate limit）是临时的；401（没登录、token 过期）、网络、超时、「still in progress」都是临时的。
 */
export function ghLogGone(stderr: string): "gone" | "missing" | null {
  // 限流、组织的 SAML SSO 没授权（403，用户授权后就能取）：都会好，不算永久。
  if (/rate limit|SAML/i.test(stderr)) return null;
  if (/\bHTTP (?:403|410)\b|Could not resolve to a Repository\b|Resource not accessible/i.test(stderr)) return "gone";
  if (/\bHTTP 404\b|\blog not found\b/i.test(stderr)) return "missing";
  return null;
}

/** 同 failedLog，另外带回失败的原因、是不是永久的（PrWatcher 用来决定还取不取、日志里写什么）。 */
export async function failedLogDetail(cwd: string, runId: number, lines: number, timeoutMs: number, repo?: string | null): Promise<FailedLogResult> {
  const r = await runGhDetail(cwd, ["run", "view", String(runId), "--log-failed"], timeoutMs, 16 * 1024 * 1024, repoEnv(repo));
  if (r.stdout === null) {
    const gone = r.timedOut || r.spawnError ? null : ghLogGone(r.stderr);
    return { log: null, error: ghErrorSummary(r, timeoutMs), permanent: gone === "gone", missing: gone === "missing" };
  }
  return { log: r.stdout.replace(/\n+$/, "").split("\n").slice(-lines).join("\n"), error: null, permanent: false, missing: false };
}

export const LESSON_GH_TIMEOUT_MS = 15_000;

export interface MergedPr {
  number: number;
  mergedAt: string;
  headRefName: string;
}

/** gh pr list --state merged：after 不为空时只要合并时间晚于它的。按 mergedAt 升序；失败返回 null。 */
export async function mergedPrs(cwd: string, after: string | null, limit: number, timeoutMs: number): Promise<MergedPr[] | null> {
  const args = ["pr", "list", "--state", "merged", "--limit", String(limit), "--json", "number,mergedAt,headRefName", "--jq", ".[]"];
  if (after !== null) args.push("--search", `merged:>${after}`);
  const j = parseLines(await runGh(cwd, args, timeoutMs, 8 * 1024 * 1024));
  if (j === null) return null;
  const out: MergedPr[] = [];
  for (const item of j) {
    const r = obj(item);
    if (!r || typeof r.number !== "number" || typeof r.mergedAt !== "string" || timeOf(r.mergedAt) === null) continue;
    out.push({ number: r.number, mergedAt: r.mergedAt, headRefName: str(r.headRefName) });
  }
  return out.sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
}

/** 别人请你 review 的一个 PR（UI 重做第 1 层）。slug 是 prUrlParts 的形式：企业版主机带 host 前缀。 */
export interface ReviewRequestedPr { url: string; slug: string; number: number; title: string; author: string }
export const REVIEW_SEARCH_TIMEOUT_MS = 30_000;

/**
 * gh search prs --review-requested=@me --state=open：一次调用覆盖账号能看到的所有仓库（只查 gh 的默认主机）。cwd 用 home。
 * 失败返回 null，从不抛错。slug、number 从 url 取；解析不了的项跳过。
 */
export async function reviewRequestedPrs(timeoutMs: number): Promise<ReviewRequestedPr[] | null> {
  const args = ["search", "prs", "--review-requested=@me", "--state=open", "--limit", "100", "--json", "number,title,url,repository,author,updatedAt"];
  const j = parseJson(await runGh(homedir(), args, timeoutMs, 8 * 1024 * 1024));
  if (!Array.isArray(j)) return null;
  const out: ReviewRequestedPr[] = [];
  for (const item of j) {
    const r = obj(item);
    if (!r || typeof r.url !== "string") continue;
    const parts = prUrlParts(r.url);
    if (!parts) continue;
    out.push({ url: r.url, slug: parts.slug, number: parts.number, title: str(r.title), author: str(obj(r.author)?.login) });
  }
  return out;
}

export interface PrCommit {
  oid: string;
  committedDate: string;
  headline: string;
  body: string;
}

export interface PrLessonData {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  headRefName: string;
  mergedAt: string | null;
  reviews: PrReview[];
  comments: PrComment[];
  inline: PrComment[];
  commits: PrCommit[];
  /** reviewAuthors 的结果；拿不到时为空集合。 */
  botLogins: Set<string>;
}

function commitsOf(v: unknown): PrCommit[] {
  if (!Array.isArray(v)) return [];
  const out: PrCommit[] = [];
  for (const item of v) {
    const r = obj(item);
    if (!r || typeof r.oid !== "string") continue;
    out.push({ oid: r.oid, committedDate: str(r.committedDate), headline: str(r.messageHeadline), body: str(r.messageBody) });
  }
  return out;
}

/** 一个 PR 做规矩分析要的全部数据：gh pr view，再加行内评论和 bot 名单。pr view 或行内评论失败返回 null；bot 名单拿不到按空集合算。 */
export async function prLessonData(cwd: string, number: number, timeoutMs: number): Promise<PrLessonData | null> {
  return (await prLessonDataDetail(cwd, number, timeoutMs)).data;
}

/** 同 prLessonData，另外带回各次 gh 调用的 stderr（失败时给运行记录看原因）。 */
export async function prLessonDataDetail(cwd: string, number: number, timeoutMs: number): Promise<{ data: PrLessonData | null; stderr: string }> {
  const fields = "number,title,body,url,author,headRefName,mergedAt,reviews,comments,commits";
  const view = await runGhDetail(cwd, ["pr", "view", String(number), "--json", fields], timeoutMs, 16 * 1024 * 1024);
  const j = obj(parseJson(view.stdout));
  if (!j || typeof j.number !== "number") return { data: null, stderr: joinStderr(view.stderr) };
  const inline = await reviewCommentsDetail(cwd, number, timeoutMs);
  if (inline.data === null) return { data: null, stderr: joinStderr(view.stderr, inline.stderr) };
  const authors = await reviewAuthorsDetail(cwd, number, timeoutMs);
  const stderr = joinStderr(view.stderr, inline.stderr, authors.stderr);
  const data: PrLessonData = {
    number: j.number,
    title: str(j.title),
    body: str(j.body),
    url: str(j.url),
    author: loginOf(j.author),
    headRefName: str(j.headRefName),
    mergedAt: typeof j.mergedAt === "string" && j.mergedAt !== "" ? j.mergedAt : null,
    reviews: reviewsOf(j.reviews),
    comments: commentsOf(j.comments),
    inline: inline.data,
    commits: commitsOf(j.commits),
    botLogins: authors.data?.botLogins ?? new Set(),
  };
  return { data, stderr };
}

/** gh api compare：两个提交之间改了哪些文件和 patch。没有 patch 的文件（二进制）patch 为 ""。失败返回 null。 */
export async function compareFiles(cwd: string, base: string, head: string, timeoutMs: number, repo?: string | null): Promise<{ filename: string; patch: string }[] | null> {
  const rows = parseLines(await runGh(cwd, ["api", `repos/{owner}/{repo}/compare/${base}...${head}`, "--jq", ".files[] | {filename, patch}"], timeoutMs, 8 * 1024 * 1024, repoEnv(repo)));
  if (rows === null) return null;
  const out: { filename: string; patch: string }[] = [];
  for (const item of rows) {
    const r = obj(item);
    if (!r || typeof r.filename !== "string") continue;
    out.push({ filename: r.filename, patch: typeof r.patch === "string" ? r.patch : "" });
  }
  return out;
}

/** 一个 PR 改了哪些文件（gh api pulls/N/files，合并后也能读）：只要文件名，最多 GitHub 给的 3000 个。失败返回 null。 */
export async function prFileNames(cwd: string, number: number, timeoutMs: number, repo?: string | null): Promise<string[] | null> {
  const out = await runGh(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/files`, "--paginate", "--jq", ".[].filename"], timeoutMs, 8 * 1024 * 1024, repoEnv(repo));
  if (out === null) return null;
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** 度量（ws-h）的 gh 调用：revert 扫描、基线回填、重开。 */
export const METRICS_GH_TIMEOUT_MS = 20_000;

export interface SearchedPr {
  number: number;
  url: string;
  title: string;
  body: string;
  createdAt: number | null;
  mergedAt: number | null;
}

/**
 * gh pr list --state merged --search <search>（仓库由 GH_REPO 指定，不看 cwd）。author 给了就加 --author（"@me" = 当前登录的人）。
 * 只读；失败返回 null。
 */
export async function searchMergedPrs(cwd: string, repo: string, search: string, limit: number, timeoutMs: number, author?: string): Promise<SearchedPr[] | null> {
  const args = ["pr", "list", "--state", "merged", "--limit", String(limit), "--search", search, "--json", "number,url,title,body,createdAt,mergedAt"];
  if (author) args.push("--author", author);
  const j = parseJson(await runGh(cwd, args, timeoutMs, 16 * 1024 * 1024, repoEnv(repo)));
  if (!Array.isArray(j)) return null;
  const out: SearchedPr[] = [];
  for (const item of j) {
    const r = obj(item);
    if (!r || typeof r.number !== "number" || typeof r.url !== "string") continue;
    out.push({ number: r.number, url: r.url, title: str(r.title), body: str(r.body), createdAt: timeOf(r.createdAt), mergedAt: timeOf(r.mergedAt) });
  }
  return out;
}

export interface IssueEvent {
  id: string;
  event: string;
  at: number;
}

/** gh api repos/{owner}/{repo}/issues/N/events：PR 的时间线事件（reopened、closed …）。只读；失败返回 null。 */
export async function issueEvents(cwd: string, repo: string, number: number, timeoutMs: number): Promise<IssueEvent[] | null> {
  const rows = parseLines(
    await runGh(cwd, ["api", `repos/{owner}/{repo}/issues/${number}/events`, "--paginate", "--jq", ".[] | {id, event, created_at}"], timeoutMs, 8 * 1024 * 1024, repoEnv(repo)),
  );
  if (rows === null) return null;
  const out: IssueEvent[] = [];
  for (const item of rows) {
    const r = obj(item);
    const at = timeOf(r?.created_at);
    if (!r || (typeof r.id !== "number" && typeof r.id !== "string") || typeof r.event !== "string" || at === null) continue;
    out.push({ id: String(r.id), event: r.event, at });
  }
  return out;
}

/**
 * gh pr create（导出成 lint 的分支，工作流 E2）。只由对外动作开关放行后调用；body 走 stdin，不进命令行。
 * 成功返回 PR 链接（stdout 最后一行）；失败抛错（带 gh 的报错）。
 */
export function createPr(o: { cwd: string; branch: string; base: string; title: string; body: string; timeoutMs?: number }): Promise<string> {
  const bin = binary;
  if (bin === null) return Promise.reject(new Error("gh not found"));
  const args = ["pr", "create", "--head", o.branch, "--title", o.title, "--body-file", "-", ...(o.base ? ["--base", o.base] : [])];
  return new Promise((done, fail) => {
    const child = execFile(bin, args, { cwd: o.cwd, timeout: o.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, stdout, stderr) => {
      if (err) {
        fail(new Error(String(stderr || err.message).trim().slice(0, 500)));
        return;
      }
      const url = String(stdout).trim().split(/\r?\n/).pop() ?? "";
      if (/^https?:\/\//.test(url)) done(url);
      else fail(new Error(`unexpected gh output: ${url.slice(0, 200)}`));
    });
    child.stdin?.end(o.body);
  });
}

/** PR 的描述原文（工作流 G：贴简报前取当前描述）。读不到返回 null。ref 可以是 PR 号或链接。 */
export async function prBody(cwd: string, ref: string, timeoutMs = 30_000): Promise<string | null> {
  const j = parseJson(await runGh(cwd, ["pr", "view", ref, "--json", "body"], timeoutMs, 4 * 1024 * 1024));
  if (typeof j !== "object" || j === null) return null;
  const b = (j as Record<string, unknown>).body;
  return typeof b === "string" ? b : null;
}

/**
 * gh pr edit --body-file -（工作流 G：把简报块写进描述）。只由对外动作放行后调用；正文走 stdin。失败抛错（带 gh 的报错）。
 */
export function editPrBody(o: { cwd: string; ref: string; body: string; timeoutMs?: number }): Promise<void> {
  const bin = binary;
  if (bin === null) return Promise.reject(new Error("gh not found"));
  return new Promise((done, fail) => {
    const child = execFile(bin, ["pr", "edit", o.ref, "--body-file", "-"], { cwd: o.cwd, timeout: o.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, _stdout, stderr) => {
      if (err) fail(new Error(String(stderr || err.message).trim().slice(0, 500)));
      else done();
    });
    child.stdin?.end(o.body);
  });
}
