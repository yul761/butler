import { describe, expect, it } from "vitest";
import { pathKey, withPath } from "./env";

describe("PATH helpers", () => {
  it("finds the PATH key case-insensitively", () => {
    expect(pathKey({ Path: "a" })).toBe("Path");
    expect(pathKey({ PATH: "a" })).toBe("PATH");
    expect(pathKey({})).toBe("PATH");
  });

  it("replaces PATH without duplicating keys", () => {
    expect(withPath({ Path: "a", X: "1" }, "b")).toEqual({ Path: "b", X: "1" });
  });
});
