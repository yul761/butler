import { execFile } from "node:child_process";

/**
 * 执行的 gh：启动时和登录 shell 的 PATH 读到之后各解析一次（resolveGh）；没找到就用裸 "gh"。
 * null：没找到 gh 且在 Windows 上，不执行（裸 "gh" 会先在仓库目录里找 gh.exe，I5，和 git-path 一样）。
 */
let binary: string | null = "gh";
let resolved = false;
let warned = false;

export function setGhBinary(p: string): void {
  binary = p;
  resolved = true;
}

/** 测试用：回到“还没解析过”的初始状态。 */
export function resetGhBinary(): void {
  binary = "gh";
  resolved = false;
  warned = false;
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
export interface PrStatus {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  review: "pending" | "changes_requested" | "approved" | null;
  headSha: string;
  checks: CiCheck[];
  ci: CiState;
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
  const bin = ghBinary();
  if (bin === null) return Promise.resolve(null);
  return new Promise((done) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer }, (err, stdout) => done(err ? null : String(stdout)));
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

const REVIEWS = { REVIEW_REQUIRED: "pending", CHANGES_REQUESTED: "changes_requested", APPROVED: "approved" } as const;

/** gh pr view <branch>：没有 PR、gh 不可用、输出不对都返回 null。 */
export async function prStatus(cwd: string, branch: string, timeoutMs: number): Promise<PrStatus | null> {
  const j = parseJson(await runGh(cwd, ["pr", "view", branch, "--json", "number,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup"], timeoutMs, 4 * 1024 * 1024));
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
  };
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
