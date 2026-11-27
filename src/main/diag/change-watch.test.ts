import { describe, expect, it } from "vitest";
import { changeWatcher } from "./change-watch";

describe("changeWatcher (BTL-275: the per-minute check that replaces the stack tick's unconditional notify)", () => {
  it("records a baseline first, notifies only when the value changes, and treats a failed read as no change", () => {
    let value: unknown = [{ kind: "comment_undelivered", key: "A-1" }];
    let fail = false;
    let notified = 0;
    const check = changeWatcher(() => {
      if (fail) throw new Error("boom");
      return value;
    }, () => notified++);
    check();
    check();
    expect(notified).toBe(0);
    value = [];
    check();
    expect(notified).toBe(1);
    fail = true;
    check();
    expect(notified).toBe(1);
    fail = false;
    check();
    expect(notified).toBe(1);
    value = [{ kind: "x" }];
    check();
    expect(notified).toBe(2);
  });
});
