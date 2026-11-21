import { describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "../../shared/activity";
import { ActivityLog } from "./activity-log";

const ev = (n: number): ActivityEvent => ({ kind: "tool", sessionId: "s1", label: `Read ${n}`, at: n }) as ActivityEvent;

describe("ActivityLog", () => {
  it("keeps events that arrived while nobody was looking, newest last, at most the limit", () => {
    const log = new ActivityLog(3);
    for (let i = 1; i <= 5; i++) log.push(ev(i));
    expect(log.snapshot().map((e) => e.at)).toEqual([3, 4, 5]);
  });

  it("tells subscribers about each new event and stops after unsubscribing", () => {
    const log = new ActivityLog(10);
    const fn = vi.fn();
    const off = log.subscribe(fn);
    log.push(ev(1));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    log.push(ev(2));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns the same array until something new arrives (useSyncExternalStore needs a stable snapshot)", () => {
    const log = new ActivityLog(10);
    log.push(ev(1));
    const a = log.snapshot();
    expect(log.snapshot()).toBe(a);
    log.push(ev(2));
    expect(log.snapshot()).not.toBe(a);
  });
});
