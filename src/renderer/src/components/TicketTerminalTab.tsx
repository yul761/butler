// ticket 页「终端」页签（UI 重做第 3 层）：仓库条、session 条、各种打开提示和终端，原样从 TicketPage 搬来，CSS 类名一个不改（e2e 靠它们）。
// 终端面板和打开 session 的状态（useTicketTerminals）由 TicketPage 持有：切到别的页签再回来，TerminalPane 从快照重建，不丢。
import { useEffect, useRef, useState } from "react";
import type { OpenSessionRequest, TicketRepo, TicketView } from "../../../shared/types";
import { api, ShipherdError } from "../api";
import { reportError } from "../errors";
import { repoName, repoWhere, sessionPlace } from "../repos";
import { sessionLabel, splitSessions } from "../sessions";
import { S } from "../strings";
import { RepoDialog } from "./RepoDialog";
import { EndSessionButton } from "./EndSessionButton";
import { NoChecksMark } from "./NoChecksMark";
import { HibernateBadges, hibernationOf, isHibernated, PinButton, sessionTitle } from "./HibernateParts";
import { CloseIdleButton, DeleteHiddenButton } from "./SessionCleanupButtons";
import { RefreshSessionButton } from "./RefreshSessionButton";
import { SessionLimit } from "./SessionLimit";
import { SessionCost } from "./SessionCost";
import { TerminalPane } from "./TerminalPane";
import { SessionPreReviewChip } from "./PreReviewChip";

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
  busyBy?: { ticket: string; branch: string };
}

interface OldWorkdir {
  req: OpenSessionRequest;
  cwd: string;
  current: string;
  expected: string;
}

export interface TicketTerminals {
  /** 开着的终端（含已退出但还没关闭的，方便看到 claude 的报错输出）。 */
  panes: string[];
  /** 最新的面板列表（连续操作时 panes 闭包可能已经过时）。 */
  panesRef: { readonly current: string[] };
  active: string | null;
  setActive: (termId: string) => void;
  open: (req: OpenSessionRequest) => Promise<void>;
  closePane: (id: string) => void;
  mismatch: Mismatch | null;
  setMismatch: (m: Mismatch | null) => void;
  oldWorkdir: OldWorkdir | null;
  setOldWorkdir: (o: OldWorkdir | null) => void;
  error: string | null;
  setError: (e: string | null) => void;
}

/** ticket 页的终端状态：放在 TicketPage 里调用，页签切走不丢。 */
export function useTicketTerminals(ticket: TicketView): TicketTerminals {
  const openTerms = ticket.sessions.flatMap((s) => (s.termId ? [s.termId] : []));
  const [panes, setPanes] = useState<string[]>(openTerms);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const [active, setActive] = useState<string | null>(openTerms[0] ?? null);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const [oldWorkdir, setOldWorkdir] = useState<OldWorkdir | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openKey = openTerms.join(",");
  useEffect(() => {
    const ids = openKey ? openKey.split(",") : [];
    setPanes((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  }, [openKey]);

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
        setMismatch({ req, repoId: r.repoId, current: r.current, expected: r.expected, dirty: r.dirty, busyBy: r.busyBy });
      } else if (r.reason === "old_workdir") {
        setOldWorkdir({ req, cwd: r.cwd, current: r.current, expected: r.expected });
      } else {
        setError(S.openErrors[r.reason]);
      }
    } catch (e) {
      setError(e instanceof ShipherdError ? e.message : (e as Error).message);
    }
  }

  function closePane(id: string) {
    // 用最新的面板列表选下一个（连续关闭时 panes 闭包可能已经过时）。
    const rest = panesRef.current.filter((p) => p !== id);
    panesRef.current = rest;
    setPanes(rest);
    setActive((cur) => (cur === id ? (rest[0] ?? null) : cur));
  }

  return { panes, panesRef, active, setActive, open, closePane, mismatch, setMismatch, oldWorkdir, setOldWorkdir, error, setError };
}

