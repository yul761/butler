import { describe, expect, it } from "vitest";
import { changeWatcher } from "./change-watch";

describe("changeWatcher (BTL-275: the per-minute check that replaces the stack tick's unconditional notify)", () => {
  it("takes the baseline when created, so a notice that appears before the first check still notifies", () => {
    let value: unknown = [];
    let notified = 0;
    const check = changeWatcher(() => value, () => notified++);
    value = [{ kind: "comment_undelivered", key: "A-1" }];
    check();
    expect(notified).toBe(1);
    check();
    expect(notified).toBe(1);
  });

  it("falls back to the first check for the baseline when the read at creation fails", () => {
    let fail = true;
    let notified = 0;
    const check = changeWatcher(() => {
      if (fail) throw new Error("not ready");
      return [1];
    }, () => notified++);
    fail = false;
    check();
    expect(notified).toBe(0);
  });

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
