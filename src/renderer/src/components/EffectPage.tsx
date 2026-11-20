import { useState, type ReactNode } from "react";
import type { IntakeEffect } from "../../../shared/intake";
import type { LoopEffect } from "../../../shared/loop";
import type { ReviewEffectView, ReviewGroupStats } from "../../../shared/review-effect";
import { INTERRUPT_CATEGORIES, type CompareSide, type GroupMetrics, type KeyCount, type MetricsOverview, type TrendPoint } from "../../../shared/metrics";
import { api } from "../api";
import {
  barWidths, compare, comparisonText, DAY_CHOICES, DASH, fmtDay, fmtDuration, fmtNumber, fmtTokens, fmtUsd,
  groupName, interventionName, interventionRows, lineGeometry, spendName,
} from "../effect-view";
import { EFFECT_TABS, type EffectTabId } from "../butler-self-view";
import { shortTime } from "../progress-ui";
import { dayString, enoughSample } from "../review-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";
import { IntakeEffectSection } from "./IntakeQueue";
import { PageTabs, type PageTab } from "./PageTabs";

const E = () => S.effect;

/**
 * 一张卡：大数字、说明、和基线比。mine 是拿来比的数；base 为 null 表示基线不算这一项（写 "之前 —"），
 * base.value 为 null 表示基线里这一项没有值。
 */
function Card({ testId, title, value, sub, extra, mine, base }: {
  testId: string; title: string; value: string; sub: string; extra?: string | null;
  mine: number | null; base: { value: number | null; text: string } | null;
}) {
  const c = base ? comparisonText(compare(mine, base.value)) : null;
  return (
    <div className="effect-card" data-testid={testId}>
      <div className="effect-card-title">{title}</div>
      <div className="effect-card-value">{value}</div>
      <div className="effect-card-sub muted">{sub}</div>
      {extra && <div className="effect-card-sub muted">{extra}</div>}
      <div className="effect-card-base muted">
        {base ? E().baselineValue(base.text) : E().noBaseline}
        {c && <span className="effect-card-delta"> · {c}</span>}
      </div>
    </div>
  );
}

export function Cards({ o }: { o: MetricsOverview }) {
  const b = o.butler;
  const base = o.baseline;
  const comments = b.commentsHuman === null ? null : b.commentsHuman + (b.commentsCopilot ?? 0);
  const baseComments = base && base.commentsHuman !== null ? base.commentsHuman + (base.commentsCopilot ?? 0) : null;
  return (
    <div className="effect-cards">
      <Card
        testId="effect-card-cycle" title={E().cardCycle} value={fmtDuration(b.cycleOpenMs)} sub={E().cardCycleSub}
        extra={b.cycleTicketMs === null ? null : E().cardCycleTicket(fmtDuration(b.cycleTicketMs))}
        mine={b.cycleOpenMs} base={base && { value: base.cycleOpenMs, text: fmtDuration(base.cycleOpenMs) }}
      />
      <Card
        testId="effect-card-comments" title={E().cardComments} value={fmtNumber(comments)}
        sub={E().cardCommentsSub(fmtNumber(b.commentsHuman), fmtNumber(b.commentsCopilot), fmtNumber(b.commentsAvoidable))}
        mine={comments} base={base && { value: baseComments, text: fmtNumber(baseComments) }}
      />
      <Card
        testId="effect-card-interventions" title={E().cardInterventions} value={fmtNumber(b.interventions)}
        sub={E().cardInterventionsSub(fmtDuration(b.waitHumanMs))} mine={b.interventions} base={null}
      />
      <Card
        testId="effect-card-cost" title={E().cardCost} value={fmtTokens(b.costWeighted)} sub={E().cardCostSub}
        extra={b.costUsd === null || b.costUsd <= 0 ? null : E().costUsd(fmtUsd(b.costUsd), b.costUsdPartial)}
        mine={b.costWeighted} base={null}
      />
    </div>
  );
}

const CHART_W = 260;
const CHART_H = 96;
const CHART_PAD = 8;

