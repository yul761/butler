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
});
