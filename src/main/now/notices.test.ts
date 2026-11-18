import { describe, expect, it } from "vitest";
import type { AvailabilityHit, AvailabilityView } from "../../shared/availability";
import type { LessonRunStatus } from "../../shared/lessons";
import { buildNotices } from "./notices";

const hit = (kind: AvailabilityHit["kind"]): AvailabilityHit => ({ kind, resetsAt: 5000, message: "m", at: 1, source: "headless", job: "lessons", sessionId: null });
const view = (over: Partial<AvailabilityView> = {}): AvailabilityView => ({ state: "ok", current: null, lastHit: null, retryAt: null, lessonsPause: null, ...over });
const runs = (...statuses: LessonRunStatus[]) => statuses.map((status) => ({ status }));

describe("buildNotices", () => {
  it("model routing attention becomes a routing notice", () => {
    expect(buildNotices({ availability: view(), recentRuns: [], routing: null })).toEqual([]);
    expect(buildNotices({ availability: view(), recentRuns: [], routing: { limited: ["H"], fallbacks: 2 } })).toEqual([{ kind: "routing", limited: ["H"], fallbacks: 2 }]);
  });

  it("a usage limit gives claude_limited with the pause flag", () => {
    const h = hit("usage_limit");
    const paused = view({ state: "limited", current: h, retryAt: 5000, lessonsPause: { reason: "limit", since: 1, until: 5000 } });
    expect(buildNotices({ availability: paused, recentRuns: [] })).toEqual([{ kind: "claude_limited", hit: h, retryAt: 5000, lessonsPaused: true }]);
    const free = view({ state: "limited", current: h, retryAt: null });
    expect(buildNotices({ availability: free, recentRuns: [] })).toEqual([{ kind: "claude_limited", hit: h, retryAt: null, lessonsPaused: false }]);
  });

  it("a manual pause during a limit gives claude_limited unpaused plus lessons_paused", () => {
    const h = hit("usage_limit");
    const a = view({ state: "limited", current: h, retryAt: 5000, lessonsPause: { reason: "manual", since: 1, until: null } });
    expect(buildNotices({ availability: a, recentRuns: [] })).toEqual([
      { kind: "claude_limited", hit: h, retryAt: 5000, lessonsPaused: false },
      { kind: "lessons_paused" },
    ]);
  });

  it("model unavailable gives its own notice", () => {
    const h = hit("model_unavailable");
    expect(buildNotices({ availability: view({ state: "model_unavailable", current: h, retryAt: 9 }), recentRuns: [] })).toEqual([{ kind: "model_unavailable", hit: h, retryAt: 9 }]);
  });

  it("a manual pause gives lessons_paused", () => {
    const a = view({ lessonsPause: { reason: "manual", since: 1, until: null } });
    expect(buildNotices({ availability: a, recentRuns: [] })).toEqual([{ kind: "lessons_paused" }]);
  });

  it("three failed runs in a row give lessons_failing; a limited run in between is ignored", () => {
    expect(buildNotices({ availability: view(), recentRuns: runs("failed", "limited", "failed", "cancelled", "failed", "done") })).toEqual([{ kind: "lessons_failing", count: 3 }]);
    expect(buildNotices({ availability: view(), recentRuns: runs("failed", "failed", "failed", "failed", "aborted", "done") })).toEqual([{ kind: "lessons_failing", count: 4 }]);
  });

  it("two failures give nothing", () => {
    expect(buildNotices({ availability: view(), recentRuns: runs("failed", "failed", "done", "failed") })).toEqual([]);
    expect(buildNotices({ availability: view(), recentRuns: runs("failed", "failed") })).toEqual([]);
  });
});
