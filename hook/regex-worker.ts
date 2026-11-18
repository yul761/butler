import { Worker } from "node:worker_threads";

/** 一个正则测一组文字。 */
export interface RegexJob {
  pattern: string;
  flags: string;
  texts: string[];
}

export type RegexJobsResult = { ok: true; results: boolean[][] } | { ok: false };

// worker 里的代码自成一体（hook 是单个可执行文件，没有别的文件可加载）：编译、逐条测、把结果发回来。
const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
parentPort.postMessage(workerData.map((j) => {
  let re;
  try { re = new RegExp(j.pattern, j.flags); } catch { return j.texts.map(() => false); }
  return j.texts.map((t) => re.test(t));
}));
`;

/**
 * 用户写的正则在 worker 里跑，到点就 terminate（审查发现：嵌套量词的正则在一行上能卡住几秒，hook 会被 Claude Code 杀掉）。
 * 超时、worker 起不来都返回 ok: false，调用方把这些检查记成「超时」放行。永不 reject。
 */
export function runRegexJobs(jobs: RegexJob[], timeoutMs: number): Promise<RegexJobsResult> {
  if (!jobs.length) return Promise.resolve({ ok: true, results: [] });
  if (timeoutMs <= 0) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    let done = false;
    let w: Worker;
    const finish = (r: RegexJobsResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void w?.terminate().catch(() => undefined);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs);
    try {
      w = new Worker(SOURCE, { eval: true, workerData: jobs });
    } catch {
      finish({ ok: false });
      return;
    }
    w.on("message", (m: unknown) => finish(Array.isArray(m) ? { ok: true, results: m as boolean[][] } : { ok: false }));
    w.on("error", () => finish({ ok: false }));
    w.on("exit", () => finish({ ok: false }));
  });
}
