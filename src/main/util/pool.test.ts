import { describe, expect, it } from "vitest";
import { runPool } from "./pool";

describe("runPool", () => {
  it("keeps the input order and caps concurrency", async () => {
    let active = 0;
    let max = 0;
    const out = await runPool([30, 10, 20, 5], 2, async (ms, i) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
    expect(max).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await runPool([], 2, async () => 1)).toEqual([]);
  });
});
