import { useEffect, useRef, useState } from "react";
import type { SessionActivity } from "../../../shared/activity";
import type { EpicView, FeatureView, TicketView } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { prLabel, prPill, summaryOutcomeIsError, summaryOutcomeMessage } from "../feature-summary-view";
import { S, STATUS_LABEL } from "../strings";
import { NewTicketDialog } from "./NewTicketDialog";
import { StuckPanel } from "./StuckPanel";
import { activityText, useNow } from "./TicketActivity";
import { useCollapsed } from "./useCollapsed";
import { SessionArea, useSessionPanes, WorkspaceHeader } from "./WorkspaceParts";

/** 点卡住通知时要看的 ticket。每次点都是新对象：面板已经开着时再点也要滚过去。 */
export interface StuckReveal {
  ticket: string;
}

interface Props {
  feature: FeatureView;
  /** 可以移进去的 epic（未归档的）。 */
  epics: EpicView[];
  onOpenTicket: (key: string) => void;
  /** 新建的 ticket：重读列表后跳过去。 */
  onTicketCreated: (key: string) => void;
  /** 这一次要滚到的面板；用完调 onRevealed 清空，之后重新挂载不再滚。 */
  reveal: StuckReveal | null;
  onRevealed: () => void;
}

const errorText = (e: unknown) => (e instanceof ButlerError ? (S.createErrors[e.code] ?? e.message) : (e as Error).message);

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * feature 页（设计文档 2026-10-26、2026-10-28）：从上到下是名字和工作区、整体进度（feature 汇总）、
 * ticket 表（带 PR 状态），然后是仓库、feature 总控 session 和它们的终端。
 */
