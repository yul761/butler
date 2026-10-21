import { useCallback, useEffect, useState } from "react";
import type { Brief, BriefItem, BriefKind, BriefView } from "../../../shared/brief";
import type { OpenSessionRequest, TicketView } from "../../../shared/types";
import { api } from "../api";
import { groupItems, itemActions, itemTitle, openRequest, type ItemAction } from "../brief-view";
import { reportError } from "../errors";
import { S } from "../strings";

interface Props {
  /** 从系统通知进来时要显示的标签。 */
  initialKind?: BriefKind;
  tickets: TicketView[];
  onOpenTicket: (key: string, req?: OpenSessionRequest) => void;
  onUnclaimed: () => void;
}

const MARK = { done: "done", snooze: "snoozed", ignore: "ignored" } as const;

export function BriefPage({ initialKind, tickets, onOpenTicket, onUnclaimed }: Props) {
  const [kind, setKind] = useState<BriefKind>(initialKind ?? "morning");
  const [view, setView] = useState<BriefView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.briefLatest(kind));
    } catch (e) {
      reportError(e);
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
      await api.regenerateBrief();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  const brief = view?.brief ?? null;
  return (
    <div className="page brief">
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
      {!brief ? (
        <p className="empty">{kind === "morning" ? S.noBrief : S.noEvening}</p>
      ) : kind === "morning" ? (
        <MorningBody brief={brief} onAct={(i, a) => void act(i, a)} onOpenTicket={(key) => onOpenTicket(key)} />
      ) : (
        <EveningBody brief={brief} onOpenTicket={(key) => onOpenTicket(key)} />
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

function MorningBody({ brief, onAct, onOpenTicket }: { brief: Brief; onAct: (i: BriefItem, a: ItemAction) => void; onOpenTicket: (key: string) => void }) {
  const groups = groupItems(brief.items);
  return (
    <>
      {/* 计划 3 的“今日重点”：计划 2 里 narrativeStatus 永远是 off，这一段不会出现。 */}
      {brief.narrativeStatus === "ok" && brief.narrative && (
        <section className="narrative">
          <h3>{S.todayFocus}</h3>
          <p>{brief.narrative}</p>
        </section>
      )}
      <Notices brief={brief} />
      {groups.length === 0 && <p className="empty">{S.briefEmpty}</p>}
      {groups.map((g) => (
        <section key={g.section} className="brief-section">
          <h3>{S.briefSections[g.section]}</h3>
          {g.items.map((i) => (
            <div key={i.key} className="brief-item">
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
          {brief.previousDay.entries.map((e) => (
            <div key={e.ticketKey}>
              <button className="chip" onClick={() => onOpenTicket(e.ticketKey)}>{e.ticketKey}</button>
              <DoneList items={e.done} />
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function EveningBody({ brief, onOpenTicket }: { brief: Brief; onOpenTicket: (key: string) => void }) {
  return (
    <>
      <Notices brief={brief} />
      {brief.evening.length === 0 && <p className="empty">{S.noEvening}</p>}
      {brief.evening.map((e) => (
        <div key={e.ticketKey} className="evening-entry">
          <button className="chip" onClick={() => onOpenTicket(e.ticketKey)}>{e.ticketKey}</button>
          {e.degraded && <span className="error"> {S.eveningDegraded}</span>}
          {e.done.length > 0 ? <DoneList items={e.done} /> : <p className="muted">{S.eveningNothingDone}</p>}
          {e.blockers.length > 0 && <p>{S.eveningBlockers}{e.blockers.join("；")}</p>}
          {e.next && <p>{S.eveningNext}{e.next}</p>}
        </div>
      ))}
    </>
  );
}
