import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { OpenSessionResult, SessionView } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { lastSegment } from "../repos";
import { initialPane, sessionLabel } from "../sessions";
import { S } from "../strings";
import { EndSessionButton } from "./EndSessionButton";
import { RefreshSessionButton } from "./RefreshSessionButton";
import { RepoPicker } from "./RepoPicker";
import { TerminalPane } from "./TerminalPane";

/** feature 页和 epic 页共用的部分：标题栏，以及页面下半部分的仓库条、session 条和终端。 */

interface SessionPanesOptions {
  /** 打开 sessionId 这个 session；不给就新开一个。 */
  openSession: (sessionId?: string) => Promise<OpenSessionResult>;
  /** 打不开时显示的文字。 */
  openFailure: (reason: string) => string;
  errorText: (e: unknown) => string;
  setError: (message: string | null) => void;
  /** 页面打开时先看这个 session 的终端（「现在」页点进来的那个）；不给或者它没开着就看第一个。 */
  initialActive?: string | null;
}

export type SessionPanes = ReturnType<typeof useSessionPanes>;

/** 这一页开着哪些终端、正在看哪一个。已退出但还没关闭的终端留着，方便看到 claude 的报错输出（和 ticket 页一样）。 */
export function useSessionPanes(sessions: SessionView[], { openSession, openFailure, errorText, setError, initialActive }: SessionPanesOptions) {
  const openTerms = sessions.flatMap((s) => (s.termId ? [s.termId] : []));
  const [panes, setPanes] = useState<string[]>(openTerms);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const [active, setActive] = useState<string | null>(() => initialPane(sessions, initialActive));

  const openKey = openTerms.join(",");
  useEffect(() => {
    const ids = openKey ? openKey.split(",") : [];
    setPanes((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  }, [openKey]);

  async function open(sessionId?: string) {
    setError(null);
    try {
      const r = await openSession(sessionId);
      if (!r.ok) {
        setError(openFailure(r.reason));
        return;
      }
      const replaced = sessionId && sessionId !== r.termId ? sessionId : null;
      setPanes((prev) => {
        if (prev.includes(r.termId)) return replaced ? prev.filter((p) => p !== replaced) : prev;
        return replaced && prev.includes(replaced) ? prev.map((p) => (p === replaced ? r.termId : p)) : [...prev, r.termId];
      });
      setActive(r.termId);
    } catch (e) {
      setError(errorText(e));
    }
  }

  /** 切到这个终端（不在面板里就加上）。 */
  function show(termId: string) {
    setPanes((prev) => (prev.includes(termId) ? prev : [...prev, termId]));
    setActive(termId);
  }

  function close(id: string) {
    const rest = panesRef.current.filter((p) => p !== id);
    panesRef.current = rest;
    setPanes(rest);
    setActive((cur) => (cur === id ? (rest[0] ?? null) : cur));
  }

  return { panes, active, setActive, open, show, close };
}

interface HeaderProps {
  name: string;
  nameLabel: string;
  workspaceDir: string;
  onRename: (name: string) => Promise<unknown>;
  archiveLabel: string;
  archivingLabel: string;
  /** 可能要等两分钟（先生成汇总）：等待期间按钮显示进行中。成功后页面由 App 换掉。 */
  onArchive: () => Promise<unknown>;
  onError: (e: unknown) => void;
  /** 改名和归档之间的控件。 */
  children?: ReactNode;
}

/** 页面标题栏：名字、工作区、改名、归档。 */
export function WorkspaceHeader({ name, nameLabel, workspaceDir, onRename, archiveLabel, archivingLabel, onArchive, onError, children }: HeaderProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function rename(e: FormEvent) {
    e.preventDefault();
    try {
      await onRename(renaming ?? "");
      setRenaming(null);
    } catch (err) {
      onError(err);
    }
  }

  async function archive() {
    setArchiving(true);
    try {
      await onArchive();
    } catch (err) {
      setArchiving(false);
      // 等汇总时用户可能已经离开这一页：页面的错误区也不在了，改用顶部的错误条，不然归档失败没有任何提示。
      if (mounted.current) onError(err);
      else reportError(err);
    }
  }

  return (
    <header className="ticket-header">
      {renaming === null ? (
        <h2>{name}</h2>
      ) : (
        <form className="row" onSubmit={rename}>
          <input aria-label={nameLabel} value={renaming} onChange={(e) => setRenaming(e.target.value)} autoFocus />
          <button type="submit" className="primary">{S.save}</button>
          <button type="button" onClick={() => setRenaming(null)}>{S.cancel}</button>
        </form>
      )}
      <span className="muted" title={workspaceDir}>{S.labelled(S.featureWorkspace, workspaceDir)}</span>
      {renaming === null && <button onClick={() => setRenaming(name)}>{S.rename}</button>}
      {children}
      <button disabled={archiving} onClick={() => void archive()}>{archiving ? archivingLabel : archiveLabel}</button>
    </header>
  );
}

interface AreaProps {
  repos: { id: number; repoPath: string }[];
  reposHint: string;
  onAddRepo: (path: string) => Promise<unknown>;
  onRemoveRepo: (id: number) => Promise<unknown>;
  sessions: SessionView[];
  hiddenSessions: SessionView[];
  panes: SessionPanes;
  /** session 按钮上标明它是什么 session。 */
  placeOf: (s: SessionView) => string;
  noSessions: string;
  newSession: string;
  newSessionHint: string;
  error: string | null;
  onError: (e: unknown) => void;
}

/** 页面下半部分：仓库条、session 条和终端。 */
export function SessionArea({ repos, reposHint, onAddRepo, onRemoveRepo, sessions, hiddenSessions, panes, placeOf, noSessions, newSession, newSessionHint, error, onError }: AreaProps) {
  const [addingRepo, setAddingRepo] = useState<string[] | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  async function addRepos(e: FormEvent) {
    e.preventDefault();
    try {
      for (const p of addingRepo ?? []) await onAddRepo(p);
      setAddingRepo(null);
    } catch (err) {
      onError(err);
    }
  }

  return (
    <>
      <div className="repos-bar" title={reposHint}>
        <span className="label">{S.featureRepos}</span>
        {repos.map((r) => (
          <span key={r.id} className="repo" title={r.repoPath}>
            <span className="name">{lastSegment(r.repoPath)}</span>
            <button onClick={() => onRemoveRepo(r.id).catch(onError)}>{S.removeRepo}</button>
          </span>
        ))}
        <button onClick={() => setAddingRepo([])}>+ {S.addRepo}</button>
      </div>
      {addingRepo && (
        <form className="notice" onSubmit={addRepos}>
          <RepoPicker label={S.repo} onChange={setAddingRepo} required autoFocus />
          <div className="actions">
            <button type="submit" className="primary" disabled={addingRepo.length === 0}>{S.add}</button>
            <button type="button" onClick={() => setAddingRepo(null)}>{S.cancel}</button>
          </div>
        </form>
      )}

      <div className="sessions-bar">
        {sessions.length === 0 && <span className="muted">{noSessions}</span>}
        {sessions.map((s) => (
          <span key={s.id} className="session-wrap">
            <button
              className={s.termId && s.termId === panes.active ? "session active" : "session"}
              title={`${s.firstPrompt ?? S.untitledSession}\n${s.id}`}
              onClick={() => (s.termId ? panes.setActive(s.termId) : void panes.open(s.id))}
            >
              {s.waitingForInput && <span className="badge">●</span>}
              <span className="place">{placeOf(s)}</span>
              <span className="label">{sessionLabel(s, S.untitledSession)}</span>
              <span className="action">{s.termId ? S.switchTo : S.open}</span>
            </button>
            {s.termId ? (
              <>
                {/* 修复 session 不换新（计划 16）。 */}
                {s.fixesSession === null && <RefreshSessionButton sessionId={s.id} label={sessionLabel(s, S.untitledSession)} />}
                <EndSessionButton termId={s.termId} label={sessionLabel(s, S.untitledSession)} onEnded={() => panes.close(s.termId!)} />
              </>
            ) : (
              <button className="session-hide" title={S.hideSession} aria-label={S.hideSessionNamed(sessionLabel(s, S.untitledSession))} onClick={() => api.hideSession(s.id).catch(reportError)}>
                ×
              </button>
            )}
          </span>
        ))}
        {hiddenSessions.length > 0 && (
          <button className="session more" onClick={() => setShowHidden(!showHidden)}>{S.hiddenSessions(hiddenSessions.length)}</button>
        )}
        <button className="primary" title={newSessionHint} onClick={() => void panes.open()}>+ {newSession}</button>
      </div>
      {showHidden && hiddenSessions.length > 0 && (
        <div className="notice hidden-sessions">
          <p className="muted">{S.hiddenSessionsHint}</p>
          {hiddenSessions.map((s) => (
            <div key={s.id} className="row">
              <span className="label">{sessionLabel(s, S.untitledSession)}</span>
              <button onClick={() => api.unhideSession(s.id).catch(reportError)}>{S.unhideSession}</button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <div className="terminals">
        {panes.panes.map((id) => <TerminalPane key={id} termId={id} visible={id === panes.active} onClose={() => panes.close(id)} onResume={() => void panes.open(id)} />)}
      </div>
    </>
  );
}
