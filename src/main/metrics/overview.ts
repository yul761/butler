import type { BaselinePr, DailyRow } from "../db/metrics-repo";
import {
  INTERRUPT_CATEGORIES,
  METRICS_DAYS_DEFAULT,
  METRICS_DAYS_MAX,
  type BaselineAverages,
  type GroupMetrics,
  type KeyCount,
  type MetricAverages,
  type MetricsOverview,
  type TrendPoint,
} from "../../shared/metrics";
import { METRIC_KINDS } from "./events";
import { dayOf } from "./rollup";

/** 趋势：最近 12 周、12 个月。 */
export const TREND_POINTS = 12;

export interface OverviewInput {
  /** metrics_daily 里 overviewFromDay 之后的行。 */
  daily: readonly DailyRow[];
  baseline: readonly BaselinePr[];
  /** 基线截止点（baselineCutoff）。 */
  cutoff: number;
  now: number;
  days: number;
  rolledUpAt: number | null;
}

/** 天数夹在 1–365 之间；不是数字的用默认 30。 */
export function clampDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isFinite(days)) return METRICS_DAYS_DEFAULT;
  return Math.min(METRICS_DAYS_MAX, Math.max(1, Math.round(days)));
}

/** 本地日期加减天数。 */
function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** 这一周的周一（本地零点）。 */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** 这个月一号（本地零点）。 */
export function monthStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function monthsBefore(ms: number, n: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() - n, 1).getTime();
}

/** 最近 days 天的第一天（今天算一天）。 */
export function windowFromDay(now: number, days: number): string {
  return dayOf(addDays(now, -(days - 1)));
}

/** 总览要读的 metrics_daily 从哪天开始：窗口、12 周、12 个月里最早的。 */
export function overviewFromDay(now: number, days: number): string {
  const starts = [windowFromDay(now, days), dayOf(addDays(weekStart(now), -7 * (TREND_POINTS - 1))), dayOf(monthsBefore(now, TREND_POINTS - 1))];
  return starts.sort()[0];
}

/** 按 metric 累加 n 和 total。 */
class Totals {
  private readonly m = new Map<string, { n: number; total: number }>();

  add(r: DailyRow): void {
    const cur = this.m.get(r.metric);
    if (cur) {
      cur.n += r.n;
      cur.total += r.total;
    } else this.m.set(r.metric, { n: r.n, total: r.total });
  }

  n(metric: string): number {
    return this.m.get(metric)?.n ?? 0;
  }

  total(metric: string): number {
    return this.m.get(metric)?.total ?? 0;
  }

  /** 平均到每个 n 上（比如周期只在有这个值的 PR 上平均）。 */
  mean(metric: string): number | null {
    const v = this.m.get(metric);
    return v && v.n > 0 ? v.total / v.n : null;
  }

  /** 带前缀的 metric：前缀后面的部分 → 次数和合计。 */
  prefixed(prefix: string): KeyCount[] {
    const out: KeyCount[] = [];
    for (const [metric, v] of this.m) if (metric.startsWith(prefix)) out.push({ key: metric.slice(prefix.length), n: v.n, total: v.total });
    return out;
  }
}

function totalsOf(rows: Iterable<DailyRow>): Totals {
  const t = new Totals();
  for (const r of rows) t.add(r);
  return t;
}

const perPr = (t: Totals, metric: string): number | null => {
  const prs = t.total("pr_merged");
  return prs > 0 ? t.total(metric) / prs : null;
};

function averagesOf(t: Totals): MetricAverages {
  return {
    prs: t.total("pr_merged"),
    cycleOpenMs: t.mean("cycle_open_ms"),
    cycleTicketMs: t.mean("cycle_ticket_ms"),
    commentsHuman: perPr(t, "comments_human"),
    commentsCopilot: perPr(t, "comments_copilot"),
    commentsAvoidable: perPr(t, "comments_avoidable"),
    interventions: perPr(t, "interventions"),
    waitHumanMs: perPr(t, "wait_human_ms"),
    costWeighted: perPr(t, "cost_weighted"),
    costUsd: perPr(t, "cost_usd"),
    costUsdPartial: t.total("cost_usd_partial") > 0,
  };
}

const commentsOf = (t: Totals): number | null => {
  const h = perPr(t, "comments_human");
  return h === null ? null : h + (perPr(t, "comments_copilot") ?? 0);
};

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** 基线 PR 的平均：截止点之前合并的。一个都没有为 null。 */
export function baselineAverages(prs: readonly BaselinePr[], cutoff: number): BaselineAverages | null {
  const before = prs.filter((p) => p.mergedAt < cutoff);
  if (before.length === 0) return null;
  const ticket = before.filter((p) => p.firstCommitAt !== null).map((p) => Math.max(0, p.mergedAt - (p.firstCommitAt as number)));
  return {
    prs: before.length,
    cycleOpenMs: mean(before.map((p) => Math.max(0, p.mergedAt - p.openedAt))),
    cycleTicketMs: mean(ticket),
    commentsHuman: mean(before.map((p) => p.humanComments)),
    commentsCopilot: mean(before.map((p) => p.copilotComments)),
    cutoff,
  };
}

