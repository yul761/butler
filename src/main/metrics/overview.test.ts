import { describe, expect, it } from "vitest";
import type { BaselinePr, DailyRow } from "../db/metrics-repo";
import { baselineAverages, baselineCutoff, buildOverview, clampDays, monthStart, overviewFromDay, weekStart, windowFromDay } from "./overview";
import { dayOf } from "./rollup";

const H = 3_600_000;
// 2026-10-15 是周四。
const NOW = new Date(2026, 9, 15, 12).getTime();
const TODAY = dayOf(NOW);

const row = (o: Partial<DailyRow> & Pick<DailyRow, "metric">): DailyRow => ({ day: TODAY, groupKind: "all", groupKey: "", butler: true, n: 1, total: 1, ...o });

/** 一个 Butler PR 在 day 合并：周期 cycle 小时，评论、介入、花费。 */
const prRows = (day: string, o: { cycleH?: number; human?: number; copilot?: number; interventions?: number; cost?: number; butler?: boolean; group?: Pick<DailyRow, "groupKind" | "groupKey"> } = {}): DailyRow[] => {
  const base = { day, butler: o.butler ?? true, ...(o.group ?? {}) };
  return [
    row({ ...base, metric: "pr_merged" }),
    row({ ...base, metric: "cycle_open_ms", total: (o.cycleH ?? 10) * H }),
    row({ ...base, metric: "comments_human", total: o.human ?? 2 }),
    row({ ...base, metric: "comments_copilot", total: o.copilot ?? 1 }),
    row({ ...base, metric: "interventions", total: o.interventions ?? 3 }),
    row({ ...base, metric: "cost_weighted", total: o.cost ?? 1000 }),
  ];
};

const base = (o: Partial<BaselinePr> = {}): BaselinePr => ({
  slug: "o/app", number: 1, openedAt: 0, mergedAt: 20 * H, firstCommitAt: -10 * H, humanComments: 4, copilotComments: 0, fetchedAt: 0, ...o,
});

const overview = (daily: DailyRow[], baseline: BaselinePr[] = [], days = 30) =>
  buildOverview({ daily, baseline, cutoff: NOW - 100 * 24 * H, now: NOW, days, rolledUpAt: NOW - H });

