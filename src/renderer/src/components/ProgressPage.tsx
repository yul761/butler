import { useState } from "react";
import { PROGRESS_BUCKETS, type ProgressFeature, type ProgressPr, type ProgressStuck, type ProgressView } from "../../../shared/progress";
import { api } from "../api";
import { reportError } from "../errors";
import type { ReviewQueueItem } from "../../../shared/prereview";
import { flattenStack, prRef, segmentWidths, shortTime, sinceText, waitingText } from "../progress-ui";
import { queueFor, queueIndex, riskPill } from "../review-view";
import { S } from "../strings";
import { FeaturePrStages } from "./PrStages";
import { ManagedStacks } from "./StacksPanel";
import { IntakeQueue } from "./IntakeQueue";
import { useStateRefetch } from "./useStateRefetch";

const openPr = (url: string): void => void api.prOpen(url).catch(reportError);

/** 进度页和 feature / epic 的 PR 进度 tab 共用同一份数据（buildProgress）：stateChanged 时重取。 */
export function useProgress(filter: { epicId?: number | null; featureId?: number | null }): ProgressView | null {
  const epicId = filter.epicId ?? null;
  const featureId = filter.featureId ?? null;
  return useStateRefetch(`progress:${epicId ?? ""}:${featureId ?? ""}`, () => api.progress({ epicId, featureId }));
}

function PrLink({ pr }: { pr: ProgressPr }) {
  return (
    <button className="pr-link link" title={pr.url} onClick={() => openPr(pr.url)}>
      {prRef(pr)}
    </button>
  );
}

function TicketLink({ ticketKey, onOpenTicket }: { ticketKey: string; onOpenTicket: (key: string) => void }) {
  return <button className="chip" onClick={() => onOpenTicket(ticketKey)}>{ticketKey}</button>;
}

