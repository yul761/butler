import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Invalidator } from "./invalidator";
import type { StateScope } from "../../shared/state-scope";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make() {
  const flushed: StateScope[][] = [];
  let gen = 0;
  const inv = new Invalidator({ emit: (s) => flushed.push(s), onChange: () => gen++, quietMs: 120, maxWaitMs: 250 });
  return { inv, flushed, gen: () => gen };
}

describe("Invalidator", () => {
  it("merges calls within the quiet window into one flush with the union of scopes", () => {
    const { inv, flushed } = make();
    inv.notify();
    inv.notify("activity");
    vi.advanceTimersByTime(60);
    inv.notify("data");
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(120);
    expect(flushed).toEqual([["data", "activity"]]);
  });

  it("flushes at maxWait even when calls keep coming", () => {
    const { inv, flushed } = make();
    for (let t = 0; t < 300; t += 50) {
      inv.notify("activity");
      vi.advanceTimersByTime(50);
    }
    expect(flushed.length).toBeGreaterThanOrEqual(1);
    expect(flushed[0]).toEqual(["activity"]);
  });

  it("bumps the generation on every call, not at flush", () => {
    const { inv, gen } = make();
    inv.notify();
    inv.notify("procs");
    expect(gen()).toBe(2);
  });

  it("flushNow sends pending scopes at once, and dispose drops them", () => {
    const { inv, flushed } = make();
    inv.notify("procs");
    inv.flushNow();
    expect(flushed).toEqual([["procs"]]);
    inv.notify();
    inv.dispose();
    vi.advanceTimersByTime(1000);
    expect(flushed).toHaveLength(1);
  });

  describe("while the window is hidden (BTL-275)", () => {
    function hidden() {
      const flushed: StateScope[][] = [];
      const invalidated: StateScope[] = [];
      let visible = false;
      const inv = new Invalidator({ emit: (s) => flushed.push(s), onChange: (s) => invalidated.push(s), visible: () => visible, quietMs: 120, maxWaitMs: 250 });
      return { inv, flushed, invalidated, show: (v: boolean) => (visible = v) };
    }

    it("holds the scopes instead of sending them, but still invalidates the view cache at once", () => {
      const w = hidden();
      w.inv.notify("data");
      w.inv.notify("activity");
      vi.advanceTimersByTime(1000);
      expect(w.flushed).toEqual([]);
      expect(w.invalidated).toEqual(["data", "activity"]);
    });

    it("sends everything held since it was hidden in one state:changed when the window comes back", () => {
      const w = hidden();
      w.inv.notify("data");
      vi.advanceTimersByTime(1000);
      w.inv.notify("procs");
      w.inv.notify("data");
      vi.advanceTimersByTime(1000);
      w.inv.notify("activity");
      vi.advanceTimersByTime(1000);
      w.show(true);
      w.inv.resume();
      expect(w.flushed).toEqual([["data", "procs", "activity"]]);
      // 只补发一次
      w.inv.resume();
      vi.advanceTimersByTime(1000);
      expect(w.flushed).toHaveLength(1);
    });

    it("a notify after the window is visible again also carries what was held (no resume needed)", () => {
      const w = hidden();
      w.inv.notify("data");
      vi.advanceTimersByTime(1000);
      w.show(true);
      w.inv.notify("procs");
      vi.advanceTimersByTime(1000);
      expect(w.flushed).toEqual([["data", "procs"]]);
    });

    it("resume while still hidden or with nothing held sends nothing", () => {
      const w = hidden();
      w.inv.resume();
      w.inv.notify("data");
      vi.advanceTimersByTime(1000);
      w.inv.resume();
      expect(w.flushed).toEqual([]);
      w.show(true);
      w.inv.resume();
      w.inv.resume();
      expect(w.flushed).toEqual([["data"]]);
    });

    it("dispose drops what was held", () => {
      const w = hidden();
      w.inv.notify("data");
      vi.advanceTimersByTime(1000);
      w.inv.dispose();
      w.show(true);
      w.inv.resume();
      expect(w.flushed).toEqual([]);
    });
  });
});
