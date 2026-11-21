import { describe, expect, it } from "vitest";
import { setXtermRenderer, startLongTaskReporter, type LongTaskTotals } from "./diag";

function harness() {
  let task: ((ms: number) => void) | null = null;
  let tick: (() => void) | null = null;
  const sent: LongTaskTotals[] = [];
  const stop = startLongTaskReporter({
    observe: (cb) => {
      task = cb;
      return () => (task = null);
    },
    send: (t) => sent.push(t),
    setInterval: (fn) => (tick = fn),
    clearInterval: () => (tick = null),
  });
  return { sent, stop, task: (ms: number) => task?.(ms), tick: () => tick?.(), hasTick: () => tick !== null, hasTask: () => task !== null };
}

describe("startLongTaskReporter", () => {
  it("sums long tasks per interval and resets", () => {
    const h = harness();
    h.task(60);
    h.task(120.4);
    h.tick();
    h.task(70);
    h.tick();
    expect(h.sent.map((s) => [s.longTasks, s.totalMs, s.maxMs])).toEqual([[2, 180, 120], [1, 70, 70]]);
    h.stop();
  });

  it("sends nothing when there were no long tasks and no terminal", () => {
    const h = harness();
    h.tick();
    expect(h.sent).toEqual([]);
    h.stop();
    expect(h.hasTick()).toBe(false);
    expect(h.hasTask()).toBe(false);
  });

  it("carries the xterm renderer", () => {
    const h = harness();
    setXtermRenderer("webgl");
    h.tick();
    expect(h.sent[0].xterm).toBe("webgl");
    h.stop();
  });
});
