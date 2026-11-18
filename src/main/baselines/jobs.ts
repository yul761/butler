// worker 里跑的两种活（设计 §9）：扫描（读文件 + scanFiles）和存量扫描。同一份处理函数也能在进程内跑（测试、没有 worker 时）。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanFiles, type ScanOutput } from "./scan";
import type { ResolvedRules } from "./rules";
import { LEGACY_MAX_FILE_BYTES, isBinary, legacyEvaluate, legacyFiles, type LegacyCheck } from "./legacy";
import type { LegacyStatus, LegacyViolation } from "../../shared/baselines";
import { runCommand } from "../../../hook/check-run";

/** 扫描时单个配置文件最多读这么多。 */
const SCAN_MAX_FILE_BYTES = 512 * 1024;
/** 每查这么多个文件报一次进度。 */
export const PROGRESS_EVERY = 200;

export type Job =
  | { kind: "scan"; root: string; files: string[]; truncated: boolean; rules: ResolvedRules }
  | {
      kind: "legacy";
      root: string;
      files: string[];
      check: LegacyCheck;
      ticketPattern: string;
      maxFiles: number;
      /** run_command：每个文件 / 整次的上限。 */
      timeoutMs: number;
      env: Record<string, string | undefined>;
    };

export interface LegacyResult {
  status: Extract<LegacyStatus, "done" | "truncated">;
  filesTotal: number;
  filesScanned: number;
  count: number;
}

export type JobMessage =
  | { type: "progress"; filesTotal: number; filesScanned: number; count: number; file: string }
  | { type: "violations"; items: LegacyViolation[] }
  | { type: "scan"; result: ScanOutput }
  | { type: "legacy"; result: LegacyResult }
  | { type: "error"; message: string };

/** 读一个仓库文件（仓库相对路径）；太大、读不了、二进制返回 null。 */
export function readRepoFile(root: string, rel: string, max: number): string | null {
  try {
    const p = join(root, ...rel.split("/"));
    const st = statSync(p);
    if (!st.isFile() || st.size > max) return null;
    const buf = readFileSync(p);
    if (isBinary(buf)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/** 跑一个活。post 发消息给主进程；cancelled() 为真时尽快停下（进程内运行时用，worker 是直接被结束）。 */
export async function runJob(job: Job, post: (m: JobMessage) => void, cancelled: () => boolean = () => false): Promise<void> {
  try {
    if (job.kind === "scan") {
      const result = scanFiles({ files: job.files, read: (p) => readRepoFile(job.root, p, SCAN_MAX_FILE_BYTES), rules: job.rules, truncated: job.truncated });
      post({ type: "scan", result });
      return;
    }
    await legacy(job, post, cancelled);
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

async function legacy(job: Extract<Job, { kind: "legacy" }>, post: (m: JobMessage) => void, cancelled: () => boolean): Promise<void> {
  const all = legacyFiles(job.files, job.check);
  const truncated = all.length > job.maxFiles;
  const files = truncated ? all.slice(0, job.maxFiles) : all;
  let count = 0;
  let scanned = 0;
  let batch: LegacyViolation[] = [];
  const flush = () => {
    if (batch.length) post({ type: "violations", items: batch });
    batch = [];
  };
  const progress = (file: string) => post({ type: "progress", filesTotal: files.length, filesScanned: scanned, count, file });
  progress("");
  const isCommand = job.check.type === "run_command";
  const stage = job.check.params.stage === "push" ? "push" : "edit";
  const command = String(job.check.params.command ?? "");
  const timeoutMs = typeof job.check.params.timeoutMs === "number" ? Math.min(job.check.params.timeoutMs, job.timeoutMs) : job.timeoutMs;

  if (isCommand && stage === "push") {
    // 整个仓库跑一次：失败就是一处。
    const r = await runCommand({ command, file: null, cwd: job.root, timeoutMs, env: job.env as NodeJS.ProcessEnv });
    scanned = files.length;
    if (r.kind === "fail") {
      count = 1;
      batch.push({ file: ".", line: null, snippet: tail(r.output) });
    } else if (r.kind !== "pass") throw new Error(r.kind === "timeout" ? "timeout" : r.reason);
    flush();
    post({ type: "legacy", result: { status: truncated ? "truncated" : "done", filesTotal: files.length, filesScanned: scanned, count } });
    return;
  }

  for (const f of files) {
    if (cancelled()) break;
    if (isCommand) {
      const r = await runCommand({ command, file: f, cwd: job.root, timeoutMs, env: job.env as NodeJS.ProcessEnv });
      if (r.kind === "fail") {
        count++;
        batch.push({ file: f, line: null, snippet: tail(r.output) });
      } else if (r.kind === "unavailable") throw new Error(r.reason);
    } else {
      const text = readRepoFile(job.root, f, LEGACY_MAX_FILE_BYTES);
      if (text !== null) {
        const vs = legacyEvaluate(job.check, f, text, job.ticketPattern);
        count += vs.length;
        batch.push(...vs);
      }
    }
    scanned++;
    if (scanned % PROGRESS_EVERY === 0) {
      flush();
      progress(f);
    }
  }
  flush();
  progress("");
  post({ type: "legacy", result: { status: truncated ? "truncated" : "done", filesTotal: files.length, filesScanned: scanned, count } });
}

const tail = (s: string) => {
  const t = s.trim();
  return t.length > 300 ? t.slice(t.length - 300) : t;
};
