import { describe, expect, it } from "vitest";
import { auditCutoff } from "./retention";

describe("auditCutoff (BTL-243)", () => {
  it("is exactly the retention period back, with no month-start floor any more", () => {
    const now = new Date(2026, 10, 3, 12).getTime();
    expect(auditCutoff(now, 1)).toBe(now - 86_400_000);
    expect(auditCutoff(now, 90)).toBe(now - 90 * 86_400_000);
  });
});
