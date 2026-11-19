import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INTERRUPT_CATEGORIES, type CompareSide, type MetricAverages, type MetricsOverview, type TrendPoint } from "../../shared/metrics";
import { EffectBody } from "./components/EffectPage";
import {
  barWidths, compare, comparisonText, fmtDuration, fmtNumber, fmtTokens, fmtUsd, groupName, interventionName, interventionRows, lineGeometry, spendName,
} from "./effect-view";
import { S } from "./strings";

const H = 3_600_000;

describe("effect page formatting (ws-h)", () => {
  it("formats numbers, durations and tokens, with — for unknown values", () => {
    expect(fmtNumber(2)).toBe("2");
    expect(fmtNumber(2.34)).toBe("2.3");
    expect(fmtNumber(2.05, 2)).toBe("2.05");
    expect(fmtNumber(null)).toBe("—");
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(0)).toBe(S.durationMinutes(0));
    expect(fmtDuration(30_000)).toBe(S.effect.durUnderMinute);
    expect(fmtDuration(25 * 60_000)).toBe(S.durationMinutes(25));
    expect(fmtDuration(5.5 * H)).toBe(S.effect.durHours("5.5"));
    expect(fmtDuration(3 * 24 * H)).toBe(S.effect.durDays("3"));
    expect(fmtTokens(12_345_678)).toBe("12.3M");
    expect(fmtTokens(45_600)).toBe("45.6K");
    expect(fmtTokens(999.6)).toBe("1000");
    expect(fmtUsd(0.456)).toBe("0.46");
    expect(fmtUsd(12.34)).toBe("12.3");
  });

  it("compares with the baseline where less is better, and only when the baseline has a positive value", () => {
    expect(compare(5, 10)).toEqual({ kind: "delta", pct: "50%", better: true });
    expect(compare(15, 10)).toEqual({ kind: "delta", pct: "50%", better: false });
    expect(compare(10, 10)).toEqual({ kind: "same" });
    expect(compare(null, 10)).toEqual({ kind: "none" });
    expect(compare(5, null)).toEqual({ kind: "none" });
    expect(compare(5, 0)).toEqual({ kind: "none" });
    expect(comparisonText({ kind: "none" })).toBeNull();
    expect(comparisonText(compare(5, 10))).toBe(S.effect.vsBaseline("50%", true));
  });

  it("names interventions, spend keys and the unrated risk group", () => {
    expect(interventionName("terminal_input")).toBe(S.effect.interventionNames.terminal_input);
    expect(interventionName("terminal_input:prompt")).toBe(`${S.effect.interventionNames.terminal_input} · ${S.effect.interventionNames.prompt}`);
    expect(interventionName("manual_trigger:lessons:run")).toBe(`${S.effect.interventionNames.manual_trigger} · lessons:run`);
    expect(interventionName("brand_new")).toBe("brand_new");
    expect(spendName("(interactive)")).toBe(S.effect.interactive);
    expect(spendName("(default)")).toBe(S.effect.defaultModel);
    expect(spendName("lesson")).toBe("lesson");
    expect(groupName("unrated")).toBe(S.effect.unrated);
    expect(groupName("o/app")).toBe("o/app");
  });

  it("nests subtypes under their kind and keeps orphans as their own rows", () => {
    const rows = interventionRows([
      { key: "terminal_input", n: 3, total: 3 }, { key: "terminal_input:prompt", n: 2, total: 2 }, { key: "terminal_input:dialog", n: 1, total: 1 },
      { key: "needs_you_answer:card", n: 1, total: 1 },
    ]);
    expect(rows.map((r) => [r.key, r.n, r.subs.map((s) => s.key)])).toEqual([
      ["terminal_input", 3, ["terminal_input:prompt", "terminal_input:dialog"]],
      ["needs_you_answer:card", 1, []],
    ]);
  });

  it("scales bars to the largest value", () => {
    expect(barWidths([5, 10, 0])).toEqual([50, 100, 0]);
    expect(barWidths([0, 0])).toEqual([0, 0]);
    expect(barWidths([])).toEqual([]);
  });

  it("draws a line from zero, breaking at missing points", () => {
    const g = lineGeometry([10, null, 5, 10], 100, 50, 0);
    expect(g.max).toBe(10);
    expect(g.points.map((p) => p.i)).toEqual([0, 2, 3]);
    expect(g.path.match(/M/g)).toHaveLength(2);
    // 最大值在 1.1 倍高度处：不顶到边。
    expect(g.points[0].y).toBeCloseTo(50 - 50 / 1.1);
    expect(g.points[1].x).toBeCloseTo(200 / 3);
    expect(lineGeometry([null, null], 100, 50, 0)).toEqual({ path: "", points: [], max: 0 });
  });
});

const avg = (o: Partial<MetricAverages> = {}): MetricAverages => ({
  prs: 0, cycleOpenMs: null, cycleTicketMs: null, commentsHuman: null, commentsCopilot: null, commentsAvoidable: null,
  interventions: null, waitHumanMs: null, costWeighted: null, costUsd: null, costUsdPartial: false, ...o,
});
const point = (start: string, o: Partial<TrendPoint> = {}): TrendPoint => ({ start, prs: 0, cycleOpenMs: null, comments: null, interventions: null, costWeighted: null, ...o });

