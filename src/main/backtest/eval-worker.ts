// worker 线程的入口（electron-vite 的 ?nodeWorker 打包）：算一次回测，把结果发回主进程。
import { parentPort, workerData } from "node:worker_threads";
import { evaluateBacktest, type EvalInput } from "./evaluate";
import type { EvalMessage } from "./evaluator";

if (parentPort) {
  let m: EvalMessage;
  try {
    m = { ok: true, out: evaluateBacktest(workerData as EvalInput) };
  } catch (e) {
    m = { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
  parentPort.postMessage(m);
}