/** 一个小图：一条线（单一序列，标题就是名字，不要图例）；悬停一个点显示数值。 */
function TrendChart<P extends Pick<TrendPoint, "start" | "prs">>({ title, points, value, format, readout }: {
  title: string; points: P[]; value: (p: P) => number | null; format: (v: number | null) => string;
  /** 悬停读数的写法（默认是按天的趋势）。 */
  readout?: (day: string, v: string, prs: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map(value);
  const g = lineGeometry(values, CHART_W, CHART_H, CHART_PAD);
  const last = g.points.at(-1);
  const shown = hover ?? last?.i ?? null;
  const step = points.length > 1 ? (CHART_W - 2 * CHART_PAD) / (points.length - 1) : CHART_W;
  return (
    <figure className="effect-trend">
      <figcaption>
        <span>{title}</span>
        <span className="muted effect-trend-readout">
          {shown === null ? DASH : (readout ?? E().trendPoint)(fmtDay(points[shown].start), format(values[shown]), points[shown].prs)}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
        <line className="effect-axis" x1={CHART_PAD} x2={CHART_W - CHART_PAD} y1={CHART_H - CHART_PAD} y2={CHART_H - CHART_PAD} />
        {hover !== null && <line className="effect-crosshair" x1={CHART_PAD + hover * step} x2={CHART_PAD + hover * step} y1={CHART_PAD} y2={CHART_H - CHART_PAD} />}
        <path className="effect-line" d={g.path} />
        {g.points.map((p) => <circle key={p.i} className={p.i === shown ? "effect-dot on" : "effect-dot"} cx={p.x} cy={p.y} r={p.i === shown ? 4 : 2.5} />)}
        {points.map((_, i) => (
          <rect key={i} className="effect-hit" x={CHART_PAD + i * step - step / 2} y={0} width={step} height={CHART_H} onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
    </figure>
  );
}

function Trend({ o }: { o: MetricsOverview }) {
  const [by, setBy] = useState<"week" | "month">("week");
  const points = o.trend[by];
  return (
    <section className="effect-section" data-testid="effect-trend">
      <div className="effect-section-head">
        <h3>{E().trend}</h3>
        <div className="segmented" role="group">
          <button className={by === "week" ? "active" : ""} aria-pressed={by === "week"} onClick={() => setBy("week")}>{E().byWeek}</button>
          <button className={by === "month" ? "active" : ""} aria-pressed={by === "month"} onClick={() => setBy("month")}>{E().byMonth}</button>
        </div>
      </div>
      <div className="effect-trends">
        <TrendChart title={E().trendCycle} points={points} value={(p) => p.cycleOpenMs} format={fmtDuration} />
        <TrendChart title={E().trendComments} points={points} value={(p) => p.comments} format={(v) => fmtNumber(v)} />
        <TrendChart title={E().trendInterventions} points={points} value={(p) => p.interventions} format={(v) => fmtNumber(v)} />
        <TrendChart title={E().trendCost} points={points} value={(p) => p.costWeighted} format={fmtTokens} />
      </div>
      <details className="effect-table-toggle">
        <summary>{E().table}</summary>
        <table className="ticket-table effect-table">
          <thead>
            <tr><th>{E().colPeriod}</th><th>{E().colPrs}</th><th>{E().colCycle}</th><th>{E().colComments}</th><th>{E().colInterventions}</th><th>{E().colCost}</th></tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.start}>
                <td>{fmtDay(p.start)}</td><td>{p.prs}</td><td>{fmtDuration(p.cycleOpenMs)}</td>
                <td>{fmtNumber(p.comments)}</td><td>{fmtNumber(p.interventions)}</td><td>{fmtTokens(p.costWeighted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

/** 横条列表：一种颜色（大小），名字和数字都用正文颜色写在条旁边。 */
function Bars({ rows, testId }: { rows: { key: string; label: string; value: number; text: string }[]; testId?: string }) {
  if (rows.length === 0) return <p className="muted">{E().none}</p>;
  const w = barWidths(rows.map((r) => r.value));
  return (
    <ul className="effect-bars" data-testid={testId}>
      {rows.map((r, i) => (
        <li key={r.key} title={`${r.label} · ${r.text}`}>
          <span className="effect-bar-label">{r.label}</span>
          <span className="effect-bar-track"><span className="effect-bar" style={{ width: `${w[i]}%` }} /></span>
          <span className="effect-bar-value">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Interrupts({ o }: { o: MetricsOverview }) {
  const rows = o.interrupts.map((x) => ({
    key: x.category, label: E().interruptNames[x.category], value: x.count, text: E().interruptText(x.count, fmtDuration(x.waitMs)),
  }));
  return (
    <section className="effect-section" data-testid="effect-interrupts">
      <h3>{E().interrupts}</h3>
      <p className="muted">{E().interruptsIntro}</p>
      <Bars rows={rows} />
      <p className="muted">{E().autoResolved(o.autoResolved)} · {E().waitTotals(fmtDuration(o.waitHumanMs), fmtDuration(o.waitIdleMs))}</p>
    </section>
  );
}

/** 打断减少（ws-j 设计 6）：第一个功能生效前后同样多天的对比。 */
function InterruptCompareTable({ o }: { o: MetricsOverview }) {
  const c = o.interruptCompare;
  const before = c?.before ?? null;
  const after = c?.after ?? null;
  if (!c || !before || !after) {
    return (
      <section className="effect-section" data-testid="effect-compare">
        <h3>{E().compare}</h3>
        <p className="muted">{c ? E().compareStarting(shortTime(c.since)) : E().compareNotYet}</p>
      </section>
    );
  }
  const row = (label: string, f: (x: CompareSide) => string, testId?: string) => (
    <tr key={label} data-testid={testId}>
      <td>{label}</td>
      <td>{f(before)}</td>
      <td>{f(after)}</td>
    </tr>
  );
  return (
    <section className="effect-section" data-testid="effect-compare">
      <h3>{E().compare}</h3>
      <p className="muted">{E().compareIntro(shortTime(c.since), after.days)}</p>
      <table className="ticket-table effect-table">
        <thead>
          <tr>
            <th />
            <th>{E().compareBefore(fmtDay(before.from), fmtDay(before.to))}</th>
            <th>{E().compareAfter(fmtDay(after.from), fmtDay(after.to))}</th>
          </tr>
        </thead>
        <tbody>
          {row(E().colPrs, (x) => String(x.prs))}
          {row(E().compareInterventions, (x) => fmtNumber(x.interventions), "effect-compare-interventions")}
          {row(E().compareWait, (x) => fmtDuration(x.waitHumanMs))}
          {INTERRUPT_CATEGORIES.map((k) => row(E().comparePerDay(E().interruptNames[k]), (x) => fmtNumber(x.interruptsPerDay[k])))}
          {row(E().compareAuto, (x) => String(x.autoResolved))}
          {row(E().compareStuckFixes, (x) => String(x.stuckFixes))}
        </tbody>
      </table>
    </section>
  );
}

function Interventions({ items }: { items: KeyCount[] }) {
  const rows = interventionRows(items);
  return (
    <section className="effect-section" data-testid="effect-interventions">
      <h3>{E().interventions}</h3>
      {rows.length === 0 ? <p className="muted">{E().none}</p> : (
        <ul className="effect-list">
          {rows.map((r) => (
            <li key={r.key}>
              <span>{interventionName(r.key)}</span> <strong>{r.n}</strong>
              {r.subs.length > 0 && (
                <ul className="effect-sublist muted">
                  {r.subs.map((x) => <li key={x.key}>{interventionName(x.key)} <strong>{x.n}</strong></li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupRow({ label, hint, prs, cycle, comments, interventions, cost }: {
  label: string; hint?: string; prs: number; cycle: number | null; comments: number | null; interventions: number | null; cost: number | null;
}) {
  return (
    <tr>
      <td title={hint}>{label}</td><td>{prs}</td><td>{fmtDuration(cycle)}</td><td>{fmtNumber(comments)}</td><td>{fmtNumber(interventions)}</td><td>{fmtTokens(cost)}</td>
    </tr>
  );
}

function GroupTable({ children }: { children: React.ReactNode }) {
  return (
    <table className="ticket-table effect-table">
      <thead>
        <tr><th>{E().colGroup}</th><th>{E().colPrs}</th><th>{E().colCycle}</th><th>{E().colComments}</th><th>{E().colInterventions}</th><th>{E().colCost}</th></tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Groups({ o }: { o: MetricsOverview }) {
  const commentsOf = (a: MetricsOverview["butler"]) => (a.commentsHuman === null ? null : a.commentsHuman + (a.commentsCopilot ?? 0));
  const kinds: GroupMetrics["kind"][] = ["repo", "product", "risk"];
  return (
    <section className="effect-section" data-testid="effect-groups">
      <h3>{E().groups}</h3>
      <GroupTable>
        <GroupRow label={E().butlerRow} prs={o.butler.prs} cycle={o.butler.cycleOpenMs} comments={commentsOf(o.butler)} interventions={o.butler.interventions} cost={o.butler.costWeighted} />
        <GroupRow label={E().otherRow} hint={E().otherRowHint} prs={o.other.prs} cycle={o.other.cycleOpenMs} comments={commentsOf(o.other)} interventions={o.other.interventions} cost={o.other.costWeighted} />
      </GroupTable>
      {kinds.map((k) => {
        const rows = o.groups.filter((g) => g.kind === k);
        if (rows.length === 0) return null;
        return (
          <div key={k} className="effect-group">
            <h4>{E().groupKinds[k]}</h4>
            <GroupTable>
              {rows.map((g) => (
                <GroupRow key={g.key} label={groupName(g.key)} prs={g.prs} cycle={g.cycleOpenMs} comments={g.comments} interventions={g.interventions} cost={g.costWeighted} />
              ))}
            </GroupTable>
          </div>
        );
      })}
    </section>
  );
}

function Spend({ o }: { o: MetricsOverview }) {
  const rows = (xs: KeyCount[]) => xs.map((x) => ({ key: x.key, label: spendName(x.key), value: x.total, text: fmtTokens(x.total) }));
  return (
    <section className="effect-section" data-testid="effect-spend">
      <h3>{E().spend}</h3>
      <p className="muted">{E().spendIntro}</p>
      <div className="effect-columns">
        <div><h4>{E().byModel}</h4><Bars rows={rows(o.spend.byModel)} /></div>
        <div><h4>{E().byTask}</h4><Bars rows={rows(o.spend.byTask)} /></div>
      </div>
    </section>
  );
}

function Rework({ o }: { o: MetricsOverview }) {
  const r = o.rework;
  const per = (n: number) => (r.prs > 0 ? E().perPr(fmtNumber(n / r.prs, 2)) : DASH);
  const items: [string, number][] = [[E().ciFailures, r.ciFailures], [E().reopens, r.reopens], [E().reverts, r.reverts]];
  return (
    <section className="effect-section" data-testid="effect-rework">
      <h3>{E().rework}</h3>
      <ul className="effect-list">
        {items.map(([label, n]) => <li key={label}><span>{label}</span> <strong>{n}</strong> <span className="muted">{per(n)}</span></li>)}
      </ul>
    </section>
  );
}

function OtherEvents({ items }: { items: KeyCount[] }) {
  if (items.length === 0) return null;
  return (
    <section className="effect-section" data-testid="effect-other-events">
      <h3>{E().otherEvents}</h3>
      <ul className="effect-list">
        {items.map((x) => <li key={x.key}><code>{x.key}</code> <strong>{x.n}</strong></li>)}
      </ul>
    </section>
  );
}

/** 评论与 CI（工作流 I）：评论闭环处理了多少、flaky 几次、浪费了多久；数据来自 loop:effect，跟着页面的时间范围。 */
export function LoopEffectSection({ e }: { e: LoopEffect }) {
  const c = e.comments;
  const ci = e.ci;
  const top = ci.topFlaky.map((f) => ({
    key: `${f.repoSlug}\u0000${f.kind}\u0000${f.name}`, label: `${f.name}${f.listed ? E().loopListed : ""}`, value: f.count, text: E().loopFlakyText(f.count, fmtDuration(f.wastedMs)),
  }));
  return (
    <section className="effect-section" data-testid="effect-loop">
      <h3>{E().loop}</h3>
      <p className="muted">{E().loopIntro}</p>
      <div className="effect-cards">
        <Card
          testId="effect-loop-handled" title={E().loopHandled} value={fmtNumber(c.autoHandled)} sub={E().loopHandledSub(c.byWho.copilot, c.byWho.human)}
          extra={c.waitingForYou > 0 ? `${E().loopReplied(c.replied, c.resolved)} · ${E().loopWaiting(c.waitingForYou)}` : E().loopReplied(c.replied, c.resolved)}
          mine={c.autoHandled} base={null}
        />
        <Card
          testId="effect-loop-flaky" title={E().loopFlaky} value={fmtNumber(ci.passedAfterRerun)} sub={E().loopFlakySub(ci.reruns)}
          extra={E().loopTriaged(ci.triaged, ci.byCategory.env, ci.byCategory.flaky, ci.byCategory.code)} mine={ci.passedAfterRerun} base={null}
        />
        <Card
          testId="effect-loop-wasted" title={E().loopWasted} value={fmtDuration(ci.flakyWastedMs)} sub={E().loopWastedSub(ci.possiblyFlaky)}
          mine={ci.flakyWastedMs} base={null}
        />
      </div>
      {top.length > 0 && (
        <>
          <h4>{E().loopTopFlaky}</h4>
          <Bars rows={top} testId="effect-loop-top-flaky" />
        </>
      )}
    </section>
  );
}

const RV = () => S.rv;

function ReviewGroupRow({ label, g }: { label: string; g: ReviewGroupStats }) {
  const ok = enoughSample(g);
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{fmtNumber(g.prs, 0)}</td>
      {ok ? (
        <>
          <td>{fmtNumber(g.humanComments)}</td>
          <td>{fmtNumber(g.rounds)}</td>
          <td>{fmtDuration(g.firstReviewMs)}</td>
          <td>{fmtDuration(g.submitToMergeMs)}</td>
        </>
      ) : <td colSpan={4} className="muted">{RV().effSmall}</td>}
    </tr>
  );
}

/** Review 效果（工作流 G）：每 PR 的可避免评论按周、Butler 和其他 PR / 带不带简报的对比、规矩上线前后、评论落点。 */
export function ReviewEffectSection({ v }: { v: ReviewEffectView }) {
  const points = v.weeks.map((w) => ({ start: dayString(w.weekStart), prs: w.prs, perPr: w.perPr }));
  const cols = RV().effCols;
  return (
    <section className="effect-section" data-testid="effect-review">
      <h3>{RV().effTitle}</h3>
      <p className="muted">{RV().effIntro}</p>
      <div className="effect-trends">
        <TrendChart title={RV().effWeeks} points={points} value={(p) => p.perPr} format={(x) => fmtNumber(x)} readout={RV().effWeekPoint} />
      </div>
      <h4>{RV().effGroups}</h4>
      <table className="ticket-table" data-testid="effect-review-groups">
        <thead>
          <tr><th>{cols.group}</th><th>{cols.prs}</th><th>{cols.comments}</th><th>{cols.rounds}</th><th>{cols.firstReview}</th><th>{cols.toMerge}</th></tr>
        </thead>
        <tbody>
          <ReviewGroupRow label={RV().effGroup.butler} g={v.butler} />
          <ReviewGroupRow label={RV().effGroup.others} g={v.others} />
          <ReviewGroupRow label={RV().effGroup.withBrief} g={v.withBrief} />
          <ReviewGroupRow label={RV().effGroup.withoutBrief} g={v.withoutBrief} />
        </tbody>
      </table>
      <h4>{RV().effLessons}</h4>
      {v.lessons.length === 0 ? <p className="muted">{RV().effLessonsNone}</p> : (
        <table className="ticket-table" data-testid="effect-review-lessons">
          <thead>
            <tr><th>{RV().effLessonCols.text}</th><th>{RV().effLessonCols.confirmed}</th><th>{RV().effLessonCols.before}</th><th>{RV().effLessonCols.after}</th></tr>
          </thead>
          <tbody>
            {v.lessons.map((l) => (
              <tr key={l.lessonId}>
                <td>{l.text}</td>
                <td>{new Date(l.confirmedAt).toLocaleDateString()}</td>
                <td>{fmtNumber(l.before.perPr)} <span className="muted">({l.before.prs})</span></td>
                <td>{fmtNumber(l.after.perPr)} <span className="muted">({l.after.prs})</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" data-testid="effect-review-landing">{RV().effLanding(v.landing.confirmedBefore, v.landing.notYet, v.landing.unattributed)}</p>
    </section>
  );
}

/** 概况 tab：基线说明；一个 Butler 的 PR 都没有时的空状态。 */
export function EffectOverview({ o }: { o: MetricsOverview }) {
  return (
    <>
      <p className="muted effect-baseline-note">
        {o.baseline ? E().baselineNote(o.baseline.prs, new Date(o.baseline.cutoff).toLocaleDateString()) : E().baselineMissing}
      </p>
      {o.butler.prs === 0 && <p className="muted">{E().empty}</p>}
    </>
  );
}

/** 趋势 tab。 */
export function EffectTrendTab({ o }: { o: MetricsOverview }) {
  return (
    <>
      <Interrupts o={o} />
      <InterruptCompareTable o={o} />
      <Trend o={o} />
    </>
  );
}

/** 花费明细 tab。 */
export function EffectSpendTab({ o }: { o: MetricsOverview }) {
  return (
    <>
      <Spend o={o} />
      <Groups o={o} />
    </>
  );
}

/** 返工 tab。 */
export function EffectReworkTab({ o }: { o: MetricsOverview }) {
  return (
    <>
      <Rework o={o} />
      <Interventions items={o.interventions} />
      <OtherEvents items={o.otherEvents} />
    </>
  );
}

/** 自动化的效果 tab：自动改、review、接单三块，谁的数据到了就先显示谁；都还没到就是「加载中」。 */
export function EffectAutomationTab({ loop, review, intake }: { loop: LoopEffect | null; review: ReviewEffectView | null; intake: IntakeEffect | null }) {
  if (!loop && !review && !intake) return <p className="empty">{S.loading}</p>;
  return (
    <>
      {loop && <LoopEffectSection e={loop} />}
      {review && <ReviewEffectSection v={review} />}
      {intake && <IntakeEffectSection e={intake} />}
    </>
  );
}

/** 「效果」页（ws-h）：和总控 metrics_overview 同一份数据，stateChanged 时重取。四张卡在上面，其余按 tab 分开。 */
export function EffectPage() {
  const [days, setDays] = useState<number>(30);
  const o = useStateRefetch(`metrics:${days}`, () => api.metrics(days));
  const loop = useStateRefetch(`loop-effect:${days}`, () => api.loopEffect(days));
  const review = useStateRefetch(`review-effect:${days}`, () => api.reviewEffect(days));
  const intake = useStateRefetch(`intake-effect:${days}`, () => api.intakeEffect(days));
  const loading = <p className="empty">{S.loading}</p>;
  const content: Record<EffectTabId, ReactNode> = {
    overview: o ? <EffectOverview o={o} /> : loading,
    trend: o ? <EffectTrendTab o={o} /> : loading,
    spend: o ? <EffectSpendTab o={o} /> : loading,
    rework: o ? <EffectReworkTab o={o} /> : loading,
    automation: <EffectAutomationTab loop={loop} review={review} intake={intake} />,
  };
  const tabs: PageTab[] = EFFECT_TABS.map((id) => ({ id, label: S.lay.effectTabs[id], content: content[id] }));
  return (
    <div className="page effect-page" data-testid="effect-page">
      <h2>{E().title}</h2>
      <p className="muted">{S.lay.effectLede(days)}</p>
      <div className="effect-toolbar">
        <div className="segmented" role="group" aria-label={E().range}>
          {DAY_CHOICES.map((d) => (
            <button key={d} className={days === d ? "active" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{E().days(d)}</button>
          ))}
        </div>
        {o && (
          <span className="muted">
            {E().prs(o.butler.prs)} · {o.rolledUpAt === null ? E().notRolledUp : E().rolledUp(shortTime(o.rolledUpAt))}
          </span>
        )}
      </div>
      {o && <Cards o={o} />}
      <PageTabs page="effect" tabs={tabs} defaultTab="overview" />
    </div>
  );
}