export function FeaturePage({ feature, epics, onOpenTicket, onTicketCreated, reveal, onRevealed }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newTicket, setNewTicket] = useState(false);
  const showError = (e: unknown) => setError(errorText(e));
  const panes = useSessionPanes(feature.sessions, {
    openSession: (sessionId) => api.openFeatureSession({ featureId: feature.id, sessionId }),
    openFailure: (reason) => S.openErrors[reason] ?? reason,
    errorText,
    setError,
  });

  // 子组件的 effect 先跑：TicketRow 已经滚过了，这里才清空。
  useEffect(() => {
    if (reveal) onRevealed();
  }, [reveal]);

  /** 为卡住的 session 开修复 session：成功后切到它的终端（已经开着也一样），失败显示在页面的错误区。 */
  async function openFix(stuckSessionId: string) {
    setError(null);
    try {
      const r = await api.openFixSession({ featureId: feature.id, stuckSessionId });
      if (!r.ok) {
        setError(S.openErrors[r.reason] ?? r.reason);
        return;
      }
      panes.show(r.termId);
    } catch (e) {
      setError(errorText(e));
    }
  }

  function dismissStuck(sessionId: string) {
    api.dismissActivity(sessionId).catch(showError);
  }

  const [ticketsCollapsed, toggleTickets] = useCollapsed(`tickets:${feature.id}`);

  // 整个 feature 不止一个 PR 时，PR 标签带上仓库名。
  const allPrs = Object.values(feature.ticketPrs).flat();
  const now = useNow();
  const anyStuck = Object.values(feature.activity).some((a) => a.stuck === true);
  // 修复 session 的名字带上它修的那个 ticket（从卡住的 session 反查）。
  const fixedTicket = (stuckId: string) => feature.tickets.find((t) => [...t.sessions, ...t.hiddenSessions].some((x) => x.id === stuckId))?.key ?? null;

  return (
    <div className="ticket-page feature-page">
      <WorkspaceHeader
        name={feature.name}
        nameLabel={S.featureName}
        workspaceDir={feature.workspaceDir}
        onRename={(name) => api.renameFeature(feature.id, name)}
        archiveLabel={S.archiveFeature}
        archivingLabel={feature.epicId === null ? S.archiving : S.archivingSummaries}
        onArchive={() => api.archiveFeature(feature.id)}
        onError={showError}
      >
        {(epics.length > 0 || feature.epicId !== null) && (
          <label className="move-to-epic" title={S.moveToEpicHint}>
            {S.moveToEpic}
            <select
              value={feature.epicId ?? ""}
              onChange={(e) => api.moveFeature(feature.id, e.target.value === "" ? null : Number(e.target.value)).catch(showError)}
            >
              <option value="">{S.noEpic}</option>
              {epics.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        )}
      </WorkspaceHeader>

      <div className="feature-overview">
        <FeatureProgress feature={feature} onOpenTicket={onOpenTicket} />
        <section className="feature-tickets">
          <h3>
            <button className="section-toggle" aria-expanded={!ticketsCollapsed} onClick={toggleTickets}>
              <span className="twisty">{ticketsCollapsed ? "▸" : "▾"}</span>
              {S.featureTickets}
              <span className="muted">{feature.tickets.length}</span>
              {ticketsCollapsed && feature.tickets.some((t) => t.waiting) && <span className="badge" title={S.waiting}>●</span>}
              {ticketsCollapsed && anyStuck && <span className="stuck-mark" title={S.stuckDot}>●</span>}
            </button>
          </h3>
          {ticketsCollapsed ? null : feature.tickets.length === 0 ? (
            <p className="muted">{S.noFeatureTickets}</p>
          ) : (
            <table className="ticket-table">
              <tbody>
                {feature.tickets.map((t) => (
                  <TicketRow
                    key={t.key}
                    ticket={t}
                    activity={feature.activity[t.key]}
                    prs={feature.ticketPrs[t.key] ?? []}
                    allPrs={allPrs}
                    now={now}
                    onOpenTicket={onOpenTicket}
                    onFix={openFix}
                    onDismiss={dismissStuck}
                    reveal={reveal?.ticket === t.key ? reveal : null}
                  />
                ))}
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

      <SessionArea
        repos={feature.repos}
        reposHint={S.featureReposHint}
        onAddRepo={(path) => api.addFeatureRepo(feature.id, path)}
        onRemoveRepo={(id) => api.removeFeatureRepo(id)}
        sessions={feature.sessions}
        hiddenSessions={feature.hiddenSessions}
        panes={panes}
        placeOf={(s) => (s.fixesSession ? S.fixSessionFor(fixedTicket(s.fixesSession)) : S.coordinator)}
        noSessions={S.noFeatureSessions}
        newSession={S.newCoordinator}
        newSessionHint={S.featureCoordinatorHint}
        error={error}
        onError={showError}
      />
    </div>
  );
}

/**
 * 整体进度（设计文档 2026-10-28）：最新一份 feature 汇总的那段话、卡住的地方、下一步，
 * 以及生成时间、来源和“立即更新”按钮。只显示最新一份，不做历史。可以收起（每个 feature 各记各的），收起时只留一行开头。
 */
function FeatureProgress({ feature, onOpenTicket }: { feature: FeatureView; onOpenTicket: (key: string) => void }) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [collapsed, toggle] = useCollapsed(`progress:${feature.id}`);
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

  // 收起时标题后面只留一行：汇总的开头，卡住时再加卡住的条数。
  const preview = summary?.payload?.summary ?? "";
  const blockers = summary?.payload?.blockers.length ?? 0;

  return (
    <section className="feature-progress">
      <h3>
        <button className="section-toggle" aria-expanded={!collapsed} onClick={toggle}>
          <span className="twisty">{collapsed ? "▸" : "▾"}</span>
          {S.featureProgress}
        </button>
        {collapsed && blockers > 0 && <span className="blocker">{S.featureBlockedCount(blockers)}</span>}
        {collapsed && preview && <span className="preview muted" title={preview}>{preview}</span>}
      </h3>
      {collapsed ? null : !summary ? (
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
      {!collapsed && (
        <div className="summary-meta">
          {summary && <span className="muted">{formatTime(summary.createdAt)} · {S.featureSummaryTrigger[summary.trigger]}</span>}
          <button disabled={running} onClick={() => void runNow()}>{running ? S.featureSummaryRunning : S.runFeatureSummary}</button>
          {message && <span className={message.bad ? "error" : "muted"}>{message.text}</span>}
        </div>
      )}
      {!collapsed && feature.brief && <FeatureBrief featureId={feature.id} brief={feature.brief} />}
    </section>
  );
}

/** epic session 建 feature 时写的规划。收起也按 feature 记。规划是数据，只当文字显示。 */
function FeatureBrief({ featureId, brief }: { featureId: number; brief: string }) {
  const [collapsed, toggle] = useCollapsed(`brief:${featureId}`);
  return (
    <div className="feature-brief">
      <button className="section-toggle" aria-expanded={!collapsed} onClick={toggle}>
        <span className="twisty">{collapsed ? "▸" : "▾"}</span>
        {S.featureBrief}
      </button>
      {!collapsed && <p>{brief}</p>}
    </div>
  );
}

interface TicketRowProps {
  ticket: TicketView;
  activity: SessionActivity | undefined;
  prs: FeatureView["ticketPrs"][string];
  allPrs: FeatureView["ticketPrs"][string];
  now: number;
  onOpenTicket: (key: string) => void;
  onFix: (stuckSessionId: string) => Promise<void>;
  onDismiss: (stuckSessionId: string) => void;
  reveal: StuckReveal | null;
}

/**
 * ticket 表的一行：状态列显示正在做什么（没有活动就是原来的状态）；卡住时加红点、淡红底色，
 * 红点是按钮，展开紧跟在这一行下面的面板（不进 ticket 页）。
 */
function TicketRow({ ticket: t, activity, prs, allPrs, now, onOpenTicket, onFix, onDismiss, reveal }: TicketRowProps) {
  // 这里的“收起”记号在存储里的意思是“面板展开了”：没有记号（默认）就是关着的。
  const [open, toggle] = useCollapsed(`stuck-open:${t.key}`);
  const live = activity && activity.kind !== "idle" ? activityText(activity, S, now) : null;
  const stuck = activity?.stuck === true ? activity : null;
  // 概览区放不下时面板可能在滚动范围外面。只在用户明确要看时滚过去（点红点、点通知）：
  // 记着“展开”的面板在回到这一页或再次卡住时自己出现，不动用户正在看的位置。
  const panelRow = useRef<HTMLTableRowElement>(null);
  const [dotClicks, setDotClicks] = useState(0);
  // 面板整个放得下就整个显示（nearest）；比概览区还高时 nearest 不会带出底部，按钮在最下面，改成对齐底边。
  const showPanel = () => {
    const row = panelRow.current;
    if (!row) return;
    const port = row.closest(".feature-overview");
    const tall = port !== null && row.getBoundingClientRect().height > port.clientHeight;
    row.scrollIntoView({ block: tall ? "end" : "nearest" });
  };
  useEffect(() => {
    if (dotClicks > 0) showPanel();
  }, [dotClicks]);
  useEffect(() => {
    if (reveal) showPanel();
  }, [reveal]);
  // 点一行进 ticket 页；号码是按钮，键盘也能用（点击冒泡到这一行）。
  return (
    <>
      <tr className={stuck ? "stuck" : undefined} onClick={() => onOpenTicket(t.key)}>
        <td>
          {stuck && (
            <button
              className="stuck-dot"
              title={S.stuckDot}
              aria-label={`${t.key} ${S.stuckDot}`}
              aria-expanded={open}
              onClick={(e) => (e.stopPropagation(), setDotClicks((n) => n + 1), toggle())}
            >
              ●
            </button>
          )}
          <button className="chip">{t.key}</button>
        </td>
        <td className="title">{t.title ?? ""}</td>
        <td className="muted status">
          {live ? (
            <span className="activity">
              <span className="main">{live.main}</span>
              {live.sub && <small title={live.sub}>{live.sub}</small>}
            </span>
          ) : (
            STATUS_LABEL[t.effectiveStatus]
          )}
        </td>
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
      {stuck && open && (
        <tr className="stuck-panel-row" ref={panelRow}>
          <td colSpan={5}>
            <StuckPanel
              activity={stuck}
              onFix={() => onFix(stuck.sessionId)}
              onViewTerminal={() => onOpenTicket(t.key)}
              onDismiss={() => onDismiss(stuck.sessionId)}
              onCollapse={toggle}
            />
          </td>
        </tr>
      )}
    </>
  );
}
