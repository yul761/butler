import { describe, expect, it } from "vitest";
import { gb } from "./admission";

describe("gb", () => {
  it("rounds what is available down and what is needed up, so a refusal never reads as an exact fit", () => {
    expect(gb(3071)).toBe("2.9 GB");
    expect(gb(1024, true)).toBe("1.0 GB");
    expect(gb(2048, true)).toBe("2.0 GB");
    expect(gb(1100, true)).toBe("1.1 GB");
    expect(gb(1100)).toBe("1.0 GB");
    expect(gb(512)).toBe("512 MB");
  });
});