export function TicketTerminalTab({ ticket, term }: { ticket: TicketView; term: TicketTerminals }) {
  const { panes, active, setActive, open, closePane, mismatch, setMismatch, oldWorkdir, setOldWorkdir, error, setError } = term;
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  /** 打开的仓库对话框：null 关闭，"new" 添加，否则编辑这个仓库。 */
  const [repoDialog, setRepoDialog] = useState<TicketRepo | "new" | null>(null);
  const [removing, setRemoving] = useState<TicketRepo | null>(null);
  /** 多仓库 ticket 新 session 开在哪个仓库里（默认第一个）。 */
  const [newRepoId, setNewRepoId] = useState<number | null>(null);
  const pickedRepo = ticket.repos.find((r) => r.id === newRepoId) ?? ticket.repos[0];

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
    void open({ ticketKey: ticket.key, repoId: s?.repoId ?? pickedRepo?.id });
  }

  const sessionSplit = splitSessions(ticket.sessions, VISIBLE_SESSIONS);

  return (
    <>
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
        {/* 没有仓库就开不了 session：这时「添加仓库」是这一页唯一要做的事（BTL-249）。 */}
        <button className={ticket.repos.length === 0 ? "primary" : undefined} onClick={() => setRepoDialog("new")}>+ {S.addRepo}</button>
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

      <div className="sessions-bar">
        {ticket.sessions.length === 0 && ticket.repos.length > 0 && <span className="muted">{S.noSessions}</span>}
        {(showAllSessions ? ticket.sessions : sessionSplit.shown).map((s) => (
          <span key={s.id} className="session-wrap">
            <button
              className={s.termId && s.termId === active ? "session active" : isHibernated(s) ? "session hibernated" : "session"}
              title={sessionTitle(s)}
              onClick={() => (s.termId ? setActive(s.termId) : void open({ ticketKey: ticket.key, sessionId: s.id }))}
            >
              {s.waitingForInput && <span className="badge">●</span>}
              {sessionPlace(s, ticket.repos) && <span className="place">{sessionPlace(s, ticket.repos)}</span>}
              {s.spawnedBy && <span className="muted" title={S.spawnedByCoordinator}>↳</span>}
              <span className="label">{sessionLabel(s, S.untitledSession)}</span>
              <NoChecksMark reason={s.checksAbsent} />
              <SessionPreReviewChip sessionId={s.id} />
              <span className="muted">{s.lastActivityAt ? formatShort(s.lastActivityAt) : ""}</span>
              <HibernateBadges s={s} />
              <span className="action">{s.termId ? S.switchTo : isHibernated(s) ? S.hib.open : S.open}</span>
            </button>
            <PinButton s={s} label={sessionLabel(s, S.untitledSession)} />
            <SessionCost sessionId={s.id} ticketKey={s.ticketKey} />
            {/* 正在运行的终端不能隐藏，只能结束（×点两次）；结束之后才能隐藏。 */}
            {s.termId ? (
              <>
                {/* 修复 session 不换新（计划 16）。 */}
                <SessionLimit sessionId={s.id} />
                {s.fixesSession === null && <RefreshSessionButton sessionId={s.id} label={sessionLabel(s, S.untitledSession)} />}
                <EndSessionButton termId={s.termId} label={sessionLabel(s, S.untitledSession)} onEnded={() => closePane(s.termId!)} />
              </>
            ) : (
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
        <CloseIdleButton sessionIds={ticket.sessions.filter((s) => s.termId !== null).map((s) => s.id)} />
        {ticket.repos.length > 1 && (
          <select aria-label={S.pickRepo} value={pickedRepo?.id} onChange={(e) => setNewRepoId(Number(e.target.value))}>
            {ticket.repos.map((r) => <option key={r.id} value={r.id}>{repoName(r)}</option>)}
          </select>
        )}
        {pickedRepo && <button className="primary" onClick={() => void open({ ticketKey: ticket.key, repoId: pickedRepo.id })}>+ {S.newSession}</button>}
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
          <div className="actions">
            <DeleteHiddenButton sessionIds={ticket.hiddenSessions.map((s) => s.id)} />
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {mismatch && (
        <div className="notice">
          <p>{S.branchMismatch(mismatch.current, mismatch.expected)}</p>
          {mismatch.busyBy && <p className="error">{S.branchBusy(mismatch.busyBy.ticket, mismatch.busyBy.branch)}</p>}
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
        {panes.map((id) => (
          <TerminalPane
            key={id} termId={id} visible={id === active} hibernated={hibernationOf(ticket.sessions, id)}
            onClose={() => closePane(id)} onResume={() => void open({ ticketKey: ticket.key, sessionId: id })}
          />
        ))}
      </div>
    </>
  );
}
