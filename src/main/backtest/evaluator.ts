// 回测计算放到 worker 线程里跑：用户写的正则可能很慢（灾难性回溯），卡住就结束 worker，不拖住主进程。
// 测试和没有 worker 的场合用进程内的版本。
import type { Worker } from "node:worker_threads";
import { evaluateBacktest, type EvalInput, type EvalOutput } from "./evaluate";

export type Evaluator = (input: EvalInput) => Promise<EvalOutput>;

/** 一次回测最多算多久（50 个 PR 的 diff 正常一两秒）。 */
export const EVAL_TIMEOUT_MS = 60_000;

export const inProcessEvaluator: Evaluator = async (input) => evaluateBacktest(input);

export type EvalMessage = { ok: true; out: EvalOutput } | { ok: false; error: string };

export function workerEvaluator(create: (input: EvalInput) => Worker, timeoutMs = EVAL_TIMEOUT_MS): Evaluator {
  return (input) =>
    new Promise<EvalOutput>((resolve, reject) => {
      const w = create(input);
      let settled = false;
      const end = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void w.terminate().catch(() => undefined);
        f();
      };
      const timer = setTimeout(() => end(() => reject(new Error(`backtest evaluation timed out after ${timeoutMs} ms`))), timeoutMs);
      timer.unref?.();
      w.on("message", (m: EvalMessage) => end(() => (m.ok ? resolve(m.out) : reject(new Error(m.error)))));
      w.on("error", (e) => end(() => reject(e)));
      w.on("exit", (code) => end(() => reject(new Error(`backtest worker exited with code ${code}`))));
    });
}
