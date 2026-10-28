import type { HeadlessRun } from "../claude/headless";
import { headlessEnv } from "../claude/spawn";
import type { SessionsRepo } from "../db/sessions-repo";
import { M } from "../strings";
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
  log?: (msg: string, err?: unknown) => void;
}

export type HeadlessExecResult = { ok: true; value: unknown; rawText: string } | { ok: false; reason: string; message: string };

/** 跑一次 headless claude，取出结构化输出。限流时 reason 是 rate_limited。 */
export async function execHeadlessJson(
  d: HeadlessExecDeps,
  o: { label: string; args: string[]; prompt: string; cwd: string; resumedId?: string },
): Promise<HeadlessExecResult> {
  await d.ready();
  const { path, pathValue } = d.claude();
  if (!path) return { ok: false, reason: "claude_missing", message: M().claudeMissing };
  const out = await d.run({
    claudePath: path, args: o.args, prompt: o.prompt, cwd: o.cwd,
    env: headlessEnv(d.baseEnv, { pathValue, runId: d.newRunId() }),
    timeoutMs: d.timeoutMs,
    signal: d.signal,
  });
  const sid = out.result?.sessionId;
  // 返回的 id 就是被恢复的真实 session 时，绝不能把它记成 headless。
  if (sid && sid !== o.resumedId) d.sessions.recordHeadless(sid, o.cwd, d.now());
  if (!out.ok) {
    d.log?.(`${o.label}: ${out.reason}: ${out.message}`);
    return { ok: false, reason: out.reason, message: out.message };
  }
  return { ok: true, value: pickStructured(out.result), rawText: out.result.resultText || JSON.stringify(out.result.structured ?? null) };
}
