import { describe, expect, it } from "vitest";
import type { BriefContent, MarkState } from "../../shared/brief";
import type { Handoff } from "../../shared/handoff";
import type { Followup, HandoffRecord } from "../../shared/types";
import { emptyHandoff } from "../handoff/schema";
import { buildEveningBrief, buildMorningBrief, type MorningInput, type TicketSnapshot } from "./engine";

/** 2026 年 10 月：16 日周五，19 日周一，20 日周二，21 日周三。 */
const at = (d: number, h = 9, m = 0) => new Date(2026, 9, d, h, m).getTime();
const NOW = at(21);

const snap = (key: string, over: Partial<TicketSnapshot> = {}): TicketSnapshot => ({
  key, status: "active", createdAt: at(1), statusSince: at(20), lastActivityAt: at(20), latest: null, latestDegraded: false, ...over,
});
let nextId = 1;
const rec = (key: string, payload: Partial<Handoff> | null, over: Partial<HandoffRecord> = {}): HandoffRecord => ({
  id: nextId++, ticketKey: key, sessionId: "s", trigger: "nightly", createdAt: at(20, 16),
  payload: payload ? { ...emptyHandoff(key), ...payload } : null, degraded: payload === null, rawText: null, sourceRef: null, ...over,
});
const fu = (id: string, ticketKey: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey, kind: "config", description: `任务 ${id}`, trigger: "after_merge", dueDate: null, status: "open",
  snoozedUntil: null, source: "session", createdAt: at(1), doneAt: null, ...over,
});
const input = (over: Partial<MorningInput> = {}): MorningInput => ({
  now: NOW, tickets: [], followups: [], marks: new Map(), unclaimedCount: 0, previousDay: "2026-10-20", previousDayHandoffs: [],
  thresholds: { blockedDays: 2, reviewWaitDays: 2, staleDays: 5 }, ...over,
});
const summary = (c: BriefContent) => c.items.map((i) => `${i.section}:${i.rule}:${i.ticketKey ?? ""}${i.days !== null ? `:${i.days}` : ""}`);
const openPr = (review: "pending" | "changes_requested" | "approved" | null) => ({ number: 12, url: "https://x/pr/12", state: "open" as const, review });

