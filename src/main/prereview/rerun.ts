// 复跑证据里的检查（设计 §3.4 第 1 条、§13）：只跑仓库档案里的命令，不跑 session 自己写的命令。
// worktree 干净、HEAD = sha 才跑；跑完再核对一次，变了就作废。
import { killTree, runCommand, type CommandResult } from "../../../hook/check-run";
import type { RepoProfile } from "../../shared/baselines";
import type { RerunMode } from "../../shared/pr-policy";
import type { CheckSummary, EvidenceItem, EvidenceVerified, RequirableCategory } from "../../shared/prereview";
import { projectsFor } from "./evidence";
import type { GitRun } from "./diff";

/** 复跑输出只留尾部这么多字（设计 §3.4）。 */
export const RERUN_OUTPUT_CHARS = 4000;

export interface RerunCommand {
  category: RequirableCategory;
  command: string;
  /** 项目目录（相对仓库根，用 /；根目录为空字符串）。 */
  dir: string;
}

export interface RerunResult extends RerunCommand {
  ok: boolean;
  /** 没跑出结论（超时、shell 起不来）：原因。这时 ok 为 false，但不算「复跑失败」。 */
  skipped: string | null;
  output: string;
  ms: number;
}

export type RerunOutcome =
  | { kind: "ran"; results: RerunResult[] }
  /** 没跑：worktree 脏了、HEAD 不对、档案里没有命令、策略关了。 */
  | { kind: "skipped"; reason: string; results: RerunResult[] }
  /** 跑完发现 HEAD 变了或 worktree 变脏：结果作废。 */
  | { kind: "invalidated"; reason: string; results: RerunResult[] }
  /** 被打断（后台让路）：results 是已经跑完的，下次从这里接着。 */
  | { kind: "interrupted"; results: RerunResult[] };

