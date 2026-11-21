// 限频（BTL-242）：第一次马上跑，之后 everyMs 之内再来的合成一次，在窗口结束时跑。用来让频繁的小变化（session 的输出）隔一段才推给界面。

export interface ThrottleTimers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
}

const realTimers: ThrottleTimers = {
  now: Date.now,
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
};

export function throttle(fn: () => void, everyMs: number, timers: ThrottleTimers = realTimers): () => void {
  let last = -Infinity;
  let scheduled = false;
  const run = () => {
    last = timers.now();
    fn();
  };
  return () => {
    if (scheduled) return;
    const wait = last + everyMs - timers.now();
    if (wait <= 0) return run();
    scheduled = true;
    timers.setTimeout(() => {
      scheduled = false;
      run();
    }, wait);
  };
}
