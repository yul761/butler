// 性能诊断（BTL-242）：主进程和渲染进程共用的类型。
export type DiagMode = "off" | "on" | "verbose";

export interface Timing {
  n: number;
  totalMs: number;
  maxMs: number;
}

export interface EventLoopDelay {
  p50: number;
  p99: number;
  max: number;
}

export interface PerfWindow {
  start: number;
  end: number;
  eld: EventLoopDelay | null;
  sends: Record<string, { n: number; bytes: number }>;
  invokes: Record<string, Timing>;
  ops: Record<string, Timing>;
  renderer: { longTasks: number; totalMs: number; maxMs: number; xterm: string | null };
}

export interface DiagSnapshot {
  mode: DiagMode;
  current: PerfWindow;
  history: PerfWindow[];
  /** 当前窗口到现在的事件循环延迟（不重置直方图）。 */
  eld: EventLoopDelay | null;
  /** 从上一次 snapshot(true) 到现在（测量用，e2e 的性能场景读它）。 */
  measure: {
    sinceMs: number;
    eld: EventLoopDelay | null;
    sends: Record<string, { n: number; bytes: number }>;
    /** 渲染进程调了多少次 invoke、handler 同步跑了多久。 */
    invokes: { n: number; totalMs: number };
    /** 每类进程（Browser = 主进程、Tab = 界面、GPU…）这段时间用的 CPU 秒数。 */
    cpuSec: Record<string, number>;
  };
}
