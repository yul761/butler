import { describe, expect, it } from "vitest";
import { keepSame } from "./keep-same";

describe("keepSame", () => {
  it("keeps the old object when the new one has the same content", () => {
    const prev = [{ key: "T-1", title: "a", sessions: [{ id: "s" }] }];
    const next = [{ key: "T-1", title: "a", sessions: [{ id: "s" }] }];
    expect(keepSame(prev, next)).toBe(prev);
  });

  it("takes the new object when anything differs", () => {
    const prev = [{ key: "T-1", title: "a" }];
    const next = [{ key: "T-1", title: "b" }];
    expect(keepSame(prev, next)).toBe(next);
    expect(keepSame(null, next)).toBe(next);
  });
});