const overview = (o: Partial<MetricsOverview> = {}): MetricsOverview => ({
  days: 30, from: "2026-10-20", to: "2026-11-18", generatedAt: 0, rolledUpAt: null,
  butler: avg({ prs: 4, cycleOpenMs: 6 * H, commentsHuman: 1, commentsCopilot: 1, commentsAvoidable: 0.5, interventions: 2, waitHumanMs: H, costWeighted: 2_000_000 }),
  other: avg({ prs: 1, cycleOpenMs: 30 * H }),
  baseline: { prs: 20, cycleOpenMs: 12 * H, cycleTicketMs: null, commentsHuman: 3, commentsCopilot: 1, cutoff: new Date(2026, 5, 1).getTime() },
  trend: { week: [point("2026-11-09"), point("2026-11-16", { prs: 4, cycleOpenMs: 6 * H })], month: [point("2026-11-01", { prs: 4 })] },
  interrupts: INTERRUPT_CATEGORIES.map((category, i) => ({ category, count: i, waitMs: i * H })),
  autoResolved: 3, waitHumanMs: 10 * H, waitIdleMs: 2 * H,
  interventions: [{ key: "terminal_input", n: 5, total: 5 }, { key: "terminal_input:prompt", n: 5, total: 5 }],
  groups: [{ kind: "risk", key: "unrated", prs: 4, cycleOpenMs: 6 * H, comments: 2, interventions: 2, costWeighted: 2_000_000 }],
  spend: { byModel: [{ key: "(default)", n: 3, total: 1_500_000 }], byTask: [{ key: "(interactive)", n: 3, total: 1_500_000 }] },
  rework: { prs: 4, ciFailures: 2, reopens: 0, reverts: 1 },
  otherEvents: [],
  interruptCompare: null,
  ...o,
});

describe("EffectBody (ws-h)", () => {
  it("shows the four cards against the baseline, interrupt shares and the breakdowns", () => {
    const html = renderToStaticMarkup(createElement(EffectBody, { o: overview() }));
    for (const id of ["effect-card-cycle", "effect-card-comments", "effect-card-interventions", "effect-card-cost", "effect-interrupts", "effect-trend", "effect-groups", "effect-spend", "effect-rework"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    // 周期 6 小时 vs 之前 12 小时；评论 2 vs 4：都少 50%。
    expect(html.split(S.effect.vsBaseline("50%", true)).length - 1).toBe(2);
    // 介入和花费基线不算。
    expect(html.split(S.effect.noBaseline).length - 1).toBe(2);
    for (const c of INTERRUPT_CATEGORIES) expect(html).toContain(S.effect.interruptNames[c]);
    expect(html).toContain(S.effect.autoResolved(3));
    expect(html).toContain(S.effect.unrated);
    expect(html).toContain(S.effect.interactive);
    expect(html).not.toContain('data-testid="effect-other-events"');
  });

  it("shows — for the baseline when there is none, and the empty note without Butler PRs", () => {
    const html = renderToStaticMarkup(createElement(EffectBody, { o: overview({ baseline: null, butler: avg() }) }));
    expect(html.split(S.effect.noBaseline).length - 1).toBe(4);
    expect(html).toContain(S.effect.baselineMissing);
    expect(html).toContain(S.effect.empty);
    expect(html).not.toContain(S.effect.vsBaseline("50%", true));
  });

  it("lists other events when there are some", () => {
    const html = renderToStaticMarkup(createElement(EffectBody, { o: overview({ otherEvents: [{ key: "cost.warn", n: 2, total: 2 }] }) }));
    expect(html).toContain('data-testid="effect-other-events"');
    expect(html).toContain("cost.warn");
  });
});

describe("EffectBody before/after (ws-j)", () => {
  const side = (o: Partial<CompareSide>): CompareSide => ({
    from: "2026-10-01", to: "2026-10-10", days: 10, prs: 2, interventions: 3, waitHumanMs: H, autoResolved: 0, stuckFixes: 1,
    interruptsPerDay: Object.fromEntries(INTERRUPT_CATEGORIES.map((c) => [c, 0])) as CompareSide["interruptsPerDay"], ...o,
  });
  it("says the comparison starts later until a feature is on, then shows both sides", () => {
    expect(renderToStaticMarkup(createElement(EffectBody, { o: overview() }))).toContain(S.effect.compareNotYet);
    const html = renderToStaticMarkup(createElement(EffectBody, {
      o: overview({ interruptCompare: { since: new Date(2026, 9, 11).getTime(), before: side({ interventions: 3 }), after: side({ from: "2026-10-11", to: "2026-10-20", interventions: 1.5, autoResolved: 7 }) } }),
    }));
    expect(html).toContain('data-testid="effect-compare-interventions"');
    expect(html).toMatch(/effect-compare-interventions"><td>[^<]+<\/td><td>3<\/td><td>1.5<\/td>/);
    expect(html).toContain(">7<");
  });
});
