import { describe, expect, it } from "vitest";
import { S } from "./strings";
import { limitLine, resetClock } from "./availability-view";

describe("availability view", () => {
  it("resetClock same day and other day", () => {
    const now = new Date(2026, 9, 31, 9, 5).getTime();
    expect(resetClock(new Date(2026, 9, 31, 14, 30).getTime(), now)).toBe("14:30");
    expect(resetClock(new Date(2026, 10, 1, 2, 7).getTime(), now)).toBe("11/1 02:07");
  });

  it("limitLine names the kind, with the reset when known", () => {
    const now = new Date(2026, 9, 31, 9, 5).getTime();
    const at = new Date(2026, 9, 31, 14, 30).getTime();
    expect(limitLine({ kind: "usage_limit", resetsAt: at, message: "m" }, S, now)).toBe("用量已达上限，14:30 恢复");
    expect(limitLine({ kind: "overloaded", resetsAt: null, message: "m" }, S, now)).toBe("Claude 繁忙");
  });
});
