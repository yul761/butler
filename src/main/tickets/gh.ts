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
): Promise<{ stdout: string | null; stderr: string; spawnError?: string | null; timedOut?: boolean; raw?: string }> {
  const bin = ghBinary();
  if (bin === null) return Promise.resolve({ stdout: null, stderr: "", spawnError: "ENOENT", timedOut: false, raw: "" });
  return new Promise((done) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      done({
        stdout: e ? null : String(stdout),
        stderr: String(stderr ?? ""),
        // 退出码不是 0 时也有用的输出：GraphQL 部分出错（gh 退出 1，JSON 照打）、gh api -i 的 304。
        raw: String(stdout ?? ""),
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

/** 关 PR 之前核对的：head 在不在 fork 上（isCrossRepository）、head 分支、还开着没有（BTL-270 审查）。 */
export interface PrHead {
  crossRepo: boolean;
  /** head 所在仓库的 owner（headRepositoryOwner.login）；head 仓库删了时是 null。 */
  headOwner: string | null;
  /** head 所在仓库的名字（headRepository.name）；读不到（仓库删了）是 null。fork 上的 head 要和 origin 的 owner、名字都对上才算本 ticket 的。 */
  headRepo: string | null;
  headBranch: string;
  /** PR 现在的目标分支（baseRefName）。 */
  baseBranch: string;
  open: boolean;
}

const PR_HEAD_FIELDS = "isCrossRepository,headRepositoryOwner,headRepository,headRefName,baseRefName,state";

/** 核对 head 失败：error 是给人看的原因；ghTooOld 是 gh 太老、不认识要读的字段（headRepositoryOwner、headRepository、baseRefName），要升级 gh。 */
export interface PrHeadError {
  error: string;
  ghTooOld?: true;
}

/** gh 不认识 --json 的某个字段（版本太老）时的报错。 */
const UNKNOWN_JSON_FIELD = /unknown json field/i;

/** gh pr view <ref> --json PR_HEAD_FIELDS 的输出 → PrHead；输出里缺老版 gh 不给的字段是 "too_old"；别的不对是 null。 */
export function parsePrHead(text: string | null): PrHead | "too_old" | null {
  const j = obj(parseJson(text));
  if (j && (!("headRepositoryOwner" in j) || !("headRepository" in j) || !("baseRefName" in j))) return "too_old";
  if (!j || typeof j.isCrossRepository !== "boolean" || typeof j.headRefName !== "string" || typeof j.baseRefName !== "string" || typeof j.state !== "string") return null;
  const owner = obj(j.headRepositoryOwner)?.login;
  const name = obj(j.headRepository)?.name;
  return {
    crossRepo: j.isCrossRepository, headOwner: typeof owner === "string" && owner ? owner : null, headRepo: typeof name === "string" && name ? name : null, headBranch: j.headRefName, baseBranch: j.baseRefName, open: j.state === "OPEN",
  };
}

/**
 * 关 ticket 时实时核对一个 PR 的 head（BTL-270 审查）：head 在哪个 owner 下、分支名、目标分支、还开不开着。
 * gh 失败、超时、输出不对时是 { error }（给人看的原因），调用方当作「核对失败、可以重试」；gh 太老、不认识要读的字段时带 ghTooOld。
 */
export async function prHead(cwd: string, ref: string, timeoutMs: number): Promise<PrHead | PrHeadError> {
  const r = await runGhDetail(cwd, ["pr", "view", ref, "--json", PR_HEAD_FIELDS], timeoutMs, 1024 * 1024);
  if (r.stdout === null) {
    const error = ghErrorSummary(r, timeoutMs);
    return UNKNOWN_JSON_FIELD.test(r.stderr) ? { error, ghTooOld: true } : { error };
  }
  const h = parsePrHead(r.stdout);
  if (h === "too_old") return { error: "gh pr view did not return headRepositoryOwner / headRepository / baseRefName", ghTooOld: true };
  return h ?? { error: "gh pr view returned unexpected output" };
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
  return parsePrObject(parseJson(text));
}

/** gh pr view --json PR_FIELDS 那个形状的对象 → PrStatus；批量 GraphQL 读到的先转成这个形状（prBatch）。 */
function parsePrObject(j: unknown): PrStatus | null {
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
  const c = await restList(cwd, `repos/{owner}/{repo}/pulls/${number}/comments`, ".[]", timeoutMs, env);
  const j = c.data;
  if (j === null) return { data: null, stderr: c.stderr };
  const rv = await restList(cwd, `repos/{owner}/{repo}/pulls/${number}/reviews`, ".[] | {id, node_id}", timeoutMs, env);
  const stderr = joinStderr(c.stderr, rv.stderr);
  const reviews = rv.data;
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
  const res = await restList(cwd, `repos/{owner}/{repo}/pulls/${number}/reviews`, ".[] | {node_id, user: {login: .user.login, type: .user.type}}", timeoutMs, repoEnv(repo));
  const rows = res.data;
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
  // REST 带 ETag（BTL-276）：没变时 304，不占限额。和 gh run list --branch --limit 20 一样：按时间倒序的最近 20 个。
  // 只要第一页（不翻页）：有下一页也照样记 ETag。
  const got = await ghApiGet(cwd, `repos/{owner}/{repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`, timeoutMs, 4 * 1024 * 1024, undefined, { firstPageOnly: true });
  const list = obj(got === "timeout" ? null : got?.body)?.workflow_runs;
  if (!Array.isArray(list)) return null;
  const runs = list.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && typeof (x as Record<string, unknown>).head_sha === "string");
  if (runs.length === 0) return null;
  const headSha = runs[0].head_sha as string;
  const checks: CiCheck[] = runs
    .filter((r) => r.head_sha === headSha)
    .map((r) => ({ name: str(r.name), state: runState(r.status, r.conclusion), runId: typeof r.id === "number" ? r.id : null }));
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

// ---- 带 ETag 的 REST（BTL-276） ----

/** 记着这么多个 REST 响应的 ETag 和内容，多了丢最早的。 */
const ETAG_MAX = 500;
const etags = new Map<string, { etag: string; body: unknown }>();

/** 测试用：清掉 ETag 缓存。 */
export function resetGhEtags(): void {
  etags.clear();
}

/** gh api -i 的输出：状态行、头、空行、正文。 */
function parseHttp(raw: string): { status: number; headers: Map<string, string>; body: string } | null {
  const m = /^HTTP\/\S+\s+(\d{3})[^\n]*\n/.exec(raw);
  if (!m) return null;
  const sep = /\r?\n\r?\n/.exec(raw);
  const head = sep ? raw.slice(0, sep.index) : raw;
  const body = sep ? raw.slice(sep.index + sep[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return { status: Number(m[1]), headers, body };
}

/**
 * gh api <path> 的 GET，带上次的 ETag（If-None-Match）：没变时 GitHub 回 304，不算进限额，用上次的内容。
 * 返回正文（JSON）和有没有下一页（Link rel="next"）；失败、不是 JSON 返回 null，超时、起不来返回 "timeout"。path 里的 {owner}/{repo} 由 gh 按 cwd / GH_REPO 填。
 * 有下一页的默认不记 ETag（调用方要翻页，第一页的 304 没用）；firstPageOnly：调用方只要第一页，照记。
 * perPage：path 里的一页条数。正文是数组、正好满一页时也当可能有下一页（不记 ETag）：正序的列表（评论、review）第 101 条出现在第二页，
 * 第一页的内容和 ETag 都不变，记着 ETag 就一直 304、永远不翻页。
 * 304 时 stderr 为空：gh 打的「HTTP 304」不是错误。
 */
export async function ghApiGet(
  cwd: string, path: string, timeoutMs: number, maxBuffer: number, env?: NodeJS.ProcessEnv, o: { firstPageOnly?: boolean; perPage?: number } = {},
): Promise<{ body: unknown; next: boolean; stderr: string } | "timeout" | null> {
  const key = `${cwd}\0${env?.GH_HOST ?? ""}\0${env?.GH_REPO ?? ""}\0${path}`;
  const known = etags.get(key);
  const args = ["api", path, "-i", ...(known ? ["-H", `If-None-Match: ${known.etag}`] : [])];
  const r = await runGhDetail(cwd, args, timeoutMs, maxBuffer, env);
  if (r.timedOut || r.spawnError) return "timeout";
  const http = parseHttp(r.raw ?? r.stdout ?? "");
  if (!http) return null;
  if (http.status === 304 && known) {
    etags.delete(key);
    etags.set(key, known);
    return { body: known.body, next: false, stderr: "" };
  }
  if (http.status !== 200 || r.stdout === null) return null;
  const body = parseJson(http.body);
  if (body === null) return null;
  const full = o.perPage !== undefined && Array.isArray(body) && body.length >= o.perPage;
  const next = full || /<[^>]*>;\s*rel="next"/.test(http.headers.get("link") ?? "");
  const etag = http.headers.get("etag");
  etags.delete(key);
  if (etag && (!next || o.firstPageOnly)) {
    etags.set(key, { etag, body });
    if (etags.size > ETAG_MAX) etags.delete(etags.keys().next().value as string);
  }
  return { body, next, stderr: r.stderr };
}

/** REST 列表一页的条数。 */
const REST_PAGE = 100;

/**
 * REST 列表：先按一页 100 个带 ETag 取；不止一页（或正好满一页）时退回原来的 --paginate --jq（jq 只是挑字段，挑出来的是全对象的子集）。
 * data 为 null 是失败。
 */
async function restList(cwd: string, path: string, jq: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ data: unknown[] | null; stderr: string }> {
  const one = await ghApiGet(cwd, `${path}?per_page=${REST_PAGE}`, timeoutMs, 8 * 1024 * 1024, env, { perPage: REST_PAGE });
  // 超时、起不来：不再翻页重试一遍（又要等一个超时），算读失败。
  if (one === "timeout") return { data: null, stderr: "" };
  if (one && !one.next && Array.isArray(one.body)) return { data: one.body, stderr: one.stderr };
  const r = await runGhDetail(cwd, ["api", path, "--paginate", "--jq", jq], timeoutMs, 8 * 1024 * 1024, env);
  return { data: parseLines(r.stdout), stderr: joinStderr(one?.stderr ?? "", r.stderr) };
}

// ---- 批量读 PR（BTL-276） ----

/** 一次批量读里每个 PR 的结果：sig 是便宜字段的指纹（变了才要全读）；pr 只有全读才有（截断了也是 null，调用方单独读）。 */
export type PrBatchItem = { sig: string; pr: PrStatus | null } | typeof GH_NOT_FOUND | null;
export interface PrBatchResult {
  /** 没出现的号、值为 null：这个 PR 这次没读到，调用方退回 gh pr view。 */
  prs: Map<number, PrBatchItem>;
  rate: { cost: number; remaining: number; resetAt: number | null } | null;
}

/** 全读里列表最多取这么多；超过（totalCount 更大、还有下一页）就当没读到，退回 gh pr view。 */
const BATCH_LIST_MAX = 100;

/** 便宜字段里，最近这么多条评论 / review 带上改动时间、这么多个 review 请求带上是谁。 */
const CHEAP_RECENT = 20;

// 便宜字段：updatedAt 不跟着 CI、合并状态变，同一秒里的第二条评论也不一定变，所以另带评论 / review 的条数和每个检查的 id 与结果
// （重跑会换新的 check run id；两个检查互换结果也看得出来）。base / head 分支（栈依赖它）、标题、链接（仓库改名）、
// review 请求（轮到谁）、标签数、描述和最近评论 / review 的改动时间也带上：这些变了不一定动 updatedAt。点数按连接算、不按条数，这些几乎不多花。
const CHEAP_FIELDS = `number url state updatedAt lastEditedAt headRefOid headRefName baseRefName title isDraft reviewDecision mergeable mergeStateStatus
  comments { totalCount } reviews { totalCount }
  labelCount: labels { totalCount }
  requested: reviewRequests(first: ${CHEAP_RECENT}) { totalCount nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug } } } }
  recentComments: comments(last: ${CHEAP_RECENT}) { nodes { id lastEditedAt } }
  recentReviews: reviews(last: ${CHEAP_RECENT}) { nodes { id state lastEditedAt } }
  tip: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: ${BATCH_LIST_MAX}) { totalCount nodes { __typename
    ... on CheckRun { databaseId status conclusion } ... on StatusContext { context state } } } } } } }`;
const FULL_FIELDS = `createdAt mergedAt closedAt body author { login }
  labels(first: ${BATCH_LIST_MAX}) { totalCount nodes { name } }
  reviewRequests(first: ${BATCH_LIST_MAX}) { totalCount nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug name } } } }
  allReviews: reviews(first: ${BATCH_LIST_MAX}) { totalCount nodes { id author { login } state body submittedAt } }
  allComments: comments(first: ${BATCH_LIST_MAX}) { totalCount nodes { id author { login } body createdAt url } }
  commits(first: ${BATCH_LIST_MAX}) { nodes { commit { authoredDate } } }
  head: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${BATCH_LIST_MAX}) { pageInfo { hasNextPage } nodes { __typename
    ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } }`;

/** 这个仓库这些 PR 的一个 GraphQL 查询：每个 PR 一个别名 p<号>。 */
export function prBatchQuery(numbers: number[], mode: "cheap" | "full"): string {
  if (!numbers.every(prBatchable)) throw new Error("prBatchQuery: PR numbers must be 1..2^31-1");
  const fields = mode === "full" ? `${CHEAP_FIELDS}\n  ${FULL_FIELDS}` : CHEAP_FIELDS;
  const prs = numbers.map((n) => `    p${n}: pullRequest(number: ${n}) { ...F }`).join("\n");
  return `query($owner: String!, $name: String!) {\n  rateLimit { cost remaining resetAt }\n  repository(owner: $owner, name: $name) {\n${prs}\n  }\n}\nfragment F on PullRequest {\n  ${fields}\n}`;
}

const nodesOf = (v: unknown): unknown[] => {
  const n = obj(v)?.nodes;
  return Array.isArray(n) ? n : [];
};
const truncated = (v: unknown): boolean => {
  const t = obj(v)?.totalCount;
  return typeof t === "number" && t > BATCH_LIST_MAX;
};

/**
 * 便宜字段的指纹：链接、状态、更新 / 改动时间、head（sha 和分支）、base、标题、draft、review 结论、合并状态、评论 / review / 标签条数、
 * review 请求、最近评论 / review 的改动、CI 汇总和每个检查（id、状态、结果）。
 */
function prSigOf(n: Record<string, unknown>): string {
  const r = obj(obj(obj(nodesOf(n.tip)[0])?.commit)?.statusCheckRollup);
  const ctx = obj(r?.contexts);
  const checks = nodesOf(ctx).map((x) => {
    const c = obj(x);
    return c?.__typename === "StatusContext" ? `s:${str(c.context)}:${str(c.state)}` : `c:${String(c?.databaseId ?? "")}:${str(c?.status)}:${str(c?.conclusion)}`;
  }).sort();
  const count = (v: unknown) => (typeof obj(v)?.totalCount === "number" ? obj(v)!.totalCount : null);
  const requested = nodesOf(n.requested).map((x) => {
    const who = obj(obj(x)?.requestedReviewer);
    return `${str(who?.__typename)}:${str(who?.login ?? who?.slug)}`;
  }).sort();
  const edits = (v: unknown) => nodesOf(v).map((x) => {
    const c = obj(x);
    return `${str(c?.id)}:${str(c?.state)}:${str(c?.lastEditedAt)}`;
  });
  return JSON.stringify([
    n.url, n.state, n.updatedAt, n.lastEditedAt ?? null, n.headRefOid, n.headRefName ?? null, n.baseRefName ?? null, n.title ?? null,
    n.isDraft, n.reviewDecision, n.mergeable, n.mergeStateStatus,
    count(n.comments), count(n.reviews), count(n.labelCount), count(n.requested), requested, edits(n.recentComments), edits(n.recentReviews),
    r ? r.state : null, count(ctx), checks,
  ]);
}

/** 全读的节点 → gh pr view --json 的形状；列表被截断了返回 null。 */
function prViewShape(n: Record<string, unknown>): Record<string, unknown> | null {
  const contexts = obj(obj(obj(nodesOf(n.head)[0])?.commit)?.statusCheckRollup)?.contexts;
  if (obj(obj(contexts)?.pageInfo)?.hasNextPage === true) return null;
  if ([n.labels, n.reviewRequests, n.allReviews, n.allComments].some(truncated)) return null;
  return {
    ...n,
    labels: nodesOf(n.labels),
    reviewRequests: nodesOf(n.reviewRequests).map((x) => obj(x)?.requestedReviewer).filter((x) => x != null),
    reviews: nodesOf(n.allReviews),
    comments: nodesOf(n.allComments),
    // 按时间顺序的前 100 个：最早的那个一定在里面（firstCommitOf 只要它）。
    commits: nodesOf(n.commits).map((x) => obj(x)?.commit).filter((x) => x != null),
    statusCheckRollup: nodesOf(contexts),
  };
}

/**
 * 一个仓库的一批 PR，一次 gh api graphql（每个 PR 一个别名）。cheap 只取便宜字段（指纹），full 另外取 gh pr view 要的全部字段。
 * 某个 PR「没有这个 PR」（NOT_FOUND，和 ghPrNotFound 一样认）→ GH_NOT_FOUND；它别的错、截断了 → null（调用方单独读）。
 * 整个调用失败（gh 失败、超时、不是 JSON、仓库解析不到）返回 null：调用方全部退回 gh pr view。
 */
export async function prBatch(cwd: string, slug: string, numbers: number[], mode: "cheap" | "full", timeoutMs: number): Promise<PrBatchResult | null> {
  const parts = slug.split("/");
  const ok = [...new Set(numbers)].filter(prBatchable);
  if (ok.length === 0 || parts.length < 2) return null;
  const [owner, name] = parts.slice(-2);
  // 一次查太多个别名，查询会很大、GraphQL 可能整个拒掉：分块查，一块失败只是那几个号退回 gh pr view。
  const prs = new Map<number, PrBatchItem>();
  let rate: PrBatchResult["rate"] = null;
  let any = false;
  for (let i = 0; i < ok.length; i += PR_BATCH_CHUNK) {
    const chunk = ok.slice(i, i + PR_BATCH_CHUNK);
    const r = await runGhDetail(
      cwd, ["api", "graphql", "-f", `query=${prBatchQuery(chunk, mode)}`, "-f", `owner=${owner}`, "-f", `name=${name}`], timeoutMs, 16 * 1024 * 1024, repoEnv(slug),
    );
    if (r.timedOut || r.spawnError) continue;
    // 有 PR 出错时 gh 退出 1，但 JSON 照样打在 stdout 上。
    const got = prBatchResult(r.stdout ?? r.raw ?? null, chunk, mode);
    if (!got) continue;
    any = true;
    rate = got.rate ?? rate;
    for (const [n, item] of got.prs) prs.set(n, item);
  }
  return any ? { prs, rate } : null;
}

/** prBatch 一次 GraphQL 最多查这么多个 PR。 */
export const PR_BATCH_CHUNK = 50;
/** GraphQL 的 Int 是 32 位有符号：PR 号在 1..2^31-1 才能放进查询（别的照原来 gh pr view 读）。 */
export function prBatchable(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 1 && n <= 0x7fffffff;
}

/** 纯函数：prBatch 的输出 → 每个 PR 的结果（见 prBatch）。 */
export function prBatchResult(text: string | null, numbers: number[], mode: "cheap" | "full"): PrBatchResult | null {
  const j = obj(parseJson(text));
  const repo = obj(obj(j?.data)?.repository);
  if (!repo) return null;
  const rl = obj(obj(j?.data)?.rateLimit);
  const rate = rl && typeof rl.remaining === "number" ? { cost: typeof rl.cost === "number" ? rl.cost : 0, remaining: rl.remaining, resetAt: timeOf(rl.resetAt) } : null;
  const errorOf = new Map<number, string>();
  for (const e of Array.isArray(j?.errors) ? j.errors : []) {
    const path = obj(e)?.path;
    const alias = Array.isArray(path) && path[0] === "repository" && typeof path[1] === "string" ? /^p(\d+)$/.exec(path[1]) : null;
    if (!alias) return null; // 不是某个 PR 的错（仓库、查询本身）：整个不算
    const n = Number(alias[1]);
    errorOf.set(n, `${errorOf.get(n) ?? ""} ${str(obj(e)?.type)} ${str(obj(e)?.message)}`);
  }
  const prs = new Map<number, PrBatchItem>();
  for (const n of numbers) {
    const node = obj(repo[`p${n}`]);
    const err = errorOf.get(n);
    if (!node) {
      prs.set(n, err !== undefined && ghPrNotFound(err) ? GH_NOT_FOUND : null);
      continue;
    }
    if (err !== undefined) {
      prs.set(n, null);
      continue;
    }
    const sig = prSigOf(node);
    if (mode === "cheap") {
      prs.set(n, { sig, pr: null });
      continue;
    }
    const shape = prViewShape(node);
    prs.set(n, { sig, pr: shape ? parsePrObject(shape) : null });
  }
  return { prs, rate };
}
