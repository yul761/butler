import { describe, expect, it } from "vitest";
import { memDb } from "../../test-utils";
import { chunks, inputHash } from "./call";
import { JudgmentCache } from "./judgments";

describe("JudgmentCache", () => {
  it("returns a result only for the same input hash", () => {
    const c = new JudgmentCache(memDb());
    c.put("clarity", "1", "h1", { v: "yes" }, { model: "m", degraded: true, at: 5 });
    expect(c.get("clarity", "1", "h1")).toEqual({ result: { v: "yes" }, model: "m", degraded: true, at: 5 });
    expect(c.get("clarity", "1", "h2")).toBeNull();
    expect(c.get("classify", "1", "h1")).toBeNull();
    c.put("clarity", "1", "h2", { v: "no" }, { model: null, degraded: false, at: 6 });
    expect(c.get("clarity", "1", "h2")?.result).toEqual({ v: "no" });
  });

  it("pair keys are order independent; input hashes ignore key order; chunks split evenly", () => {
    expect(JudgmentCache.pair(9, 2)).toBe("2:9");
    expect(inputHash({ a: 1, b: [1, 2] })).toBe(inputHash({ b: [1, 2], a: 1 }));
    expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