describe("buildOverview", () => {
  it("averages the last 30 days of Butler PRs, apart from other PRs and older days", () => {
    const old = dayOf(NOW - 40 * 24 * H);
    const o = overview([
      ...prRows(TODAY, { cycleH: 10, human: 2 }),
      ...prRows(dayOf(NOW - 5 * 24 * H), { cycleH: 20, human: 4 }),
      ...prRows(old, { cycleH: 100 }),
      ...prRows(TODAY, { butler: false, cycleH: 50 }),
    ]);
    expect(o.from).toBe(windowFromDay(NOW, 30));
    expect(o.butler).toMatchObject({ prs: 2, cycleOpenMs: 15 * H, commentsHuman: 3, commentsCopilot: 1, interventions: 3, costWeighted: 1000 });
    expect(o.other).toMatchObject({ prs: 1, cycleOpenMs: 50 * H });
    expect(o.rolledUpAt).toBe(NOW - H);
  });

  it("returns nulls, not zeros, when there are no PRs", () => {
    const o = overview([]);
    expect(o.butler).toMatchObject({ prs: 0, cycleOpenMs: null, commentsHuman: null, costWeighted: null, costUsdPartial: false });
    expect(o.baseline).toBeNull();
  });

  it("compares with the baseline before the cutoff", () => {
    const cutoff = NOW - 100 * 24 * H;
    const o = overview([], [base(), base({ number: 2, openedAt: 0, mergedAt: 40 * H, firstCommitAt: null, humanComments: 0, copilotComments: 2 }), base({ number: 3, mergedAt: cutoff + 1 })]);
    expect(o.baseline).toEqual({ prs: 2, cycleOpenMs: 30 * H, cycleTicketMs: 30 * H, commentsHuman: 2, commentsCopilot: 1, cutoff });
  });

  it("buckets the trend by week (Mondays) and month, oldest first", () => {
    const monday = weekStart(NOW);
    expect(new Date(monday).getDay()).toBe(1);
    const lastWeek = dayOf(monday - 2 * 24 * H);
    const o = overview([...prRows(TODAY, { cycleH: 10 }), ...prRows(dayOf(monday), { cycleH: 30 }), ...prRows(lastWeek, { cycleH: 4 })]);
    expect(o.trend.week).toHaveLength(12);
    expect(o.trend.week[11]).toMatchObject({ start: dayOf(monday), prs: 2, cycleOpenMs: 20 * H, comments: 3 });
    expect(o.trend.week[10]).toMatchObject({ prs: 1, cycleOpenMs: 4 * H });
    expect(o.trend.week[0].prs).toBe(0);
    expect(o.trend.month).toHaveLength(12);
    expect(o.trend.month[11]).toMatchObject({ start: dayOf(monthStart(NOW)), prs: 3 });
    expect(o.trend.month[0].start).toBe("2025-11-01");
  });

  it("shows interrupt shares by count and waiting time, with auto-resolved ones", () => {
    const o = overview([
      row({ metric: "interrupt:permission", n: 3, total: 3 }),
      row({ metric: "wait_human:permission", n: 3, total: 60_000 }),
      row({ metric: "interrupt:missing_info", n: 1, total: 1 }),
      row({ metric: "wait_human:missing_info", n: 1, total: 600_000 }),
      row({ metric: "wait_idle", n: 2, total: 5 * H }),
      row({ metric: "event:interrupt_auto_resolved", n: 2, total: 2 }),
      row({ metric: "interrupt:permission", butler: false, n: 9, total: 9 }),
    ]);
    expect(o.interrupts.find((x) => x.category === "permission")).toEqual({ category: "permission", count: 3, waitMs: 60_000 });
    expect(o.interrupts.find((x) => x.category === "stuck")).toEqual({ category: "stuck", count: 0, waitMs: 0 });
    expect(o.interrupts.map((x) => x.category)).toEqual(["permission", "choice", "missing_info", "question", "stuck"]);
    expect(o.autoResolved).toBe(2);
    expect(o.waitHumanMs).toBe(660_000);
    expect(o.waitIdleMs).toBe(5 * H);
  });

  it("breaks interventions down by kind and subtype, and lists other events", () => {
    const o = overview([
      row({ metric: "event:terminal_input", total: 5 }),
      row({ metric: "event_sub:terminal_input:prompt", total: 4 }),
      row({ metric: "event_sub:terminal_input:dialog", total: 1 }),
      row({ metric: "event:manual_merge", total: 2 }),
      row({ metric: "event:agent_merge", total: 3 }),
      row({ metric: "event:cost.pause", butler: false, total: 1 }),
      row({ metric: "event:something_new", total: 1 }),
      row({ metric: "event:interrupt", total: 7 }),
    ]);
    expect(o.interventions.map((x) => [x.key, x.n])).toEqual([
      ["terminal_input", 5], ["terminal_input:prompt", 4], ["manual_merge", 2], ["terminal_input:dialog", 1],
    ]);
    expect(o.otherEvents.map((x) => [x.key, x.n])).toEqual([["agent_merge", 3], ["cost.pause", 1], ["something_new", 1]]);
  });

  it("groups Butler PRs by repo, product and risk; spend by model and task; rework", () => {
    const repo = { groupKind: "repo" as const, groupKey: "o/app" };
    const o = overview([
      ...prRows(TODAY, { cycleH: 8 }),
      ...prRows(TODAY, { cycleH: 8, group: repo }),
      ...prRows(TODAY, { cycleH: 8, group: { groupKind: "risk", groupKey: "unrated" } }),
      ...prRows(TODAY, { butler: false, group: { groupKind: "repo", groupKey: "o/other" } }),
      row({ metric: "spend_model:m1", n: 2, total: 50 }),
      row({ metric: "spend_model:m2", n: 9, total: 500 }),
      row({ metric: "spend_task:handoff", n: 1, total: 20 }),
      row({ metric: "ci_failures", total: 2 }),
      row({ metric: "reverts", total: 1 }),
    ]);
    expect(o.groups.map((g) => [g.kind, g.key, g.prs, g.cycleOpenMs])).toEqual([["repo", "o/app", 1, 8 * H], ["risk", "unrated", 1, 8 * H]]);
    expect(o.spend.byModel.map((x) => x.key)).toEqual(["m2", "m1"]);
    expect(o.spend.byTask).toEqual([{ key: "handoff", n: 1, total: 20 }]);
    expect(o.rework).toEqual({ prs: 1, ciFailures: 2, reopens: 0, reverts: 1 });
  });

  it("honours days and clamps it to 1–365", () => {
    const o = overview([...prRows(TODAY), ...prRows(dayOf(NOW - 3 * 24 * H))], [], 1);
    expect(o.butler.prs).toBe(1);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(9999)).toBe(365);
    expect(clampDays("x")).toBe(30);
    expect(clampDays(7.4)).toBe(7);
  });

  it("reads far enough back for the window and both trends", () => {
    expect(overviewFromDay(NOW, 30)).toBe("2025-11-01");
    expect(overviewFromDay(NOW, 365)).toBe(windowFromDay(NOW, 365));
  });
});

describe("baseline", () => {
  it("uses the first Butler session, else the metrics start", () => {
    expect(baselineCutoff(5, 9)).toBe(5);
    expect(baselineCutoff(null, 9)).toBe(9);
  });

  it("clamps negative cycles to zero", () => {
    expect(baselineAverages([base({ openedAt: 30 * H, mergedAt: 20 * H, firstCommitAt: 25 * H })], 100 * H)).toMatchObject({ cycleOpenMs: 0, cycleTicketMs: 0 });
  });
});