const byN = (a: KeyCount, b: KeyCount) => b.n - a.n || a.key.localeCompare(b.key);
const byTotal = (a: KeyCount, b: KeyCount) => b.total - a.total || a.key.localeCompare(b.key);

function trendPoint(start: string, t: Totals): TrendPoint {
  return { start, prs: t.total("pr_merged"), cycleOpenMs: t.mean("cycle_open_ms"), comments: commentsOf(t), interventions: perPr(t, "interventions"), costWeighted: perPr(t, "cost_weighted") };
}

/** starts 升序；每一格是 [start, 下一格的 start)，最后一格到最后。 */
function trend(rows: readonly DailyRow[], starts: string[]): TrendPoint[] {
  const buckets = starts.map(() => new Totals());
  for (const r of rows) {
    if (r.day < starts[0]) continue;
    let i = starts.length - 1;
    while (i > 0 && r.day < starts[i]) i--;
    buckets[i].add(r);
  }
  return starts.map((s, i) => trendPoint(s, buckets[i]));
}

/** 从 metrics_daily 和基线算「效果」页的总览（纯函数）。 */
export function buildOverview(input: OverviewInput): MetricsOverview {
  const days = clampDays(input.days);
  const from = windowFromDay(input.now, days);
  const to = dayOf(input.now);
  const inWindow = input.daily.filter((r) => r.day >= from && r.day <= to);
  const all = (butler: boolean) => inWindow.filter((r) => r.groupKind === "all" && r.butler === butler);
  const butlerAll = totalsOf(all(true));
  const otherAll = totalsOf(all(false));
  const anyAll = totalsOf(inWindow.filter((r) => r.groupKind === "all"));

  const groups: GroupMetrics[] = [];
  const groupRows = new Map<string, DailyRow[]>();
  for (const r of inWindow) {
    if (r.groupKind === "all" || !r.butler) continue;
    const k = `${r.groupKind}\u0000${r.groupKey}`;
    const list = groupRows.get(k);
    if (list) list.push(r);
    else groupRows.set(k, [r]);
  }
  for (const [k, rows] of groupRows) {
    const [kind, key] = k.split("\u0000") as [GroupMetrics["kind"], string];
    const t = totalsOf(rows);
    if (t.total("pr_merged") === 0) continue;
    groups.push({ kind, key, prs: t.total("pr_merged"), cycleOpenMs: t.mean("cycle_open_ms"), comments: commentsOf(t), interventions: perPr(t, "interventions"), costWeighted: perPr(t, "cost_weighted") });
  }
  groups.sort((a, b) => a.kind.localeCompare(b.kind) || b.prs - a.prs || a.key.localeCompare(b.key));

  const interventions: KeyCount[] = [];
  for (const [kind, group] of Object.entries(METRIC_KINDS)) {
    if (group !== "intervention") continue;
    const n = butlerAll.total(`event:${kind}`);
    if (n > 0) interventions.push({ key: kind, n, total: n });
  }
  for (const s of butlerAll.prefixed("event_sub:")) {
    const kind = s.key.slice(0, s.key.indexOf(":"));
    if (METRIC_KINDS[kind] === "intervention") interventions.push({ key: s.key, n: s.total, total: s.total });
  }
  interventions.sort(byN);

  const otherEvents = anyAll
    .prefixed("event:")
    .filter((e) => (METRIC_KINDS[e.key] ?? "other") === "other")
    .map((e) => ({ key: e.key, n: e.total, total: e.total }))
    .sort(byN);

  const trendRows = input.daily.filter((r) => r.groupKind === "all" && r.butler);
  const weekStarts = Array.from({ length: TREND_POINTS }, (_, i) => dayOf(addDays(weekStart(input.now), -7 * (TREND_POINTS - 1 - i))));
  const monthStarts = Array.from({ length: TREND_POINTS }, (_, i) => dayOf(monthsBefore(input.now, TREND_POINTS - 1 - i)));

  return {
    days,
    from,
    to,
    generatedAt: input.now,
    rolledUpAt: input.rolledUpAt,
    butler: averagesOf(butlerAll),
    other: averagesOf(otherAll),
    baseline: baselineAverages(input.baseline, input.cutoff),
    trend: { week: trend(trendRows, weekStarts), month: trend(trendRows, monthStarts) },
    interrupts: INTERRUPT_CATEGORIES.map((category) => ({ category, count: butlerAll.total(`interrupt:${category}`), waitMs: butlerAll.total(`wait_human:${category}`) })),
    autoResolved: butlerAll.total("event:interrupt_auto_resolved"),
    waitHumanMs: butlerAll.prefixed("wait_human:").reduce((a, x) => a + x.total, 0),
    waitIdleMs: butlerAll.total("wait_idle"),
    interventions,
    groups,
    spend: {
      byModel: butlerAll.prefixed("spend_model:").map((x) => ({ key: x.key, n: x.n, total: x.total })).sort(byTotal),
      byTask: butlerAll.prefixed("spend_task:").map((x) => ({ key: x.key, n: x.n, total: x.total })).sort(byTotal),
    },
    rework: { prs: butlerAll.total("pr_merged"), ciFailures: butlerAll.total("ci_failures"), reopens: butlerAll.total("reopens"), reverts: butlerAll.total("reverts") },
    otherEvents,
  };
}
