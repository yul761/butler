import { describe, expect, it } from "vitest";
import { throttle, type ThrottleTimers } from "./throttle";

function fakeTimers() {
  let t = 0;
  const due: { at: number; fn: () => void }[] = [];
  const timers: ThrottleTimers = { now: () => t, setTimeout: (fn, ms) => due.push({ at: t + ms, fn }) };
  const advance = (ms: number) => {
    t += ms;
    for (const d of due.splice(0).sort((a, b) => a.at - b.at)) {
      if (d.at <= t) d.fn();
      else due.push(d);
    }
  };
  return { timers, advance };
}

describe("throttle", () => {
  it("runs the first call at once, folds the calls inside the window into one at its end", () => {
    const { timers, advance } = fakeTimers();
    let n = 0;
    const f = throttle(() => n++, 5000, timers);
    f();
    expect(n).toBe(1);
    f();
    f();
    advance(4999);
    expect(n).toBe(1);
    advance(1);
    expect(n).toBe(2);
    advance(10_000);
    expect(n).toBe(2);
  });

  it("after a quiet window, the next call runs at once again", () => {
    const { timers, advance } = fakeTimers();
    let n = 0;
    const f = throttle(() => n++, 5000, timers);
    f();
    advance(6000);
    f();
    expect(n).toBe(2);
  });
});
