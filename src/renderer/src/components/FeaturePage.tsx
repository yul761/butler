import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FeatureView, OpenFeatureSessionRequest } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { prLabel, prPill, summaryOutcomeIsError, summaryOutcomeMessage } from "../feature-summary-view";
import { lastSegment } from "../repos";
import { sessionLabel } from "../sessions";
import { S, STATUS_LABEL } from "../strings";
import { NewTicketDialog } from "./NewTicketDialog";
import { RepoPicker } from "./RepoPicker";
import { TerminalPane } from "./TerminalPane";
import { useCollapsed } from "./useCollapsed";

interface Props {
  feature: FeatureView;
  onOpenTicket: (key: string) => void;
  onArchived: () => void;
  /** 新建的 ticket：重读列表后跳过去。 */
  onTicketCreated: (key: string) => void;
}

const errorText = (e: unknown) => (e instanceof ButlerError ? (S.createErrors[e.code] ?? e.message) : (e as Error).message);

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * feature 页（设计文档 2026-10-26、2026-10-28）：从上到下是名字和工作区、整体进度（feature 汇总）、
 * ticket 表（带 PR 状态），然后是仓库、feature 总控 session 和它们的终端。
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
  const [showHidden, setShowHidden] = useState(false);

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

  const [ticketsCollapsed, toggleTickets] = useCollapsed(`tickets:${feature.id}`);

  // 整个 feature 不止一个 PR 时，PR 标签带上仓库名。
  const allPrs = Object.values(feature.ticketPrs).flat();

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
        <span className="muted" title={feature.workspaceDir}>{S.labelled(S.featureWorkspace, feature.workspaceDir)}</span>
        {renaming === null && <button onClick={() => setRenaming(feature.name)}>{S.rename}</button>}
        <button onClick={() => void archive()}>{S.archiveFeature}</button>
      </header>

      <div className="feature-overview">
        <FeatureProgress feature={feature} onOpenTicket={onOpenTicket} />
        <section className="feature-tickets">
          <h3>
            <button className="section-toggle" aria-expanded={!ticketsCollapsed} onClick={toggleTickets}>
              <span className="twisty">{ticketsCollapsed ? "▸" : "▾"}</span>
              {S.featureTickets}
              <span className="muted">{feature.tickets.length}</span>
              {ticketsCollapsed && feature.tickets.some((t) => t.waiting) && <span className="badge" title={S.waiting}>●</span>}
            </button>
          </h3>
          {ticketsCollapsed ? null : feature.tickets.length === 0 ? (
            <p className="muted">{S.noFeatureTickets}</p>
          ) : (
            <table className="ticket-table">
              <tbody>
                {feature.tickets.map((t) => {
                  const prs = feature.ticketPrs[t.key] ?? [];
                  // 点一行进 ticket 页；号码是按钮，键盘也能用（点击冒泡到这一行）。
                  return (
                    <tr key={t.key} onClick={() => onOpenTicket(t.key)}>
                      <td><button className="chip">{t.key}</button></td>
                      <td className="title">{t.title ?? ""}</td>
                      <td className="muted status">{STATUS_LABEL[t.effectiveStatus]}</td>
                      <td>
                        {prs.length === 0 && <span className="pill none">{S.noPr}</span>}
                        {prs.map((pr) => (
                          <span key={pr.url} className={`pill ${prPill(pr)}`} title={pr.url}>
                            {prLabel(pr, allPrs)} {S.prPill[prPill(pr)]}
                          </span>
                        ))}
                      </td>
                      <td>{t.waiting && <span className="badge" title={S.waiting}>●</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!ticketsCollapsed && <button onClick={() => setNewTicket(true)}>+ {S.newTicket}</button>}
        </section>
      </div>
      {newTicket && (
        <NewTicketDialog
          feature={feature}
          onClose={() => setNewTicket(false)}
          onRestored={(key) => (setNewTicket(false), onTicketCreated(key))}
          onCreated={(key) => (setNewTicket(false), onTicketCreated(key))}
        />
      )}

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
        {feature.hiddenSessions.length > 0 && (
          <button className="session more" onClick={() => setShowHidden(!showHidden)}>{S.hiddenSessions(feature.hiddenSessions.length)}</button>
        )}
        <button className="primary" title={S.featureCoordinatorHint} onClick={() => void open({ featureId: feature.id })}>+ {S.newCoordinator}</button>
      </div>
      {showHidden && feature.hiddenSessions.length > 0 && (
        <div className="notice hidden-sessions">
          <p className="muted">{S.hiddenSessionsHint}</p>
          {feature.hiddenSessions.map((s) => (
            <div key={s.id} className="row">
              <span className="label">{sessionLabel(s, S.untitledSession)}</span>
              <button onClick={() => api.unhideSession(s.id).catch(reportError)}>{S.unhideSession}</button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <div className="terminals">
        {panes.map((id) => <TerminalPane key={id} termId={id} visible={id === active} onClose={() => closePane(id)} onResume={() => void open({ featureId: feature.id, sessionId: id })} />)}
      </div>
    </div>
  );
}

/**
 * 整体进度（设计文档 2026-10-28）：最新一份 feature 汇总的那段话、卡住的地方、下一步，
 * 以及生成时间、来源和“立即更新”按钮。只显示最新一份，不做历史。
 */
function FeatureProgress({ feature, onOpenTicket }: { feature: FeatureView; onOpenTicket: (key: string) => void }) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const summary = feature.summary;
  // 汇总里的 ticket 后来可能归档了：只有还在这个 feature 下的才能点。
  const keys = new Set(feature.tickets.map((t) => t.key));

  async function runNow() {
    setRunning(true);
    setMessage(null);
    try {
      const o = await api.runFeatureSummary(feature.id);
      setMessage({ text: summaryOutcomeMessage(o), bad: summaryOutcomeIsError(o) });
    } catch (e) {
      setMessage({ text: errorText(e), bad: true });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="feature-progress">
      <h3>{S.featureProgress}</h3>
      {!summary ? (
        <p className="muted">{S.featureSummaryNone}</p>
      ) : summary.payload ? (
        <div className="feature-summary">
          <p>{summary.payload.summary}</p>
          {summary.payload.blockers.map((b, n) => (
            <p key={n} className="blocker">{S.labelled(S.featureBlocked, b)}</p>
          ))}
          {summary.payload.next_steps.length > 0 && (
            <>
              <strong>{S.nextSteps}</strong>
              <ul>
                {summary.payload.next_steps.map((step, n) => (
                  <li key={n}>
                    {step.ticket && (keys.has(step.ticket) ? (
                      <button className="chip" onClick={() => onOpenTicket(step.ticket!)}>{step.ticket}</button>
                    ) : (
                      <span className="key">{step.ticket}</span>
                    ))}
                    {step.ticket && " "}
                    {step.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className="feature-summary">
          <p className="error">{S.featureSummaryDegraded}</p>
          <pre className="raw">{summary.rawText ?? ""}</pre>
        </div>
      )}
      <div className="summary-meta">
        {summary && <span className="muted">{formatTime(summary.createdAt)} · {S.featureSummaryTrigger[summary.trigger]}</span>}
        <button disabled={running} onClick={() => void runNow()}>{running ? S.featureSummaryRunning : S.runFeatureSummary}</button>
        {message && <span className={message.bad ? "error" : "muted"}>{message.text}</span>}
      </div>
    </section>
  );
}