describe("buildMorningBrief", () => {
  it("puts approved and changes-requested PRs first", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { status: "in_review", latest: rec("A-1", { pr: openPr("approved") }) }),
        snap("B-2", { status: "in_review", latest: rec("B-2", { pr: openPr("changes_requested") }) }),
      ],
    }));
    expect(summary(c)).toEqual(["first:pr_approved:A-1", "first:pr_changes_requested:B-2"]);
    expect(c.items[0]).toMatchObject({ key: "pr_approved:A-1:12", pr: { number: 12, url: "https://x/pr/12" } });
  });

  it("lists open after-merge followups of merged tickets, but not done, ignored or unmerged ones", () => {
    const c = buildMorningBrief(input({
      tickets: [snap("A-1", { status: "merged_pending_followup" }), snap("B-2")],
      followups: [
        fu("f1", "A-1"), fu("f2", "A-1", { status: "done" }), fu("f3", "A-1", { status: "ignored" }),
        fu("f4", "A-1", { trigger: "after_deploy" }), fu("f5", "B-2"),
      ],
    }));
    expect(c.items.map((i) => i.key)).toEqual(["followup:f1"]);
    expect(c.items[0]).toMatchObject({ section: "first", rule: "followup_after_merge", followupId: "f1", text: "任务 f1" });
  });

  it("flags on_date followups due today or overdue, and respects snoozes", () => {
    const due = (id: string, dueDate: string, over: Partial<Followup> = {}) => fu(id, "A-1", { trigger: "on_date", dueDate, ...over });
    const c = buildMorningBrief(input({
      tickets: [snap("A-1", { status: "in_review" })],
      followups: [
        due("today", "2026-10-21"), due("late", "2026-10-18"), due("later", "2026-10-22"),
        due("woke", "2026-10-18", { status: "snoozed", snoozedUntil: "2026-10-21" }),
        due("asleep", "2026-10-18", { status: "snoozed", snoozedUntil: "2026-10-22" }),
      ],
    }));
    expect(c.items.map((i) => [i.rule, i.followupId, i.days])).toEqual([
      ["followup_due", "today", 0], ["followup_due", "late", 3], ["followup_due", "woke", 3],
    ]);
  });

  it("shows the first next step of active tickets only", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { latest: rec("A-1", { next_steps: ["写迁移", "补测试"] }) }),
        snap("B-2", { status: "in_review", latest: rec("B-2", { next_steps: ["等 review"] }) }),
        snap("C-3", { latest: rec("C-3", { next_steps: [] }) }),
      ],
    }));
    expect(summary(c)).toEqual(["today:next_step:A-1"]);
    expect(c.items[0].text).toBe("写迁移");
    expect(c.items[0].key).toMatch(/^next:A-1:\d+$/);
  });

  it("reports tickets blocked for more than N days", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { status: "blocked", statusSince: at(19), latest: rec("A-1", { blockers: ["等接口"] }) }),
        snap("B-2", { status: "blocked", statusSince: at(18), latest: rec("B-2", { blockers: ["等设计稿"] }) }),
      ],
    }));
    expect(summary(c)).toEqual(["today:blocked_long:B-2:3"]);
    expect(c.items[0].text).toBe("等设计稿");
  });

  it("watches PRs waiting for review longer than N days", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { status: "in_review", statusSince: at(18), latest: rec("A-1", { pr: openPr("pending") }) }),
        snap("B-2", { status: "in_review", statusSince: at(20), latest: rec("B-2", { pr: openPr(null) }) }),
      ],
    }));
    expect(summary(c)).toEqual(["watch:review_waiting:A-1:3"]);
  });

  it("watches tickets without activity for more than N days, and unclaimed sessions", () => {
    const c = buildMorningBrief(input({ unclaimedCount: 3, tickets: [snap("A-1", { lastActivityAt: at(15) }), snap("B-2", { lastActivityAt: at(16) })] }));
    expect(summary(c)).toEqual(["watch:stale:A-1:6", "watch:unclaimed:"]);
    expect(c.items[1]).toMatchObject({ count: 3, key: "unclaimed:2026-10-21" });
  });

  it("hides items marked done or ignored, and snoozed ones until their day", () => {
    const tickets = [
      snap("A-1", { latest: rec("A-1", { next_steps: ["x"] }) }),
      snap("B-2", { lastActivityAt: at(10) }),
      snap("C-3", { status: "blocked", statusSince: at(10) }),
    ];
    const keys = buildMorningBrief(input({ tickets })).items.map((i) => i.key);
    expect(keys).toHaveLength(3);
    const marks = new Map<string, MarkState>([
      [keys[0], { mark: "done", untilDate: null }],
      [keys[1], { mark: "snoozed", untilDate: "2026-10-22" }],
      [keys[2], { mark: "snoozed", untilDate: "2026-10-21" }],
    ]);
    expect(buildMorningBrief(input({ tickets, marks })).items.map((i) => i.key)).toEqual([keys[2]]);
    const ignored = new Map<string, MarkState>([[keys[2], { mark: "ignored", untilDate: null }]]);
    expect(buildMorningBrief(input({ tickets, marks: ignored })).items.map((i) => i.key)).toEqual([keys[0], keys[1]]);
  });

  it("does not let item marks hide followup items (those use the followup's own status)", () => {
    const marks = new Map<string, MarkState>([["followup:f1", { mark: "done", untilDate: null }]]);
    const c = buildMorningBrief(input({ tickets: [snap("A-1", { status: "merged_pending_followup" })], followups: [fu("f1", "A-1")], marks }));
    expect(c.items.map((i) => i.key)).toEqual(["followup:f1"]);
  });

  it("orders sections first, today, watch", () => {
    const c = buildMorningBrief(input({
      unclaimedCount: 1,
      tickets: [snap("Z-9", { latest: rec("Z-9", { next_steps: ["a"] }) }), snap("A-1", { status: "in_review", latest: rec("A-1", { pr: openPr("approved") }) })],
    }));
    expect(c.items.map((i) => i.section)).toEqual(["first", "today", "watch"]);
  });

  it("summarises what was done on the previous working day, once per item", () => {
    const c = buildMorningBrief(input({
      previousDay: "2026-10-16",
      previousDayHandoffs: [
        rec("B-2", { done_today: ["修 bug", "写测试"] }),
        rec("A-1", { done_today: ["改配置"] }),
        rec("B-2", { done_today: ["写测试", " 发 PR "] }, { trigger: "command" }),
        rec("A-1", { done_today: ["不该出现"] }, { trigger: "refresh" }),
        rec("C-3", null),
      ],
    }));
    expect(c.previousDay).toEqual({
      date: "2026-10-16",
      entries: [
        { ticketKey: "A-1", done: ["改配置"] },
        { ticketKey: "B-2", done: ["修 bug", "写测试", "发 PR"] },
      ],
    });
    expect(c.evening).toEqual([]);
  });

  it("notes degraded handoffs and missing tracker data", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { latestDegraded: true }),
        snap("B-2", { latest: rec("B-2", { jira: null }) }),
        snap("C-3", { latest: rec("C-3", { jira: { status: "Open", subtasks: [] } }) }),
      ],
    }));
    expect(c.notices).toEqual({ degraded: ["A-1"], trackerUnavailable: ["B-2"] });
  });
});

describe("buildEveningBrief", () => {
  it("lists today's progress per ticket from the latest handoff, with done items from all of today", () => {
    const c = buildEveningBrief({
      now: at(21, 16, 30),
      tickets: [],
      todayHandoffs: [
        rec("A-1", { done_today: ["上午做的"], next_steps: ["旧的下一步"] }, { createdAt: at(21, 11), trigger: "command" }),
        rec("A-1", { done_today: ["下午做的"], next_steps: ["明天先做这个"], blockers: ["等设计稿"] }, { createdAt: at(21, 16) }),
        rec("B-2", null, { createdAt: at(21, 16) }),
        rec("C-3", { done_today: ["x"] }, { trigger: "refresh" }),
      ],
    });
    expect(c.evening).toEqual([
      { ticketKey: "A-1", done: ["上午做的", "下午做的"], blockers: ["等设计稿"], next: "明天先做这个", degraded: false },
      { ticketKey: "B-2", done: [], blockers: [], next: null, degraded: true },
    ]);
    expect(c.items).toEqual([]);
    expect(c.previousDay).toBeNull();
  });
});