/** 「现在卡在谁手上」：一行一个开着的 PR（或标成阻塞、没有 PR 的 ticket），卡得最久的在前。 */
export function StuckList({ stuck, now, onOpenTicket }: { stuck: ProgressStuck[]; now: number; onOpenTicket: (key: string) => void }) {
  if (stuck.length === 0) return <p className="muted">{S.progress.stuckNone}</p>;
  return (
    <table className="ticket-table progress-stuck" data-testid="progress-stuck">
      <thead>
        <tr>
          <th>{S.progress.colTicket}</th>
          <th>{S.progress.colPr}</th>
          <th>{S.progress.colWho}</th>
          <th>{S.progress.colReason}</th>
          <th>{S.progress.colSince}</th>
        </tr>
      </thead>
      <tbody>
        {stuck.map((s) => (
          <tr key={`${s.ticketKey}:${s.pr?.url ?? ""}`} className={`waiting-${s.waitingOn.who}`}>
            <td><TicketLink ticketKey={s.ticketKey} onOpenTicket={onOpenTicket} /> <span className="muted">{s.ticketTitle ?? ""}</span></td>
            <td>{s.pr ? <><PrLink pr={s.pr} />{s.pr.isDraft && <span className="muted"> · {S.progress.draft}</span>}</> : "—"}</td>
            <td className="waiting-who">{waitingText(s.waitingOn)}</td>
            <td className={`waiting-reason ${s.waitingOn.reason}`}>{S.progress.reasons[s.waitingOn.reason]}</td>
            <td className="muted" title={s.since === null ? undefined : shortTime(s.since)}>{sinceText(s.since, now)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 汇总条：五格的数字和一根分段条，下面可以展开每一格的定义。 */
function SummaryBar({ view }: { view: ProgressView }) {
  const [defs, setDefs] = useState(false);
  const width = segmentWidths(view.counts, PROGRESS_BUCKETS, view.counts.total);
  return (
    <section className="progress-summary" data-testid="progress-summary">
      <div className="progress-counts">
        <strong>{S.progress.total(view.counts.total)}</strong>
        {PROGRESS_BUCKETS.map((b) => (
          <span key={b} className={`progress-count bucket-${b}`} title={S.progress.bucketDefs[b]}>
            <span className="swatch" aria-hidden="true" />
            {S.progress.buckets[b]} <strong>{view.counts[b]}</strong>
          </span>
        ))}
      </div>
      <div className="progress-bar" aria-hidden="true">
        {PROGRESS_BUCKETS.map((b) => <span key={b} className={`progress-seg bucket-${b}`} style={{ width: `${width[b]}%` }} />)}
      </div>
      <button className="section-toggle" aria-expanded={defs} onClick={() => setDefs(!defs)}>
        <span className="twisty" aria-hidden="true">{defs ? "▾" : "▸"}</span>
        {S.progress.definitions}
      </button>
      {defs && (
        <dl className="progress-defs">
          {PROGRESS_BUCKETS.map((b) => (
            <div key={b}>
              <dt>{S.progress.buckets[b]}</dt>
              <dd>{S.progress.bucketDefs[b]}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function Stacks({ view }: { view: ProgressView }) {
  const repos = view.stacks.filter((r) => r.stacks.length > 0);
  return (
    <section className="progress-stacks" data-testid="progress-stacks">
      <h3>{S.progress.stacksHeading}</h3>
      {repos.length === 0 ? (
        <p className="muted">{S.progress.stacksNone}</p>
      ) : (
        repos.map((r) => (
          <div key={r.repo} className="progress-stack-repo">
            <h4>{r.repo}</h4>
            <ul className="progress-stack">
              {flattenStack(r.stacks).map(({ pr, depth }) => (
                <li key={pr.url} style={{ paddingInlineStart: `${depth * 1.25}em` }}>
                  {depth > 0 && <span className="muted" aria-hidden="true">└ </span>}
                  <PrLink pr={pr} /> <span>{pr.title ?? ""}</span>{" "}
                  <span className="muted">{pr.headBranch ?? ""} → {pr.baseBranch ?? ""}</span>
                  {pr.waitingOn && <span className={`waiting-reason ${pr.waitingOn.reason}`}> · {S.progress.reasons[pr.waitingOn.reason]}</span>}
                </li>
              ))}
            </ul>
            {r.single.length > 0 && (
              <details className="progress-singles">
                <summary className="muted">{S.progress.stackSingles(r.single.length)}</summary>
                <ul className="progress-stack">
                  {r.single.map((pr) => (
                    <li key={pr.url}>
                      <PrLink pr={pr} /> <span>{pr.title ?? ""}</span> <span className="muted">{pr.headBranch ?? ""} → {pr.baseBranch ?? ""}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))
      )}
    </section>
  );
}

/** 一个 PR 的风险和就绪徽标（工作流 G）；没评估过的不显示。 */
function ReviewBadges({ item }: { item: ReviewQueueItem | undefined }) {
  if (!item) return <>—</>;
  return (
    <span data-testid="progress-review-badges">
      {item.risk && <span className={`pill ${riskPill(item.risk)}`}>{S.rv.riskBadge(S.rv.level[item.risk])}</span>}
      {item.ready !== null && <span className={item.ready ? "pill approved" : "pill pending"}>{item.ready ? S.rv.ready : S.rv.notReady}</span>}
    </span>
  );
}

/** 待 review（工作流 G，设计 §10）：未就绪在前 → 风险高在前 → 等得久在前。 */
function ReviewQueueList({ items, onOpenTicket }: { items: ReviewQueueItem[]; onOpenTicket: (key: string) => void }) {
  return (
    <section className="progress-review-queue" data-testid="progress-review-queue">
      <h3>{S.rv.queueTitle}</h3>
      <p className="muted">{S.rv.queueIntro}</p>
      {items.length === 0 ? <p className="muted">{S.rv.queueNone}</p> : (
        <table className="ticket-table">
          <tbody>
            {items.map((i) => (
              <tr key={i.prId} data-testid={`review-queue-${i.number}`}>
                <td><button className="pr-link link" title={i.url} onClick={() => openPr(i.url)}>{`${i.repoSlug}#${i.number}`}</button></td>
                <td>{i.title ?? ""}</td>
                <td><TicketLink ticketKey={i.ticketKey} onOpenTicket={onOpenTicket} /></td>
                <td><ReviewBadges item={i} /></td>
                <td className="muted">{i.missing.length > 0 ? S.rv.missing(i.missing.map((m) => S.rv.cond[m.key]).join(", ")) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PrTable({ view, onOpenTicket, queue }: { view: ProgressView; onOpenTicket: (key: string) => void; queue: Map<number, ReviewQueueItem> }) {
  const [by, setBy] = useState<"label" | "prefix">("label");
  const groups = by === "label" ? view.groups.byLabel : view.groups.byPrefix;
  return (
    <section className="progress-prs" data-testid="progress-prs">
      <div className="progress-section-head">
        <h3>{S.progress.tableHeading}</h3>
        <div className="segmented" role="group">
          <button className={by === "label" ? "active" : ""} aria-pressed={by === "label"} onClick={() => setBy("label")}>{S.progress.byLabel}</button>
          <button className={by === "prefix" ? "active" : ""} aria-pressed={by === "prefix"} onClick={() => setBy("prefix")}>{S.progress.byPrefix}</button>
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="muted">{S.progress.tableNone}</p>
      ) : (
        groups.map((g) => (
          <div key={g.key ?? ""} className="progress-pr-group">
            <h4>{g.key ?? (by === "label" ? S.progress.noLabel : S.progress.noPrefix)} <span className="muted">{g.prs.length}</span></h4>
            <table className="ticket-table">
              <thead>
                <tr>
                  <th>{S.progress.colPr}</th>
                  <th>{S.progress.colTitle}</th>
                  <th>{S.progress.colTicket}</th>
                  <th>{S.progress.colState}</th>
                  <th>{S.progress.colCi}</th>
                  <th>{S.progress.colReview}</th>
                  <th>{S.progress.colWho}</th>
                  <th>{S.rv.colReview}</th>
                </tr>
              </thead>
              <tbody>
                {g.prs.map((p) => (
                  <tr key={p.url}>
                    <td><PrLink pr={p} /></td>
                    <td>{p.title ?? ""}{p.isDraft && <span className="muted"> · {S.progress.draft}</span>}</td>
                    <td><TicketLink ticketKey={p.ticketKey} onOpenTicket={onOpenTicket} /></td>
                    <td>{S.progress.prState[p.state]}</td>
                    <td className={`ci-${p.ci}`}>{p.ci}</td>
                    <td>{p.review ?? "—"}</td>
                    <td>{p.waitingOn ? `${waitingText(p.waitingOn)} · ${S.progress.reasons[p.waitingOn.reason]}` : "—"}</td>
                    <td><ReviewBadges item={queue.get(p.prId)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </section>
  );
}

function FeatureGroupView({ g, onOpenTicket, onOpenFeature }: { g: ProgressFeature; onOpenTicket: (key: string) => void; onOpenFeature?: (id: number) => void }) {
  // 展开成 feature 页那张 PR 进度表；展开了才取数据。
  const [table, setTable] = useState(false);
  return (
    <div className="progress-feature">
      <div className="progress-feature-head">
        {g.id !== null && onOpenFeature ? <button className="chip" onClick={() => onOpenFeature(g.id!)}>{g.name}</button> : <strong>{g.name ?? S.progress.loose}</strong>}
        <span className="muted">
          {PROGRESS_BUCKETS.filter((b) => g.counts[b] > 0).map((b) => `${S.progress.buckets[b]} ${g.counts[b]}`).join(" · ")}
        </span>
        {g.stale && <span className="badge stale" title={S.progress.staleHint}>{S.progress.stale}</span>}
        {g.id !== null && (
          <button className="link" aria-expanded={table} onClick={() => setTable(!table)}>{table ? S.progress.hidePrTable : S.progress.showPrTable}</button>
        )}
      </div>
      {g.id !== null && (
        <p className="progress-feature-line">
          {g.line ?? <span className="muted">{S.progress.noSummary}</span>}
          {g.summaryAt !== null && <span className="muted"> · {S.progress.summaryAt(shortTime(g.summaryAt))}</span>}
          {g.prStatusAt !== null && <span className="muted"> · {S.progress.prStatusAt(shortTime(g.prStatusAt))}</span>}
        </p>
      )}
      <ul className="progress-tickets">
        {g.tickets.map((t) => (
          <li key={t.key}>
            <span className={`bucket-chip bucket-${t.bucket}`}>{S.progress.buckets[t.bucket]}</span>
            <TicketLink ticketKey={t.key} onOpenTicket={onOpenTicket} /> <span>{t.title ?? ""}</span>
            {t.prs > 0 && <span className="muted"> · {S.progress.openPrs(t.openPrs, t.prs)}</span>}
          </li>
        ))}
      </ul>
      {table && g.id !== null && <FeaturePrStages featureId={g.id} onOpenTicket={onOpenTicket} />}
    </div>
  );
}

function Freshness({ view }: { view: ProgressView }) {
  const f = view.freshness;
  const parts = [S.progress.freshness(shortTime(f.generatedAt))];
  if (f.prsCheckedOldest !== null && f.prsCheckedNewest !== null) parts.push(S.progress.freshnessChecked(shortTime(f.prsCheckedOldest), shortTime(f.prsCheckedNewest)));
  if (f.unread > 0) parts.push(S.progress.freshnessUnread(f.unread));
  if (f.readErrors > 0) parts.push(S.progress.freshnessErrors(f.readErrors));
  if (f.summaryOldest !== null) parts.push(S.progress.freshnessSummary(shortTime(f.summaryOldest)));
  return <footer className="progress-freshness muted" data-testid="progress-freshness">{parts.join(" · ")}</footer>;
}

/** 整页的内容（不取数据，便于测试）。 */
export function ProgressBody({ view, onOpenTicket, onOpenFeature, queue = null }: {
  view: ProgressView; onOpenTicket: (key: string) => void; onOpenFeature?: (id: number) => void;
  /** 待 review（工作流 G）；null = 还没取到，不显示这一块。 */
  queue?: ReviewQueueItem[] | null;
}) {
  const prIds = new Set(view.groups.byLabel.flatMap((g) => g.prs.map((p) => p.prId)));
  const shown = queue === null ? null : queueFor(queue, prIds);
  return (
    <>
      <SummaryBar view={view} />
      <section className="progress-stuck-section">
        <h3>{S.progress.stuckHeading}</h3>
        <StuckList stuck={view.stuck} now={view.freshness.generatedAt} onOpenTicket={onOpenTicket} />
      </section>
      <ManagedStacks filter={view.filter} onOpenTicket={onOpenTicket} />
      <Stacks view={view} />
      {shown && <ReviewQueueList items={shown} onOpenTicket={onOpenTicket} />}
      <PrTable view={view} onOpenTicket={onOpenTicket} queue={queueIndex(shown)} />
      <section className="progress-features" data-testid="progress-features">
        <h3>{S.progress.featuresHeading}</h3>
        {view.featureGroups.length === 0 ? (
          <p className="muted">{S.progress.noTickets}</p>
        ) : (
          view.featureGroups.map((g) => <FeatureGroupView key={g.id ?? "loose"} g={g} onOpenTicket={onOpenTicket} onOpenFeature={onOpenFeature} />)
        )}
      </section>
      <Freshness view={view} />
    </>
  );
}

interface Props {
  epicId?: number | null;
  featureId?: number | null;
  onOpenTicket: (key: string) => void;
  onOpenFeature: (id: number) => void;
}

/** 进度页（ws-b）：全局的进度看板，可以按 epic、feature 过滤。 */
export function ProgressPage({ epicId: initialEpic = null, featureId: initialFeature = null, onOpenTicket, onOpenFeature }: Props) {
  const [epicId, setEpicId] = useState<number | null>(initialEpic);
  const [featureId, setFeatureId] = useState<number | null>(initialFeature);
  const view = useProgress({ epicId, featureId });
  const queue = useStateRefetch("review-queue", api.reviewQueue);
  const features = (view?.features ?? []).filter((f) => epicId === null || f.epicId === epicId);
  return (
    <div className="ticket-page progress-page" data-testid="progress-page">
      <header className="ticket-header">
        <h2>{S.progress.title}</h2>
        <label className="progress-filter">
          {S.progress.epic}
          <select
            data-testid="progress-epic"
            value={epicId ?? ""}
            onChange={(e) => {
              const id = e.target.value === "" ? null : Number(e.target.value);
              setEpicId(id);
              // 换了 epic：原来选的 feature 不在里面就清掉。
              if (id !== null && featureId !== null && view?.features.find((f) => f.id === featureId)?.epicId !== id) setFeatureId(null);
            }}
          >
            <option value="">{S.progress.allEpics}</option>
            {(view?.epics ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="progress-filter">
          {S.progress.feature}
          <select data-testid="progress-feature" value={featureId ?? ""} onChange={(e) => setFeatureId(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">{S.progress.allFeatures}</option>
            {features.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      </header>
      <p className="muted">{S.progress.intro}</p>
      <IntakeQueue onOpenTicket={onOpenTicket} />
      {view && <ProgressBody view={view} onOpenTicket={onOpenTicket} onOpenFeature={onOpenFeature} queue={queue} />}
    </div>
  );
}

/**
 * feature / epic 的 PR 进度 tab 顶上的「卡在谁手上」：和进度页同一份数据，只取这个 feature / epic 的。
 * onOpenProgress：去进度页看完整的（带着同样的过滤）。
 */
export function PrStuckBlock({ epicId = null, featureId = null, onOpenTicket, onOpenProgress }: {
  epicId?: number | null;
  featureId?: number | null;
  onOpenTicket: (key: string) => void;
  onOpenProgress?: () => void;
}) {
  const view = useProgress({ epicId, featureId });
  if (view === null) return null;
  return (
    <section className="pr-stuck-block" data-testid="pr-stuck-block">
      <div className="progress-section-head">
        <h3>{S.prStagesStuck}</h3>
        {onOpenProgress && <button className="link" onClick={onOpenProgress}>{S.prStagesOpenProgress}</button>}
      </div>
      <StuckList stuck={view.stuck} now={view.freshness.generatedAt} onOpenTicket={onOpenTicket} />
    </section>
  );
}
