// 性能诊断（BTL-242）：渲染进程的 long task 加起来，每分钟报给主进程一次（主进程写进 main.log 的 perf: 行）。
export interface LongTaskTotals {
  longTasks: number;
  totalMs: number;
  maxMs: number;
  xterm: string | null;
}

export interface LongTaskReporterDeps {
  /** 订阅 long task；返回取消订阅。环境不支持时返回 null。 */
  observe: (onTask: (durationMs: number) => void) => (() => void) | null;
  send: (totals: LongTaskTotals) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  intervalMs?: number;
}

/** 终端现在用的渲染器（webgl / dom）：TerminalPane 设，随报告一起发。 */
let xtermRenderer: string | null = null;
export function setXtermRenderer(name: string): void {
  xtermRenderer = name;
}
export function currentXtermRenderer(): string | null {
  return xtermRenderer;
}

export function startLongTaskReporter(d: LongTaskReporterDeps): () => void {
  let acc = { longTasks: 0, totalMs: 0, maxMs: 0 };
  const unobserve = d.observe((ms) => {
    acc.longTasks += 1;
    acc.totalMs += ms;
    acc.maxMs = Math.max(acc.maxMs, ms);
  });
  const flush = () => {
    const x = xtermRenderer;
    // 什么都没有时不发：闲着的 Butler 不多一次 IPC。
    if (acc.longTasks === 0 && x === null) return;
    d.send({ longTasks: acc.longTasks, totalMs: Math.round(acc.totalMs), maxMs: Math.round(acc.maxMs), xterm: x });
    acc = { longTasks: 0, totalMs: 0, maxMs: 0 };
  };
  const h = d.setInterval(flush, d.intervalMs ?? 60_000);
  return () => {
    d.clearInterval(h);
    unobserve?.();
  };
}

/** 浏览器里的 PerformanceObserver（longtask）。 */
export function browserLongTaskObserver(onTask: (durationMs: number) => void): (() => void) | null {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return null;
  const o = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) onTask(e.duration);
  });
  o.observe({ type: "longtask", buffered: false });
  return () => o.disconnect();
}
