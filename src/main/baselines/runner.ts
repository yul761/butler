// 主进程这一侧：把一个活交给 worker（或进程内），转发消息，取消，看门狗（设计 §7、§9）。
import type { Worker } from "node:worker_threads";
import { runJob, type Job, type JobMessage } from "./jobs";
import { killTree } from "../../../hook/check-run";

/** 记着活里起的检查命令进程；结束时还活着的整棵树杀掉。 */
function pidTracker(kill: (pid: number) => void) {
  const live = new Set<number>();
  return {
    /** 是 pid 消息就记下、返回 true（不再转给调用方）。 */
    take(m: JobMessage): boolean {
      if (m.type !== "pid") return false;
      if (m.alive) live.add(m.pid);
      else live.delete(m.pid);
      return true;
    },
    killAll() {
      for (const pid of [...live]) kill(pid);
      live.clear();
    },
  };
}

const defaultKill = (pid: number) => killTree(pid, process.platform);

export const WATCHDOG_MS = 20_000;

export type JobEnd = { kind: "finished" } | { kind: "cancelled" } | { kind: "stalled"; lastFile: string } | { kind: "crashed"; message: string };

export interface JobHandle {
  /** 活结束（不管怎么结束的）。 */
  done: Promise<JobEnd>;
  cancel(): void;
}

/** 跑一个活：每条消息交给 onMessage。 */
export type JobRunner = (job: Job, onMessage: (m: JobMessage) => void) => JobHandle;

/** 进程内跑（测试、e2e 以外没有 worker 的场合）：取消在下一个文件之前生效，没有看门狗。 */
export const inProcessRunner: JobRunner = (job, onMessage) => {
  let cancelled = false;
  const pids = pidTracker(defaultKill);
  const done = runJob(job, (m) => void (pids.take(m) || onMessage(m)), () => cancelled).then((): JobEnd => (cancelled ? { kind: "cancelled" } : { kind: "finished" }));
  return {
    done,
    cancel: () => {
      cancelled = true;
      pids.killAll();
    },
  };
};

/**
 * worker 线程里跑。每个活一个 worker，跑完 / 取消 / 卡住就 terminate（连同它起的检查命令）。
 * 看门狗：watchdogMs 里没有任何消息（一个病态正则卡住了）就结束它，报卡在哪个文件。
 */
export function workerRunner(create: (job: Job) => Worker, watchdogMs = WATCHDOG_MS, kill: (pid: number) => void = defaultKill): JobRunner {
  return (job, onMessage) => {
    const w = create(job);
    const pids = pidTracker(kill);
    // 整个仓库跑一次命令时中间没有消息：看门狗至少等到命令自己的超时之后。
    const limit = job.kind === "legacy" && job.check.type === "run_command" ? Math.max(watchdogMs, job.timeoutMs + 5_000) : watchdogMs;
    let settled = false;
    let lastFile = "";
    let finish!: (e: JobEnd) => void;
    const done = new Promise<JobEnd>((resolve) => (finish = resolve));
    let timer: NodeJS.Timeout | null = null;
    const end = (e: JobEnd) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // worker 结束带不走它起的 shell（detached 的进程组）：取消、卡住、崩溃时还在跑的命令一起杀。
      pids.killAll();
      void w.terminate().catch(() => undefined);
      finish(e);
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => end({ kind: "stalled", lastFile }), limit);
      timer.unref?.();
    };
    arm();
    w.on("message", (m: JobMessage) => {
      if (settled) return;
      arm();
      if (pids.take(m)) return;
      if (m.type === "progress" && m.file) lastFile = m.file;
      onMessage(m);
      if (m.type === "scan" || m.type === "legacy" || m.type === "error") end({ kind: "finished" });
    });
    w.on("error", (e) => end({ kind: "crashed", message: e instanceof Error ? e.message : String(e) }));
    w.on("exit", (code) => end(code === 0 ? { kind: "finished" } : { kind: "crashed", message: `worker exited with ${code}` }));
    return { done, cancel: () => end({ kind: "cancelled" }) };
  };
}
