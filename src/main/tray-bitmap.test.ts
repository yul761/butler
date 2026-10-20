import { describe, expect, it } from "vitest";
import { circleBitmap } from "./tray-bitmap";

describe("circleBitmap", () => {
  it("draws an opaque centre and transparent corners in BGRA", () => {
    const size = 16;
    const buf = circleBitmap(size, [0x10, 0x20, 0x30]);
    expect(buf).toHaveLength(size * size * 4);
    const px = (x: number, y: number) => [...buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    expect(px(8, 8)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(px(0, 0)[3]).toBe(0);
  });
});
