import { useEffect, useState } from "react";
import { TICKET_STATUSES, type OpenSessionRequest, type TicketStatus, type TicketView } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { S, STATUS_LABEL } from "../strings";
import { TerminalPane } from "./TerminalPane";

interface Mismatch {
  req: OpenSessionRequest;
  current: string;
  expected: string;
  dirty: boolean;
}

export function TicketPage({ ticket, onArchived }: { ticket: TicketView; onArchived: () => void }) {
  const openTerms = ticket.sessions.flatMap((s) => (s.termId ? [s.termId] : []));
  // panes 里保留已退出但还没关闭的终端，方便看到 claude 的报错输出。
  const [panes, setPanes] = useState<string[]>(openTerms);
  const [active, setActive] = useState<string | null>(openTerms[0] ?? null);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openKey = openTerms.join(",");
  useEffect(() => {
    const ids = openKey ? openKey.split(",") : [];
    setPanes((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  }, [openKey]);

  async function open(req: OpenSessionRequest) {
    setError(null);
    setMismatch(null);
    try {
      const r = await api.openSession(req);
      if (r.ok) {
        setPanes((prev) => (prev.includes(r.termId) ? prev : [...prev, r.termId]));
        setActive(r.termId);
      } else if (r.reason === "branch_mismatch") {
        setMismatch({ req, current: r.current, expected: r.expected, dirty: r.dirty });
      } else {
        setError(S.openErrors[r.reason]);
      }
    } catch (e) {
      setError(e instanceof ButlerError ? e.message : (e as Error).message);
    }
  }

  async function switchAndOpen(m: Mismatch) {
    try {
      await api.switchBranch(ticket.key);
      await open(m.req);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function closePane(id: string) {
    setPanes((prev) => prev.filter((p) => p !== id));
    if (active === id) setActive(panes.find((p) => p !== id) ?? null);
  }

  const statusValue = ticket.statusManual ?? "auto";

  return (
    <div className="ticket-page">
      <header className="ticket-header">
        <h2>{ticket.key}{ticket.title && <span className="title"> · {ticket.title}</span>}</h2>
        <span className="muted">{ticket.workMode === "worktree" ? ticket.worktreePath : `${ticket.repoPath} @ ${ticket.branch}`}</span>
        <select
          value={statusValue}
          onChange={(e) => api.setStatus(ticket.key, e.target.value === "auto" ? null : (e.target.value as TicketStatus)).catch(reportError)}
        >
          <option value="auto">{S.statusAuto(STATUS_LABEL[ticket.status])}</option>
          {TICKET_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button onClick={() => api.archive(ticket.key).then(onArchived, reportError)}>{S.archive}</button>
      </header>

      <div className="sessions-bar">
        {ticket.sessions.length === 0 && <span className="muted">{S.noSessions}</span>}
        {ticket.sessions.map((s) => (
          <button
            key={s.id}
            className={s.termId && s.termId === active ? "session active" : "session"}
            title={s.firstPrompt ?? s.id}
            onClick={() => (s.termId ? setActive(s.termId) : void open({ ticketKey: ticket.key, sessionId: s.id }))}
          >
            {s.waitingForInput && <span className="badge">●</span>}
            {s.id.slice(0, 8)}
            <span className="muted">{s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : ""}</span>
            <span className="action">{s.termId ? S.switchTo : S.open}</span>
          </button>
        ))}
        <button className="primary" onClick={() => void open({ ticketKey: ticket.key })}>+ {S.newSession}</button>
      </div>

      {error && <p className="error">{error}</p>}
      {mismatch && (
        <div className="notice">
          <p>{S.branchMismatch(mismatch.current, mismatch.expected)}</p>
          {mismatch.dirty && <p className="error">{S.dirtyWarning}</p>}
          <div className="actions">
            <button disabled={mismatch.dirty} onClick={() => void switchAndOpen(mismatch)}>{S.switchAndOpen}</button>
            <button onClick={() => void open({ ...mismatch.req, force: true })}>{S.openAnyway}</button>
            <button onClick={() => setMismatch(null)}>{S.cancel}</button>
          </div>
        </div>
      )}

      <div className="terminals">
        {panes.map((id) => <TerminalPane key={id} termId={id} visible={id === active} onClose={() => closePane(id)} />)}
      </div>
    </div>
  );
}
