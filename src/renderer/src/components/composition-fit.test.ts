import { describe, expect, it } from "vitest";
import { compositionShift } from "./composition-fit";

describe("compositionShift", () => {
  it("returns 0 when the composition fits", () => {
    expect(compositionShift({ viewLeft: 100, viewWidth: 200, containerWidth: 400 })).toBe(0);
    expect(compositionShift({ viewLeft: 200, viewWidth: 200, containerWidth: 400 })).toBe(0);
  });
  it("returns the overflow when it sticks out on the right", () => {
    expect(compositionShift({ viewLeft: 230, viewWidth: 200, containerWidth: 400 })).toBe(30);
  });
  it("aligns to the left edge when wider than the container", () => {
    expect(compositionShift({ viewLeft: 120, viewWidth: 500, containerWidth: 400 })).toBe(120);
  });
});
