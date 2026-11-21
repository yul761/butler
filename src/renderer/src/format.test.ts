import { describe, expect, it } from "vitest";
import { formatUsd } from "./format";

describe("formatUsd", () => {
  it("shows cents, and two more places below a cent", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0023)).toBe("$0.0023");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});
