import { useEffect, useRef, useState } from "react";
import { TICKET_STATUSES, type Feature, type OpenSessionRequest, type TicketRepo, type TicketStatus, type TicketView } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { repoName, repoWhere, sessionPlace } from "../repos";
import { sessionLabel, splitSessions } from "../sessions";
import { S, STATUS_LABEL } from "../strings";
import { RepoDialog } from "./RepoDialog";
import { TerminalPane } from "./TerminalPane";
import { TicketOverview } from "./TicketOverview";
import { TitleDialog } from "./TitleDialog";

const VISIBLE_SESSIONS = 3;

function formatShort(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface Mismatch {
  req: OpenSessionRequest;
  repoId: number;
  current: string;
  expected: string;
  dirty: boolean;
}

interface OldWorkdir {
  req: OpenSessionRequest;
  cwd: string;
  current: string;
  expected: string;
}

interface Props {
  ticket: TicketView;
  onArchived: () => void;
  /** 从简报点“打开”进来时要执行的打开请求。 */
  initialOpen?: OpenSessionRequest | null;
  onInitialOpenDone?: () => void;
  /** ticket 属于的 feature（设计文档 2026-10-26）。 */
  feature?: Pick<Feature, "id" | "name"> | null;
  onOpenFeature?: (id: number) => void;
}

export function TicketPage({ ticket, onArchived, initialOpen = null, onInitialOpenDone, feature = null, onOpenFeature }: Props) {
  const openTerms = ticket.sessions.flatMap((s) => (s.termId ? [s.termId] : []));
  // panes 里保留已退出但还没关闭的终端，方便看到 claude 的报错输出。
  const [panes, setPanes] = useState<string[]>(openTerms);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const [active, setActive] = useState<string | null>(openTerms[0] ?? null);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const [oldWorkdir, setOldWorkdir] = useState<OldWorkdir | null>(null);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  /** 打开的仓库对话框：null 关闭，"new" 添加，否则编辑这个仓库。 */
  const [repoDialog, setRepoDialog] = useState<TicketRepo | "new" | null>(null);
  const [removing, setRemoving] = useState<TicketRepo | null>(null);
  /** 多仓库 ticket 新 session 开在哪个仓库里（默认第一个）。 */
  const [newRepoId, setNewRepoId] = useState<number | null>(null);
  const pickedRepo = ticket.repos.find((r) => r.id === newRepoId) ?? ticket.repos[0];

  const openKey = openTerms.join(",");
  useEffect(() => {
    const ids = openKey ? openKey.split(",") : [];
    setPanes((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  }, [openKey]);

  // 从简报点“打开”：恢复 session 并预填提示，只执行一次。
  useEffect(() => {
    if (!initialOpen) return;
    onInitialOpenDone?.();
    void open(initialOpen);
  }, [initialOpen]);

  async function open(req: OpenSessionRequest) {
    setError(null);
    setMismatch(null);
    setOldWorkdir(null);
    try {
      const r = await api.openSession(req);
      if (r.ok) {
        // /clear 之后续接：终端换成了新的 session id，旧的（已退出的）面板原地换成新的，不再多出一个。
        const replaced = req.sessionId && req.sessionId !== r.termId ? req.sessionId : null;
        setPanes((prev) => {
          if (prev.includes(r.termId)) return replaced ? prev.filter((p) => p !== replaced) : prev;
          return replaced && prev.includes(replaced) ? prev.map((p) => (p === replaced ? r.termId : p)) : [...prev, r.termId];
        });
        setActive(r.termId);
      } else if (r.reason === "branch_mismatch") {
        setMismatch({ req, repoId: r.repoId, current: r.current, expected: r.expected, dirty: r.dirty });
      } else if (r.reason === "old_workdir") {
        setOldWorkdir({ req, cwd: r.cwd, current: r.current, expected: r.expected });
      } else {
        setError(S.openErrors[r.reason]);
      }
    } catch (e) {
      setError(e instanceof ButlerError ? e.message : (e as Error).message);
    }
  }

  async function switchAndOpen(m: Mismatch) {
    try {
      await api.switchBranch(m.repoId);
      await open(m.req);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeRepo(r: TicketRepo) {
    setRemoving(null);
    try {
      await api.removeRepo(r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** 旧目录提示里的“新 session”：开在那个 session 的仓库里。 */
  function newSessionLike(req: OpenSessionRequest) {
    const s = ticket.sessions.find((x) => x.id === req.sessionId);
    void open(s?.coordinator ? { ticketKey: ticket.key, coordinator: true } : { ticketKey: ticket.key, repoId: s?.repoId ?? pickedRepo?.id });
  }

  function closePane(id: string) {
    // 用最新的面板列表选下一个（连续关闭时 panes 闭包可能已经过时）。
    const rest = panesRef.current.filter((p) => p !== id);
    panesRef.current = rest;
    setPanes(rest);
    setActive((cur) => (cur === id ? (rest[0] ?? null) : cur));
  }

  const sessionSplit = splitSessions(ticket.sessions, VISIBLE_SESSIONS);
  const statusValue = ticket.statusManual ?? "auto";

  return (
    <div className="ticket-page">
      <header className="ticket-header">
        <h2>{ticket.key}{ticket.title && <span className="title"> · {ticket.title}</span>}</h2>
        <span className="muted">{ticket.repos.length === 1 ? repoWhere(ticket.repos[0]) : ""}</span>
        <select
          value={statusValue}
          onChange={(e) => api.setStatus(ticket.key, e.target.value === "auto" ? null : (e.target.value as TicketStatus)).catch(reportError)}
        >
          <option value="auto">{S.statusAuto(STATUS_LABEL[ticket.status])}</option>
          {TICKET_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button onClick={() => setEditingTitle(true)}>{S.editTitle}</button>
        <button onClick={() => api.archive(ticket.key).then(onArchived, reportError)}>{S.archive}</button>
      </header>
      {feature && (
        <div className="muted feature-link">
          {S.inFeature} <button className="link" onClick={() => onOpenFeature?.(feature.id)}>{feature.name}</button>
        </div>
      )}
      {editingTitle && <TitleDialog ticket={ticket} onClose={() => setEditingTitle(false)} />}
      {repoDialog && (
        <RepoDialog
          ticketKey={ticket.key}
          repo={repoDialog === "new" ? undefined : repoDialog}
          hasSessions={ticket.sessions.length > 0}
          onClose={() => setRepoDialog(null)}
        />
      )}

      <div className="repos-bar">
        <span className="label">{S.repos}</span>
        {ticket.repos.length === 0 && <span className="muted">{S.noRepos}</span>}
        {ticket.repos.map((r) => (
          <span key={r.id} className="repo" title={repoWhere(r)}>
            <span className="name">{repoName(r)}</span>
            <span className="muted">{r.workMode === "worktree" ? S.worktree : r.branch}</span>
            {r.worktreeRemovedAt !== null && <span className="muted">{S.worktreeRemoved}</span>}
            <button onClick={() => setRepoDialog(r)}>{S.edit}</button>
            <button onClick={() => setRemoving(r)}>{S.removeRepo}</button>
          </span>
        ))}
        <button onClick={() => setRepoDialog("new")}>+ {S.addRepo}</button>
      </div>
      {ticket.repos.filter((r) => r.cleanupBlocked).map((r) => (
        <div key={r.id} className="notice">
          <p>{S.cleanupBlocked(repoName(r), r.cleanupBlocked!)}</p>
          <div className="actions">
            <button onClick={() => api.recheckCleanup(ticket.key).catch(reportError)}>{S.recheckCleanup}</button>
          </div>
        </div>
      ))}
      {removing && (
        <div className="notice">
          <p>{S.removeRepoConfirm(repoName(removing))}</p>
          <div className="actions">
            <button onClick={() => void removeRepo(removing)}>{S.confirmRemove}</button>
            <button onClick={() => setRemoving(null)}>{S.cancel}</button>
          </div>
        </div>
      )}

      <TicketOverview ticketKey={ticket.key} />

      <div className="sessions-bar">
        {ticket.sessions.length === 0 && <span className="muted">{S.noSessions}</span>}
        {(showAllSessions ? ticket.sessions : sessionSplit.shown).map((s) => (
          <span key={s.id} className="session-wrap">
            <button
              className={s.termId && s.termId === active ? "session active" : "session"}
              title={`${s.firstPrompt ?? S.untitledSession}\n${s.id}`}
              onClick={() => (s.termId ? setActive(s.termId) : void open({ ticketKey: ticket.key, sessionId: s.id }))}
            >
              {s.waitingForInput && <span className="badge">●</span>}
              {sessionPlace(s, ticket.repos, S.coordinator) && <span className="place">{sessionPlace(s, ticket.repos, S.coordinator)}</span>}
              {s.spawnedBy && <span className="muted" title={S.spawnedByCoordinator}>↳</span>}
              <span className="label">{sessionLabel(s, S.untitledSession)}</span>
              <span className="muted">{s.lastActivityAt ? formatShort(s.lastActivityAt) : ""}</span>
              <span className="action">{s.termId ? S.switchTo : S.open}</span>
            </button>
            {/* 正在运行的终端不能隐藏。 */}
            {!s.termId && (
              <button className="session-hide" title={S.hideSession} aria-label={S.hideSessionNamed(sessionLabel(s, S.untitledSession))} onClick={() => api.hideSession(s.id).catch(reportError)}>
                ×
              </button>
            )}
          </span>
        ))}
        {sessionSplit.hidden.length > 0 && (
          <button className="session more" onClick={() => setShowAllSessions(!showAllSessions)}>
            {showAllSessions ? S.collapseSessions : S.olderSessions(sessionSplit.hidden.length)}
          </button>
        )}
        {ticket.hiddenSessions.length > 0 && (
          <button className="session more" onClick={() => setShowHidden(!showHidden)}>{S.hiddenSessions(ticket.hiddenSessions.length)}</button>
        )}
        {ticket.repos.length > 1 && (
          <select aria-label={S.pickRepo} value={pickedRepo?.id} onChange={(e) => setNewRepoId(Number(e.target.value))}>
            {ticket.repos.map((r) => <option key={r.id} value={r.id}>{repoName(r)}</option>)}
          </select>
        )}
        {pickedRepo && <button className="primary" onClick={() => void open({ ticketKey: ticket.key, repoId: pickedRepo.id })}>+ {S.newSession}</button>}
        <button title={S.coordinatorHint} onClick={() => void open({ ticketKey: ticket.key, coordinator: true })}>+ {S.newCoordinator}</button>
      </div>

      {showHidden && ticket.hiddenSessions.length > 0 && (
        <div className="notice hidden-sessions">
          <p className="muted">{S.hiddenSessionsHint}</p>
          {ticket.hiddenSessions.map((s) => (
            <div key={s.id} className="row">
              <span className="label">{sessionLabel(s, S.untitledSession)}</span>
              <span className="muted">{s.lastActivityAt ? formatShort(s.lastActivityAt) : ""}</span>
              <button onClick={() => api.unhideSession(s.id).catch(reportError)}>{S.unhideSession}</button>
            </div>
          ))}
        </div>
      )}
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

      {oldWorkdir && (
        <div className="notice">
          <p>{S.oldWorkdir(oldWorkdir.cwd, oldWorkdir.current, oldWorkdir.expected)}</p>
          <div className="actions">
            <button onClick={() => void open({ ...oldWorkdir.req, force: true })}>{S.openAnyway}</button>
            <button onClick={() => newSessionLike(oldWorkdir.req)}>+ {S.newSession}</button>
            <button onClick={() => setOldWorkdir(null)}>{S.cancel}</button>
          </div>
        </div>
      )}

      <div className="terminals">
        {panes.map((id) => <TerminalPane key={id} termId={id} visible={id === active} onClose={() => closePane(id)} onResume={() => void open({ ticketKey: ticket.key, sessionId: id })} />)}
      </div>
    </div>
  );
}
