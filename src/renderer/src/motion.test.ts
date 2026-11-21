import { describe, expect, it } from "vitest";
import { watchMotion } from "./motion";

function fakeEnv() {
  let hidden = false;
  const docListeners = new Set<() => void>();
  let ioCb: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  let observed = 0;
  let disconnected = false;
  return {
    env: {
      isHidden: () => hidden,
      onVisibility: (cb: () => void) => {
        docListeners.add(cb);
        return () => docListeners.delete(cb);
      },
      observe: (_el: unknown, cb: (entries: { isIntersecting: boolean }[]) => void) => {
        ioCb = cb;
        observed++;
        return () => (disconnected = true);
      },
    },
    setHidden(v: boolean) {
      hidden = v;
      for (const l of docListeners) l();
    },
    intersect(v: boolean) {
      ioCb?.([{ isIntersecting: v }]);
    },
    get listeners() {
      return docListeners.size;
    },
    get observed() {
      return observed;
    },
    get disconnected() {
      return disconnected;
    },
  };
}

describe("watchMotion", () => {
  it("pauses while the window is hidden or the element is off screen", () => {
    const f = fakeEnv();
    const seen: boolean[] = [];
    watchMotion({}, (paused) => seen.push(paused), f.env);
    expect(seen).toEqual([false]);
    f.setHidden(true);
    f.setHidden(false);
    f.intersect(false);
    f.setHidden(true);
    f.intersect(true);
    f.setHidden(false);
    expect(seen).toEqual([false, true, false, true, false]);
  });

  it("starts paused when the window is already hidden", () => {
    const f = fakeEnv();
    f.setHidden(true);
    const seen: boolean[] = [];
    watchMotion({}, (paused) => seen.push(paused), f.env);
    expect(seen).toEqual([true]);
  });

  it("the cleanup removes both listeners", () => {
    const f = fakeEnv();
    const stop = watchMotion({}, () => {}, f.env);
    expect([f.listeners, f.observed]).toEqual([1, 1]);
    stop();
    expect([f.listeners, f.disconnected]).toEqual([0, true]);
  });
});
