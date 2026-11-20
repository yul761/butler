// ticket 页「记录」页签（UI 重做第 3 层）：待跟进、交接记录、记忆三个小节并排。PR 的状态归概况和 PR 详情，这里不再说。
import { useCallback, useEffect, useState } from "react";
import type { Followup, FollowupStatus, HandoffRecord } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { followupMeta, outcomeMessage, splitFollowups, triggerLabel } from "../followup-view";
import { S } from "../strings";
import { MemoryPanel } from "./MemoryPanel";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function TicketLogTab({ ticketKey }: { ticketKey: string }) {
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [history, setHistory] = useState<HandoffRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, h] = await Promise.all([api.followups(ticketKey), api.handoffs(ticketKey)]);
      setFollowups(f);
      setHistory(h);
    } catch (e) {
      reportError(e);
    }
  }, [ticketKey]);

  useEffect(() => {
    setMessage(null);
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  async function runNow() {
    setRunning(true);
    setMessage(null);
    try {
      setMessage(outcomeMessage(await api.runHandoff(ticketKey)));
    } catch (e) {
      reportError(e);
    } finally {
      setRunning(false);
    }
  }

  function setStatus(id: string, status: FollowupStatus) {
    api.setFollowupStatus(id, status).catch(reportError);
  }

  const { active, closed } = splitFollowups(followups);

  return (
    <div className="ticket-log">
      <section className="ticket-log-followups">
        <h3>{S.lay.logFollowups}{active.length > 0 && <span className="count">{active.length}</span>}</h3>
        {active.length === 0 && <p className="muted">{S.noFollowups}</p>}
        {active.map((f) => (
          <div key={f.id} className="followup">
            <span className="text">{f.description}</span>
            <span className="muted">{followupMeta(f)}</span>
            <span className="actions">
              <button onClick={() => setStatus(f.id, "done")}>{S.itemActions.done}</button>
              <button onClick={() => setStatus(f.id, "snoozed")}>{S.itemActions.snooze}</button>
              <button onClick={() => setStatus(f.id, "ignored")}>{S.itemActions.ignore}</button>
            </span>
          </div>
        ))}
        {closed.length > 0 && (
          <button className="more" onClick={() => setShowClosed(!showClosed)}>{S.closedFollowups(closed.length)}</button>
        )}
        {showClosed &&
          closed.map((f) => (
            <div key={f.id} className="followup closed">
              <span className="text">{f.description}</span>
              <span className="muted">{followupMeta(f)}</span>
              <span className="actions">
                <button onClick={() => setStatus(f.id, "open")}>{S.reopen}</button>
              </span>
            </div>
          ))}
      </section>
      <section className="ticket-log-handoffs">
        <h3>
          {S.lay.logHandoffs}
          <button disabled={running} onClick={() => void runNow()}>{running ? S.handoffRunning : S.runHandoff}</button>
        </h3>
        {message && <p className="muted" role="status">{message}</p>}
        {history.length === 0 && <p className="muted">{S.noHandoffs}</p>}
        {history.map((h) => (
          <HandoffEntry key={h.id} h={h} />
        ))}
      </section>
      <section className="ticket-log-memory">
        <h3>{S.lay.logMemory}</h3>
        <MemoryPanel ticketKey={ticketKey} />
      </section>
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <span className="muted">{title}</span>
      <ul className="day-list">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function HandoffEntry({ h }: { h: HandoffRecord }) {
  return (
    <div className="handoff-entry">
      <div>
        <strong>{formatTime(h.createdAt)}</strong> <span className="muted">{triggerLabel(h.trigger)}</span>
        {h.degraded && <span className="error"> {S.degradedBadge}</span>}
      </div>
      {h.payload ? (
        <>
          <Section title={S.doneToday} items={h.payload.done_today} />
          <Section title={S.nextSteps} items={h.payload.next_steps} />
          <Section title={S.blockers} items={h.payload.blockers} />
          <Section title={S.openQuestions} items={h.payload.open_questions} />
        </>
      ) : (
        <pre className="raw">{h.rawText ?? ""}</pre>
      )}
    </div>
  );
}
