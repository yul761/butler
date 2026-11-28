import { describe, expect, it } from "vitest";
import type { AvailabilityHit, AvailabilityView } from "../../shared/availability";
import type { LessonRunStatus } from "../../shared/lessons";
import type { CostBreakerView } from "../../shared/cost";
import { buildNotices, ciNotices, collectNotices, commentNotices, costNotices, stackNotices, type NoticeSources } from "./notices";
import type { NowNotice } from "../../shared/types";

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

  it("adds a notice while the shared MCP hub cannot start (WS-M H)", () => {
    expect(buildNotices({ availability: view(), recentRuns: [], sharedMcpError: "exited (1)" })).toEqual([{ kind: "shared_mcp_failed", error: "exited (1)" }]);
    expect(buildNotices({ availability: view(), recentRuns: [], sharedMcpError: null })).toEqual([]);
  });
});

describe("ciNotices", () => {
  it("turns each undelivered CI result into a notice that opens its ticket", () => {
    const ci = { item: { kind: "pr" as const, id: 3 }, ticketKey: "T-1", number: 34, branch: "feat/a", reason: "owner_closed" as const, since: 5, sessionId: "s1" };
    expect(ciNotices([ci], (k) => `title of ${k}`)).toEqual([{ kind: "ci_undelivered", ci, title: "title of T-1", target: { page: "ticket", key: "T-1", sessionId: "s1" } }]);
  });
});

describe("costNotices (workstream L)", () => {
  const v = (subjectId: string, state: CostBreakerView["state"], trippedAt: number): CostBreakerView => ({
    subjectKind: "session", subjectId, sessionId: subjectId, ticketKey: "T-1", title: subjectId, state, spent: 1, cap: 1, unit: "usd",
    partial: false, pauseScope: "session", fromModel: null, toModel: null, trippedAt, pausedAt: null, stoppedAt: null, takenOver: false,
  });
  it("puts paused first and links each to its target", () => {
    const out = costNotices([v("a", "warned", 1), v("b", "paused", 5), v("c", "downgraded", 2), v("d", "paused", 3)], (b) => (b.subjectId === "a" ? null : { page: "ticket", key: "T-1", sessionId: b.sessionId }));
    expect(out.map((n) => (n.kind === "cost" ? n.breaker.subjectId : ""))).toEqual(["d", "b", "c", "a"]);
    expect(out[3]).toMatchObject({ kind: "cost", target: null });
    expect(out[0]).toMatchObject({ target: { page: "ticket", key: "T-1", sessionId: "d" } });
  });
});

describe("commentNotices", () => {
  it("makes one notice per waiting PR that opens the ticket", () => {
    const w = { reason: "review" as const, ticketKey: "T-2", prId: 4, number: 9, count: 3, since: 1 };
    expect(commentNotices([w], () => null)).toEqual([{ kind: "comments_waiting", waiting: w, title: null, target: { page: "ticket", key: "T-2", sessionId: null } }]);
  });
});

describe("stackNotices (workstream K)", () => {
  it("links the layer's ticket when it has one", () => {
    const withTicket = { reason: "conflict" as const, stackId: 1, stackName: "pay", branch: "b2", files: ["a.ts"], ticketKey: "T-2" };
    const without = { reason: "behind" as const, stackId: 2, stackName: "x", branch: "b1", commits: 30, days: 4, ticketKey: null };
    expect(stackNotices([withTicket, without])).toEqual([
      { kind: "stack", stack: withTicket, target: { page: "ticket", key: "T-2", sessionId: null } },
      { kind: "stack", stack: without, target: null },
    ]);
  });
});

describe("collectNotices", () => {
  it("keeps every source, the behalf answers and the info flow ones included, in a fixed order", () => {
    const behalf: NowNotice = { kind: "behalf_answered", askId: 7, question: "q", answer: "a", by: "epic 总控", at: 1, target: { page: "ticket", key: "BTL-1", sessionId: null }, title: null };
    const flow: NowNotice = { kind: "flow_synced", actionId: 3, label: "关掉 BTL-12", source: "epic 总控", at: 1 };
    const intake: NowNotice = { kind: "flow_capped", used: 1, cap: 1, resumesAt: 0, dropped: 0 };
    const empty: NoticeSources = { built: [], ci: [], cost: [], comments: [], stack: [], backtest: [], intake: [], behalf: [], infoflow: [] };
    expect(collectNotices({ ...empty, behalf: [behalf] })).toEqual([behalf]);
    expect(collectNotices({ ...empty, infoflow: [flow] })).toEqual([flow]);
    expect(collectNotices({ ...empty, infoflow: [flow], behalf: [behalf], intake: [intake] })).toEqual([intake, behalf, flow]);
  });
});
