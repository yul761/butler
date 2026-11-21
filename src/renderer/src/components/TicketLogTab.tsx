// ticket 页「记录」页签（UI 重做第 3 层）：待跟进、状态记录、记忆三个小节并排。更新状态的按钮在概况里（BTL-244）。PR 的状态归概况和 PR 详情，这里不再说。
import { useCallback, useEffect, useState } from "react";
import type { Followup, FollowupStatus, HandoffRecord } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { followupMeta, splitFollowups } from "../followup-view";
import { S } from "../strings";
import { MemoryPanel } from "./MemoryPanel";
import { StatusEntry } from "./TicketStatus";

export function TicketLogTab({ ticketKey }: { ticketKey: string }) {
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [history, setHistory] = useState<HandoffRecord[]>([]);
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
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

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
        <h3>{S.lay.logHandoffs}</h3>
        {history.length === 0 && <p className="muted">{S.noHandoffs}</p>}
        {history.map((h) => (
          <StatusEntry key={h.id} h={h} />
        ))}
      </section>
      <section className="ticket-log-memory">
        <h3>{S.lay.logMemory}</h3>
        <MemoryPanel ticketKey={ticketKey} />
      </section>
    </div>
  );
}
