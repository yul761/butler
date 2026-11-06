import type { HeadlessRun } from "../claude/headless";
import { headlessEnv } from "../claude/spawn";
import type { SessionsRepo } from "../db/sessions-repo";
import { M } from "../strings";
import type { UsageCounts } from "../usage/usage-parse";
import { pickStructured } from "./schema";

/** 跑一次 headless claude 要的依赖（ticket handoff 和 feature 汇总共用）。 */
export interface HeadlessExecDeps {
  run: HeadlessRun;
  /** 首次 health 探测完成后 resolve。 */
  ready: () => Promise<void>;
  claude: () => { path: string | null; pathValue: string };
  baseEnv: NodeJS.ProcessEnv;
  sessions: SessionsRepo;
  now: () => number;
  newRunId: () => string;
  timeoutMs?: number;
  /** 退出 app 时取消所有进行中的 headless 运行：被取消的运行不写入任何东西，也不算限流。 */
  signal?: AbortSignal;
  /** 每次运行（含失败的）带回用量时调用。 */
  onUsage?: (u: { runId: string; label: string; at: number; model: string | null; usage: UsageCounts }) => void;
  log?: (msg: string, err?: unknown) => void;
}

export type HeadlessExecResult = { ok: true; value: unknown; rawText: string } | { ok: false; reason: string; message: string };

/** 去掉 label 末尾的 ticket 号或数字：“handoff BTL-1” → “handoff”，“feature summary 3” → “feature summary”。 */
export function jobOf(label: string): string {
  return label.replace(/\s+(?:[A-Za-z][A-Za-z0-9]*-\d+|\d+)$/, "");
}

/** 跑一次 headless claude，取出结构化输出。限流时 reason 是 rate_limited。 */
export async function execHeadlessJson(
  d: HeadlessExecDeps,
  o: { label: string; args: string[]; prompt: string; cwd: string; resumedId?: string },
): Promise<HeadlessExecResult> {
  await d.ready();
  const { path, pathValue } = d.claude();
  if (!path) return { ok: false, reason: "claude_missing", message: M().claudeMissing };
  const runId = d.newRunId();
  const out = await d.run({
    claudePath: path, args: o.args, prompt: o.prompt, cwd: o.cwd,
    env: headlessEnv(d.baseEnv, { pathValue, runId }),
    timeoutMs: d.timeoutMs,
    signal: d.signal,
  });
  // 失败的运行也花了 token：判断 ok 之前先记。
  const usage = out.result?.usage;
  if (usage) d.onUsage?.({ runId, label: o.label, at: d.now(), model: out.result?.model ?? null, usage });
  const sid = out.result?.sessionId;
  // 返回的 id 就是被恢复的真实 session 时，绝不能把它记成 headless。
  if (sid && sid !== o.resumedId) d.sessions.recordHeadless(sid, o.cwd, d.now());
  if (!out.ok) {
    d.log?.(`${o.label}: ${out.reason}: ${out.message}`);
    return { ok: false, reason: out.reason, message: out.message };
  }
  return { ok: true, value: pickStructured(out.result), rawText: out.result.resultText || JSON.stringify(out.result.structured ?? null) };
}