export type RunFn = (o: { command: string; cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<CommandResult>;

/** hook 的 runCommand；signal abort 时整棵进程树杀掉（后台让路、退出）。 */
const defaultRun: RunFn = (o) => {
  let pid: number | null = null;
  const kill = () => {
    if (pid !== null) killTree(pid, process.platform);
  };
  o.signal?.addEventListener("abort", kill, { once: true });
  return runCommand({
    command: o.command, file: null, cwd: o.cwd, timeoutMs: o.timeoutMs, env: o.env,
    onPid: (p, alive) => {
      pid = alive ? p : null;
      if (alive && o.signal?.aborted) kill();
    },
  }).finally(() => o.signal?.removeEventListener("abort", kill));
};

const tail = (s: string): string => (s.length > RERUN_OUTPUT_CHARS ? s.slice(s.length - RERUN_OUTPUT_CHARS) : s);
/** 要参数的命令（单个测试、单个文件）不能整仓库跑。 */
const needsArg = (c: string): boolean => c.includes("{file}") || c.includes("{test}");
const trimDir = (d: string): string => d.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");

/**
 * 按档案和策略挑出要复跑的命令（改动涉及的项目；没有项目对得上时不跑）。
 * all：typecheck、lint、test（testAll）；fast：typecheck 和 fastest（和别的命令一样就按那一类，否则当 lint）；off：不跑。
 */
export function rerunPlan(profile: RepoProfile | null, files: readonly string[], mode: RerunMode): RerunCommand[] {
  if (mode === "off") return [];
  const out: RerunCommand[] = [];
  const seen = new Set<string>();
  const add = (category: RequirableCategory, command: string | null, dir: string) => {
    const c = command?.trim();
    if (!c || needsArg(c)) return;
    const key = `${dir}\0${c}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ category, command: c, dir });
  };
  for (const p of projectsFor(profile, files)) {
    const dir = trimDir(p.dir);
    add("typecheck", p.typecheck, dir);
    if (mode === "all") {
      add("lint", p.lint, dir);
      add("test", p.testAll, dir);
    } else if (p.fastest) {
      // 最快的命令只在它就是某一类的命令时才复跑：归不了类的结果没法拿去核对哪条证据。
      const f = p.fastest.trim();
      const cat = f === p.lint?.trim() ? "lint" : f === p.testAll?.trim() ? "test" : f === p.typecheck?.trim() ? "typecheck" : null;
      if (cat) add(cat, f, dir);
    }
  }
  return out;
}

export interface RerunDeps {
  git: GitRun;
  run?: RunFn;
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
  /** abort 时停下（后台让路）：正在跑的命令杀掉、结果不要，已经跑完的留给下次。 */
  signal?: AbortSignal;
}

/** worktree 干净（不算没跟踪的文件）而且 HEAD 是这个 sha；不是就返回原因。 */
async function stateProblem(git: GitRun, cwd: string, sha: string): Promise<string | null> {
  try {
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    if (head !== sha) return `HEAD is ${head.slice(0, 12)}, not ${sha.slice(0, 12)}`;
    const dirty = (await git(cwd, ["status", "--porcelain", "--untracked-files=no"])).trim();
    if (dirty) return "worktree has uncommitted changes";
    return null;
  } catch (e) {
    return `git failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  }
}

const joinDir = (cwd: string, dir: string): string => (dir ? `${cwd.replace(/[\\/]+$/, "")}/${dir}` : cwd);

/**
 * 复跑。done 是上次（被打断前）已经跑完的结果，从它后面接着跑。超时按策略（秒）。
 */
export async function rerunEvidence(
  o: { cwd: string; sha: string; plan: RerunCommand[]; timeoutSec: number; done?: RerunResult[]; onResult?: (r: RerunResult, all: RerunResult[]) => void },
  d: RerunDeps,
): Promise<RerunOutcome> {
  const results = [...(o.done ?? [])];
  if (o.plan.length === 0) return { kind: "skipped", reason: "no commands to rerun", results };
  const before = await stateProblem(d.git, o.cwd, o.sha);
  if (before) return { kind: "skipped", reason: before, results };
  const run = d.run ?? defaultRun;
  const now = d.now ?? Date.now;
  for (let i = results.length; i < o.plan.length; i++) {
    if (d.signal?.aborted) return { kind: "interrupted", results };
    const c = o.plan[i]!;
    const t0 = now();
    const r = await run({ command: c.command, cwd: joinDir(o.cwd, c.dir), timeoutMs: o.timeoutSec * 1000, env: d.env?.() ?? { ...process.env }, signal: d.signal });
    if (d.signal?.aborted) return { kind: "interrupted", results };
    const res: RerunResult = {
      ...c,
      ok: r.kind === "pass",
      skipped: r.kind === "timeout" ? `timed out after ${o.timeoutSec}s` : r.kind === "unavailable" ? r.reason.slice(0, 300) : null,
      output: tail(r.kind === "pass" ? "" : r.kind === "unavailable" ? r.reason : r.output),
      ms: now() - t0,
    };
    results.push(res);
    o.onResult?.(res, results);
  }
  const after = await stateProblem(d.git, o.cwd, o.sha);
  if (after) return { kind: "invalidated", reason: after, results };
  return { kind: "ran", results };
}

/** 给预审输入和风险用的摘要。 */
export function rerunSummary(results: readonly RerunResult[]): CheckSummary["rerun"] {
  return results.map((r) => ({ category: r.category, command: r.command, ok: r.ok, skipped: r.skipped, ms: r.ms }));
}

/** 复跑总的结论（风险的输入）：有一条失败 = failed；全过 = passed；没跑出结论 = none。 */
export function rerunVerdict(outcome: RerunOutcome | null): "passed" | "failed" | "none" {
  if (!outcome || outcome.kind !== "ran") return "none";
  const decided = outcome.results.filter((r) => r.skipped === null);
  if (decided.some((r) => !r.ok)) return "failed";
  return decided.length > 0 ? "passed" : "none";
}

export interface EvidenceVerdict {
  id: number;
  verified: EvidenceVerified;
  detail: string | null;
  rerunOutput: string | null;
}

/**
 * 把复跑结果对到证据上：同一类别有复跑结论的，pass → rerun_pass，fail → rerun_fail。
 * 作废（invalidated）时这些条目一律 unverifiable。其余的留给交叉核对（不在返回值里）。
 */
export function applyRerun(items: readonly EvidenceItem[], outcome: RerunOutcome | null): EvidenceVerdict[] {
  if (!outcome || outcome.kind === "skipped" || outcome.kind === "interrupted") return [];
  const out: EvidenceVerdict[] = [];
  for (const it of items) {
    if (it.kind !== "check" || !it.category || it.category === "other") continue;
    const rs = outcome.results.filter((r) => r.category === it.category && r.skipped === null);
    if (rs.length === 0) continue;
    if (outcome.kind === "invalidated") {
      out.push({ id: it.id, verified: "unverifiable", detail: outcome.reason, rerunOutput: null });
      continue;
    }
    const failed = rs.find((r) => !r.ok);
    if (failed) {
      const said = it.claimed === "pass" ? "claimed pass, but Shipherd's rerun failed" : "Shipherd's rerun failed";
      out.push({ id: it.id, verified: "rerun_fail", detail: `${said}: ${failed.command}`, rerunOutput: failed.output || null });
    } else {
      out.push({ id: it.id, verified: "rerun_pass", detail: rs.map((r) => r.command).join("; "), rerunOutput: null });
    }
  }
  return out;
}
