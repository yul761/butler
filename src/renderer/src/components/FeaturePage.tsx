import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FeatureView, OpenFeatureSessionRequest } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { lastSegment } from "../repos";
import { sessionLabel } from "../sessions";
import { S, STATUS_LABEL } from "../strings";
import { NewTicketDialog } from "./NewTicketDialog";
import { RepoPicker } from "./RepoPicker";
import { TerminalPane } from "./TerminalPane";

interface Props {
  feature: FeatureView;
  onOpenTicket: (key: string) => void;
  onArchived: () => void;
  /** 新建的 ticket：重读列表后跳过去。 */
  onTicketCreated: (key: string) => void;
}

const errorText = (e: unknown) => (e instanceof ButlerError ? (S.createErrors[e.code] ?? e.message) : (e as Error).message);

/**
 * feature 页（设计文档 2026-10-26）：名字、工作区、仓库、下面的 ticket，以及 feature 总控 session 和它们的终端。
 */
export function FeaturePage({ feature, onOpenTicket, onArchived, onTicketCreated }: Props) {
  const openTerms = feature.sessions.flatMap((s) => (s.termId ? [s.termId] : []));
  // 和 ticket 页一样：已退出但还没关闭的终端留着，方便看到 claude 的报错输出。
  const [panes, setPanes] = useState<string[]>(openTerms);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const [active, setActive] = useState<string | null>(openTerms[0] ?? null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [addingRepo, setAddingRepo] = useState<string[] | null>(null);
  const [newTicket, setNewTicket] = useState(false);

  const openKey = openTerms.join(",");
  useEffect(() => {
    const ids = openKey ? openKey.split(",") : [];
    setPanes((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  }, [openKey]);

  async function open(req: OpenFeatureSessionRequest) {
    setError(null);
    try {
      const r = await api.openFeatureSession(req);
      if (!r.ok) {
        setError(S.openErrors[r.reason] ?? r.reason);
        return;
      }
      const replaced = req.sessionId && req.sessionId !== r.termId ? req.sessionId : null;
      setPanes((prev) => {
        if (prev.includes(r.termId)) return replaced ? prev.filter((p) => p !== replaced) : prev;
        return replaced && prev.includes(replaced) ? prev.map((p) => (p === replaced ? r.termId : p)) : [...prev, r.termId];
      });
      setActive(r.termId);
    } catch (e) {
      setError(errorText(e));
    }
  }

  function closePane(id: string) {
    const rest = panesRef.current.filter((p) => p !== id);
    panesRef.current = rest;
    setPanes(rest);
    setActive((cur) => (cur === id ? (rest[0] ?? null) : cur));
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    try {
      await api.renameFeature(feature.id, renaming ?? "");
      setRenaming(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function addRepos(e: FormEvent) {
    e.preventDefault();
    try {
      for (const p of addingRepo ?? []) await api.addFeatureRepo(feature.id, p);
      setAddingRepo(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function archive() {
    try {
      await api.archiveFeature(feature.id);
      onArchived();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="ticket-page feature-page">
      <header className="ticket-header">
        {renaming === null ? (
          <h2>{feature.name}</h2>
        ) : (
          <form className="row" onSubmit={rename}>
            <input aria-label={S.featureName} value={renaming} onChange={(e) => setRenaming(e.target.value)} autoFocus />
            <button type="submit" className="primary">{S.save}</button>
            <button type="button" onClick={() => setRenaming(null)}>{S.cancel}</button>
          </form>
        )}
        <span className="muted" title={feature.workspaceDir}>{S.featureWorkspace}：{feature.workspaceDir}</span>
        {renaming === null && <button onClick={() => setRenaming(feature.name)}>{S.rename}</button>}
        <button onClick={() => void archive()}>{S.archiveFeature}</button>
      </header>

      <div className="repos-bar" title={S.featureReposHint}>
        <span className="label">{S.featureRepos}</span>
        {feature.repos.map((r) => (
          <span key={r.id} className="repo" title={r.repoPath}>
            <span className="name">{lastSegment(r.repoPath)}</span>
            <button onClick={() => api.removeFeatureRepo(r.id).catch((e: unknown) => setError(errorText(e)))}>{S.removeRepo}</button>
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

      <section className="feature-tickets">
        <h3>{S.featureTickets}</h3>
        {feature.tickets.length === 0 && <p className="muted">{S.noFeatureTickets}</p>}
        {feature.tickets.map((t) => (
          <button key={t.key} className="ticket" onClick={() => onOpenTicket(t.key)}>
            <span className="key">{t.key}</span>
            {t.title && <span className="title">{t.title}</span>}
            <span className="muted">{STATUS_LABEL[t.effectiveStatus]}</span>
            <span className="muted">{t.repos.map((r) => lastSegment(r.repoPath)).join(", ")}</span>
            {t.waiting && <span className="badge" title={S.waiting}>●</span>}
          </button>
        ))}
        <button onClick={() => setNewTicket(true)}>+ {S.newTicket}</button>
      </section>
      {newTicket && (
        <NewTicketDialog
          feature={feature}
          onClose={() => setNewTicket(false)}
          onRestored={(key) => (setNewTicket(false), onTicketCreated(key))}
          onCreated={(key) => (setNewTicket(false), onTicketCreated(key))}
        />
      )}

      <div className="sessions-bar">
        {feature.sessions.length === 0 && <span className="muted">{S.noFeatureSessions}</span>}
        {feature.sessions.map((s) => (
          <span key={s.id} className="session-wrap">
            <button
              className={s.termId && s.termId === active ? "session active" : "session"}
              title={`${s.firstPrompt ?? S.untitledSession}\n${s.id}`}
              onClick={() => (s.termId ? setActive(s.termId) : void open({ featureId: feature.id, sessionId: s.id }))}
            >
              {s.waitingForInput && <span className="badge">●</span>}
              <span className="place">{S.coordinator}</span>
              <span className="label">{sessionLabel(s, S.untitledSession)}</span>
              <span className="action">{s.termId ? S.switchTo : S.open}</span>
            </button>
            {!s.termId && (
              <button className="session-hide" title={S.hideSession} aria-label={S.hideSessionNamed(sessionLabel(s, S.untitledSession))} onClick={() => api.hideSession(s.id).catch(reportError)}>
                ×
              </button>
            )}
          </span>
        ))}
        <button className="primary" title={S.featureCoordinatorHint} onClick={() => void open({ featureId: feature.id })}>+ {S.newCoordinator}</button>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="terminals">
        {panes.map((id) => <TerminalPane key={id} termId={id} visible={id === active} onClose={() => closePane(id)} onResume={() => void open({ featureId: feature.id, sessionId: id })} />)}
      </div>
    </div>
  );
}
