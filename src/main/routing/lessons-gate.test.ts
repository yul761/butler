import { describe, expect, it, vi } from "vitest";
import type { LessonsGate } from "../claude/availability";
import { LESSONS_LOCAL_BACKOFF_MS, RoutedLessonsGate } from "./lessons-gate";

function setup(configured: boolean) {
  let gate: LessonsGate = { paused: false };
  let blocked: number | null = null;
  let now = 1000;
  const availability = {
    lessonsGate: () => gate,
    subscribe: () => () => undefined,
    resumeLessons: vi.fn(() => void (gate = { paused: false })),
    pauseLessons: vi.fn(() => void (gate = { paused: true, reason: "manual", until: null, message: null })),
    report: vi.fn(),
  };
  const g = new RoutedLessonsGate({
    availability, now: () => now,
    routing: { configured: () => configured, lessonsBlockedUntil: () => blocked, subscribe: () => () => undefined },
    setTimer: () => 1, clearTimer: () => undefined,
  });
  return { g, availability, setGate: (x: LessonsGate) => void (gate = x), block: (x: number | null) => void (blocked = x), tick: (ms: number) => void (now += ms) };
}

describe("RoutedLessonsGate", () => {
  it("unconfigured: exactly the account gate", () => {
    const { g, availability, setGate } = setup(false);
    setGate({ paused: true, reason: "limit", until: 5, message: "m" });
    expect(g.lessonsGate(1)).toEqual({ paused: true, reason: "limit", until: 5, message: "m" });
    g.report({ kind: "rate_limit", resetsAt: null, message: "x", source: "headless", job: "lessons", sessionId: null });
    expect(availability.report).toHaveBeenCalledTimes(1);
  });

  it("configured: an account-wide limit does not stop lessons, a manual pause does", () => {
    const { g, setGate } = setup(true);
    setGate({ paused: true, reason: "limit", until: 5000, message: "m" });
    expect(g.lessonsGate(1000)).toEqual({ paused: false });
    g.pauseLessons();
    expect(g.lessonsGate(1000)).toMatchObject({ paused: true, reason: "manual" });
  });

  it("configured: closes when lesson_analyze can run nowhere", () => {
    const { g, block } = setup(true);
    block(9000);
    expect(g.lessonsGate(1000)).toMatchObject({ paused: true, reason: "limit", until: 9000 });
  });

  it("configured: an unattributed limit backs off locally, resume clears it", () => {
    const { g, availability, tick } = setup(true);
    g.report({ kind: "rate_limit", resetsAt: null, message: "x", source: "headless", job: "lessons", sessionId: null });
    expect(availability.report).not.toHaveBeenCalled();
    expect(g.lessonsGate(1000)).toMatchObject({ paused: true, until: 1000 + LESSONS_LOCAL_BACKOFF_MS });
    tick(LESSONS_LOCAL_BACKOFF_MS);
    expect(g.lessonsGate(1000 + LESSONS_LOCAL_BACKOFF_MS)).toEqual({ paused: false });
    g.report({ kind: "rate_limit", resetsAt: null, message: "x", source: "headless", job: "lessons", sessionId: null });
    g.resumeLessons();
    expect(g.lessonsGate(1000 + LESSONS_LOCAL_BACKOFF_MS)).toEqual({ paused: false });
  });
});
