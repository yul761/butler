import { useCallback, useEffect, useState } from "react";
import { rememberMergedPrs } from "../../../shared/pr-memory";
import type { Followup, FollowupStatus, HandoffRecord } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { prLabel } from "../feature-summary-view";
import { followupMeta, outcomeMessage, splitFollowups, triggerLabel } from "../followup-view";
import { S } from "../strings";
import { MemoryPanel } from "./MemoryPanel";

type Panel = "followups" | "history" | "memory";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function TicketOverview({ ticketKey }: { ticketKey: string }) {
  const [panel, setPanel] = useState<Panel | null>(null);
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
  // 最新一条有效 handoff 的 PR，加上以前记下已合并的（和 feature 页一样）。
  const [latestPrs, ...olderPrs] = history.flatMap((h) => (h.payload ? [h.payload.prs] : []));
  const prs = latestPrs ? rememberMergedPrs(latestPrs, olderPrs) : [];
  const toggle = (p: Panel) => setPanel(panel === p ? null : p);

  return (
    <div className="overview">
      <div className="overview-bar">
        {prs.map((pr) => <span key={pr.url} className="muted" title={pr.url}>{S.prLine(prLabel(pr, prs), pr.state, pr.review)}</span>)}
        <button className={panel === "followups" ? "active" : ""} onClick={() => toggle("followups")}>{S.followupsTab(active.length)}</button>
        <button className={panel === "history" ? "active" : ""} onClick={() => toggle("history")}>{S.historyTab(history.length)}</button>
        <button className={panel === "memory" ? "active" : ""} onClick={() => toggle("memory")}>{S.memoryTab}</button>
        <button disabled={running} onClick={() => void runNow()}>{running ? S.handoffRunning : S.runHandoff}</button>
        {message && <span className="muted">{message}</span>}
      </div>
      {panel === "followups" && (
        <div className="overview-panel">
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
        </div>
      )}
      {panel === "history" && (
        <div className="overview-panel">
          {history.length === 0 && <p className="muted">{S.noHandoffs}</p>}
          {history.map((h) => (
            <HandoffEntry key={h.id} h={h} />
          ))}
        </div>
      )}
      {panel === "memory" && (
        <div className="overview-panel">
          <MemoryPanel ticketKey={ticketKey} />
        </div>
      )}
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
  const prs = h.payload?.prs ?? [];
  return (
    <div className="handoff-entry">
      <div>
        <strong>{formatTime(h.createdAt)}</strong> <span className="muted">{triggerLabel(h.trigger)}</span>
        {h.degraded && <span className="error"> {S.degradedBadge}</span>}
        {prs.map((pr) => <span key={pr.url} className="muted"> · {S.prLine(prLabel(pr, prs), pr.state, pr.review)}</span>)}
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
