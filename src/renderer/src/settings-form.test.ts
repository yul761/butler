import { describe, expect, it } from "vitest";
import { hasDay, mergeTools, toggleDay, WEEK_ORDER } from "./settings-form";

describe("settings form helpers", () => {
  it("toggles working days and keeps them sorted", () => {
    expect(toggleDay("1,2,3,4,5", 5)).toBe("1,2,3,4");
    expect(toggleDay("1,2,3,4,5", 0)).toBe("0,1,2,3,4,5");
    expect(toggleDay("", 3)).toBe("3");
    expect(hasDay("1,2", 2)).toBe(true);
    expect(hasDay("", 0)).toBe(false);
    expect(WEEK_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it("merges picked tools into the list without duplicates", () => {
    expect(mergeTools("mcp__a__get\n", ["mcp__b__list", "mcp__a__get"])).toBe("mcp__a__get\nmcp__b__list");
    expect(mergeTools("", ["x"])).toBe("x");
  });
});
