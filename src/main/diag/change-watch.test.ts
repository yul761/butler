import { describe, expect, it } from "vitest";
import { BACKSTOP_REFRESH_MS, changeWatcher, minuteRefresh } from "./change-watch";

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

describe("minuteRefresh (BTL-275 review: what the stack tick's per-minute notify used to cover)", () => {
  function setup() {
    const s = { notices: [] as unknown[], day: "2026-11-27", t: 0, sent: 0 };
    const tick = minuteRefresh({ notices: () => s.notices, day: () => s.day, now: () => s.t, notify: () => s.sent++ });
    const minute = () => {
      s.t += 60_000;
      tick();
    };
    return { s, minute };
  }

  it("notifies once when the local date changes (today's merges roll over at midnight)", () => {
    const { s, minute } = setup();
    minute();
    expect(s.sent).toBe(0);
    s.day = "2026-11-28";
    minute();
    expect(s.sent).toBe(1);
    minute();
    expect(s.sent).toBe(1);
  });

  it("notifies once per check even when the notices and the date change together", () => {
    const { s, minute } = setup();
    s.day = "2026-11-28";
    s.notices = [{ kind: "x" }];
    minute();
    expect(s.sent).toBe(1);
  });

  it("sends a backstop refresh every 10 minutes when nothing else changed, counted from the last send", () => {
    const { s, minute } = setup();
    expect(BACKSTOP_REFRESH_MS).toBe(10 * 60_000);
    for (let i = 0; i < 9; i++) minute();
    expect(s.sent).toBe(0);
    minute();
    expect(s.sent).toBe(1);
    // 提醒变了发过一次：兜底从那次重新算
    for (let i = 0; i < 4; i++) minute();
    s.notices = [{ kind: "y" }];
    minute();
    expect(s.sent).toBe(2);
    for (let i = 0; i < 9; i++) minute();
    expect(s.sent).toBe(2);
    minute();
    expect(s.sent).toBe(3);
  });
});
