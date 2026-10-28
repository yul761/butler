import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Brief, BriefItem, BriefKind, BriefView } from "../../../shared/brief";
import type { FeatureView, OpenSessionRequest, TicketView } from "../../../shared/types";
import { api } from "../api";
import { groupItems, itemActions, itemTitle, narrativeLines, narrativeNote, openRequest, type ItemAction } from "../brief-view";
import { reportError } from "../errors";
import { featureHeadline, featureOfTicket, groupByFeature } from "../feature-summary-view";
import { jobResultMessage } from "../job-view";
import { setWizardSkipped, wizardSkipped } from "../local-prefs";
import { S } from "../strings";

interface Props {
  /** 从系统通知进来时要显示的标签。 */
  initialKind?: BriefKind;
  tickets: TicketView[];
  /** 未归档的 feature：简报里按 feature 分组、加小标签（只是展示，旧简报照常显示）。 */
  features: FeatureView[];
  onOpenTicket: (key: string, req?: OpenSessionRequest) => void;
  onUnclaimed: () => void;
  /** 跳过了向导的人点“继续设置”：重新打开向导。 */
  onResumeSetup: () => void;
}

const MARK = { done: "done", snooze: "snoozed", ignore: "ignored" } as const;

export function BriefPage({ initialKind, tickets, features, onOpenTicket, onUnclaimed, onResumeSetup }: Props) {
  const [skipped, setSkipped] = useState(wizardSkipped);
  const [kind, setKind] = useState<BriefKind>(initialKind ?? "morning");
  /** 记下数据属于哪个标签：切换标签时不会先闪出另一个标签的旧内容。 */
  const [loaded, setLoaded] = useState<{ kind: BriefKind; view: BriefView } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 只采用最后一次请求的结果：慢的旧请求不会盖掉新的。 */
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const view = await api.briefLatest(kind);
      if (mine === seq.current) setLoaded({ kind, view });
    } catch (e) {
      if (mine === seq.current) reportError(e);
    }
  }, [kind]);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  async function act(item: BriefItem, action: ItemAction) {
    if (action === "claim") {
      onUnclaimed();
      return;
    }
    if (action === "open") {
      if (item.ticketKey) onOpenTicket(item.ticketKey, openRequest(item, tickets.find((t) => t.key === item.ticketKey)) ?? undefined);
      return;
    }
    try {
      if (item.followupId) await api.setFollowupStatus(item.followupId, MARK[action]);
      else await api.markBriefItem(item.key, MARK[action]);
    } catch (e) {
      reportError(e);
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      const job = await api.regenerateBrief();
      if (job?.lastStatus === "failed") reportError(new Error(jobResultMessage(job)));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  const view = loaded?.kind === kind ? loaded.view : null;
  const brief = view?.brief ?? null;
  return (
    <div className="page brief">
      {skipped && (
        <div className="notice">
          <p>{S.setupSkipped}</p>
          <div className="actions">
            <button className="primary" onClick={onResumeSetup}>{S.resumeSetup}</button>
            <button onClick={() => { setWizardSkipped(false); setSkipped(false); }}>{S.dismissForever}</button>
          </div>
        </div>
      )}
      <header className="brief-header">
        <div className="tabs">
          <button className={kind === "morning" ? "tab active" : "tab"} onClick={() => setKind("morning")}>{S.morningBrief}</button>
          <button className={kind === "evening" ? "tab active" : "tab"} onClick={() => setKind("evening")}>{S.eveningBrief}</button>
        </div>
        {brief && <span className="muted">{brief.date}</span>}
        {view?.refreshing && <span className="muted">{S.briefRefreshing}</span>}
        {kind === "morning" && (
          <button disabled={busy || view?.refreshing === true} onClick={() => void regenerate()}>{S.regenerate}</button>
        )}
      </header>
      {!view ? (
        <p className="muted">{S.loading}</p>
      ) : !brief ? (
        <p className="empty">{kind === "morning" ? S.noBrief : S.noEvening}</p>
      ) : kind === "morning" ? (
        <MorningBody brief={brief} narrating={view.narrating} tickets={tickets} features={features} onAct={(i, a) => void act(i, a)} onOpenTicket={(key) => onOpenTicket(key)} />
      ) : (
        <EveningBody brief={brief} tickets={tickets} features={features} onOpenTicket={(key) => onOpenTicket(key)} />
      )}
    </div>
  );
}

function Notices({ brief }: { brief: Brief }) {
  const { degraded, trackerUnavailable } = brief.notices;
  return (
    <>
      {degraded.length > 0 && <p className="notice-line">{S.noticeDegraded(degraded)}</p>}
      {trackerUnavailable.length > 0 && <p className="notice-line">{S.noticeTracker(trackerUnavailable)}</p>}
    </>
  );
}

function DoneList({ items }: { items: string[] }) {
  return (
    <ul className="day-list">
      {items.map((d, n) => (
        <li key={n}>{d}</li>
      ))}
    </ul>
  );
}

/** 属于 feature 的 ticket 归到 feature 标题下面，标题旁边是最新汇总的第一句话；其他 ticket 照旧平铺。 */
function FeatureGroups<T extends { ticketKey: string }>({ entries, tickets, features, render }: { entries: T[]; tickets: TicketView[]; features: FeatureView[]; render: (e: T) => ReactNode }) {
  return (
    <>
      {groupByFeature(entries, tickets, features).map((g) => {
        if (!g.feature) return <Fragment key="none">{g.entries.map(render)}</Fragment>;
        const headline = featureHeadline(g.feature);
        return (
          <div key={g.feature.id} className="brief-feature-group">
            <div className="brief-feature-group-head">
              <strong>{g.feature.name}</strong>
              {headline && <span className="muted">{headline}</span>}
            </div>
            <div className="brief-feature-group-body">{g.entries.map(render)}</div>
          </div>
        );
      })}
    </>
  );
}

interface BodyProps {
  brief: Brief;
  tickets: TicketView[];
  features: FeatureView[];
  onOpenTicket: (key: string) => void;
}

function MorningBody({ brief, narrating, tickets, features, onAct, onOpenTicket }: BodyProps & { narrating: boolean; onAct: (i: BriefItem, a: ItemAction) => void }) {
  const groups = groupItems(brief.items);
  const lines = narrativeLines(brief);
  const note = narrativeNote(brief, narrating);
  return (
    <>
      {(lines.length > 0 || note) && (
        <section className="narrative">
          <h3>{S.todayFocus}</h3>
          {lines.length > 0 && (
            <ul className="day-list">
              {lines.map((l, n) => (
                <li key={n}>{l}</li>
              ))}
            </ul>
          )}
          {note && <p className="muted">{note}</p>}
        </section>
      )}
      <Notices brief={brief} />
      {groups.length === 0 && <p className="empty">{S.briefEmpty}</p>}
      {groups.map((g) => (
        <section key={g.section} className="brief-section">
          <h3>{S.briefSections[g.section]}</h3>
          {g.items.map((i) => (
            <div key={i.key} className="brief-item">
              {i.ticketKey && <FeatureTag ticketKey={i.ticketKey} tickets={tickets} features={features} />}
              {i.ticketKey && <button className="chip" onClick={() => onOpenTicket(i.ticketKey!)}>{i.ticketKey}</button>}
              <span className="text">{itemTitle(i)}</span>
              <span className="actions">
                {itemActions(i).map((a) => (
                  <button key={a} className={a === "open" || a === "claim" ? "primary" : ""} onClick={() => onAct(i, a)}>
                    {S.itemActions[a]}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
      {brief.previousDay && (
        <section className="brief-section">
          <h3>{S.previousDay(brief.previousDay.date)}</h3>
          {brief.previousDay.entries.length === 0 && <p className="muted">{S.previousDayEmpty}</p>}
          <FeatureGroups
            entries={brief.previousDay.entries}
            tickets={tickets}
            features={features}
            render={(e) => (
              <div key={e.ticketKey}>
                <button className="chip" onClick={() => onOpenTicket(e.ticketKey)}>{e.ticketKey}</button>
                <DoneList items={e.done} />
              </div>
            )}
          />
        </section>
      )}
    </>
  );
}

function EveningBody({ brief, tickets, features, onOpenTicket }: BodyProps) {
  return (
    <>
      <Notices brief={brief} />
      {brief.evening.length === 0 && <p className="empty">{S.noEvening}</p>}
      <FeatureGroups
        entries={brief.evening}
        tickets={tickets}
        features={features}
        render={(e) => (
          <div key={e.ticketKey} className="evening-entry">
            <button className="chip" onClick={() => onOpenTicket(e.ticketKey)}>{e.ticketKey}</button>
            {e.degraded && <span className="error"> {S.eveningDegraded}</span>}
            {e.done.length > 0 ? <DoneList items={e.done} /> : <p className="muted">{S.eveningNothingDone}</p>}
            {e.blockers.length > 0 && <p>{S.eveningBlockers}{e.blockers.join(S.listSep)}</p>}
            {e.next && <p>{S.eveningNext}{e.next}</p>}
          </div>
        )}
      />
    </>
  );
}

/** 早间条目前的 feature 名小标签；单独的 ticket 没有。 */
function FeatureTag({ ticketKey, tickets, features }: { ticketKey: string; tickets: TicketView[]; features: FeatureView[] }) {
  const f = featureOfTicket(ticketKey, tickets, features);
  return f ? <span className="feature-tag">{f.name}</span> : null;
}
