import { useEffect, useState, type ReactNode } from "react";
import type { TurnBoard } from "../../../shared/turn";
import type { EpicView, FeatureView, NowTarget } from "../../../shared/types";
import type { Route } from "../App";
import { api, ButlerError } from "../api";
import { summaryOutcomeIsError, summaryOutcomeMessage } from "../feature-summary-view";
import { runningRows, youCards, type NameCtx } from "../home-view";
import { scopeTotal, ticketRows } from "../scope-view";
import { S } from "../strings";
import { conversationSessions } from "../ticket-view";
import { ControlConversation } from "./ControlConversation";
import type { SummaryRunMessage } from "./EpicSummaryTab";
import { FeatureSummaryTab } from "./FeatureSummaryTab";
import { NewTicketDialog } from "./NewTicketDialog";
import { PageTabs } from "./PageTabs";
import { ControlSplit, ScopeOverview, ScopeRunning, ScopeTicketTable } from "./ScopeParts";
import { useTurnBoard } from "./useTurnBoard";
import { SessionArea, useSessionPanes, WorkspaceHeader } from "./WorkspaceParts";

interface Props {
  feature: FeatureView;
  /** 可以移进去的 epic（未归档的）。 */
  epics: EpicView[];
  onOpenTicket: (key: string) => void;
  /** 新建的 ticket：重读列表后跳过去。 */
  onTicketCreated: (key: string) => void;
  /** 打开时先切到「总控」页签、看这个 session 的终端（从首页点进来、或刚开好修复 session 时）。 */
  focusSession?: string | null;
  /** "control"：直接落到「总控」页签（App 开好修复 session 后带过来）。 */
  landing?: "control";
  /** 概况里的卡片「去看看」：落到那一页的那个 session。 */
  onOpenTarget: (t: NowTarget) => void;
  /** 概况里的卡片要的名字、开修复 session 和跳转（同首页）。 */
  ctx: NameCtx;
  onFix: (featureId: number, sessionId: string) => void;
  onGo: (r: Route) => void;
}

const errorText = (e: unknown) => (e instanceof ButlerError ? (S.createErrors[e.code] ?? e.message) : (e as Error).message);

/**
 * feature 页（UI 重做第 3 层，spec §5.2）：标题栏下五个页签——概况、进行中、全部 ticket、总控（终端和对话）、AI 总结。
 * 同 epic 页，范围小一层；前三个共用一份 turn:board（只按这个 feature 取）。
 */
export function FeaturePage({ feature, epics, onOpenTicket, onTicketCreated, focusSession, landing, onOpenTarget, ctx, onFix, onGo }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newTicket, setNewTicket] = useState(false);
  const showError = (e: unknown) => setError(errorText(e));
  const panes = useSessionPanes(feature.sessions, {
    openSession: (sessionId) => api.openFeatureSession({ featureId: feature.id, sessionId }),
    openFailure: (reason) => S.openErrors[reason] ?? reason,
    errorText,
    setError,
    initialActive: focusSession,
  });
  /** 落到「总控」页签：n 递增，同一个页签也能再落一次。带着 landing 或这个 feature 的 session 进来时先落一次。 */
  const [control, setControl] = useState<number | null>(() =>
    landing === "control" || (focusSession && feature.sessions.some((s) => s.id === focusSession)) ? 0 : null);
  const toControl = () => setControl((n) => (n ?? 0) + 1);
  // App 开好修复 session 后带着 landing 和它的终端回到这一页（页面可能一直开着、不重新挂载）：切到「总控」看那个终端。
  // 修复 session 可能还没出现在 feature.sessions 里（列表还没刷新），所以直接按终端 id 切。
  useEffect(() => {
    if (landing !== "control") return;
    toControl();
    if (focusSession) panes.show(focusSession);
  }, [landing, focusSession]);
  /** 概况卡片「去看看」：这个 feature 自己的 session 就地切到「总控」看它的终端（终端关着就打开）；别的 session 跳到它的页面。 */
  const openTarget = (t: NowTarget) => {
    if (t.page !== "feature" || t.id !== feature.id || t.sessionId === null) return onOpenTarget(t);
    toControl();
    const termId = feature.sessions.find((s) => s.id === t.sessionId)?.termId;
    if (termId) panes.show(termId);
    else void panes.open(t.sessionId);
  };
  /**
   * 卡片「开修复 session」：App 开好后带着 landing 回到这一页。人已经在这一页、修复 session 早就开着时 App 给的路由不变，
   * 上面的 effect 不会再跑，所以这里先切到「总控」，那个修复 session 开着就直接切到它的终端。
   */
  const fix = (featureId: number, stuckSessionId: string) => {
    onFix(featureId, stuckSessionId);
    if (featureId !== feature.id) return;
    toControl();
    const termId = feature.sessions.find((s) => s.fixesSession === stuckSessionId)?.termId;
    if (termId) panes.show(termId);
  };

  const turn = useTurnBoard({ featureId: feature.id });
  const board = turn.board;
  const now = Date.now();
  const running = board === null ? null : runningRows(board.items, S, now);
  const youItems = board === null ? [] : youCards(board.items);
  const blockers = feature.summary?.payload?.blockers.length ?? 0;
  // 修复 session 的名字带上它修的那个 ticket（从卡住的 session 反查）。
  const fixedTicket = (stuckId: string) => feature.tickets.find((t) => [...t.sessions, ...t.hiddenSessions].some((x) => x.id === stuckId))?.key ?? null;

  /** 看板还没取到时是骨架（不闪空状态）；取不到就说为什么（board-error：和页面的 .error 分开，不会同时被找到）。 */
  const withBoard = (render: (b: TurnBoard) => ReactNode): ReactNode => {
    if (board !== null) return render(board);
    if (turn.error !== null) return <p className="board-error">{turn.error}</p>;
    return <div className="scope-overview" aria-busy="true"><p className="muted">…</p></div>;
  };

  const runSummary = (): Promise<SummaryRunMessage> =>
    api.runFeatureSummary(feature.id).then(
      (o) => ({ text: summaryOutcomeMessage(o), bad: summaryOutcomeIsError(o) }),
      (e: unknown) => ({ text: errorText(e), bad: true }),
    );

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
      {/* 页面的错误（改名、归档、移动、打开 session）放在页签外面：停在哪个页签都看得到。 */}
      {error && <p className="error">{error}</p>}

      <PageTabs
        page={`feature:${feature.id}`}
        defaultTab="overview"
        forceTab={control === null ? null : "control"}
        forceSeq={control ?? undefined}
        actions={<button onClick={() => setNewTicket(true)}>+ {S.newTicket}</button>}
        tabs={[
          {
            id: "overview", label: S.lay.tabOverview, className: youItems.length > 0 ? "attention" : undefined,
            content: withBoard((b) => (
              <ScopeOverview
                rows={b.scopes.filter((r) => r.kind === "ticket")}
                total={scopeTotal(b.scopes, "feature", feature.id)}
                youItems={youItems}
                kind="feature"
                emptyText={S.noFeatureTickets}
                cards={{ ctx, now, onFix: fix, onOpen: openTarget, onGo, onChanged: turn.reload }}
                onOpenRow={(id) => onOpenTicket(String(id))}
                onCreate={() => setNewTicket(true)}
              />
            )),
          },
          {
            id: "running",
            label: <>{S.lay.tabRunning}{running && <span className="muted">{running.length}</span>}</>,
            content: withBoard(() => <ScopeRunning rows={running ?? []} onOpenTicket={onOpenTicket} />),
          },
          {
            id: "tickets",
            label: <>{S.lay.tabTickets}<span className="muted">{feature.tickets.length}</span></>,
            content: withBoard((b) => {
              // 平铺，不分组：只有一组，没有组名。
              const rows = ticketRows(feature.tickets, b.items);
              const groups = rows.length === 0 ? [] : [{ name: null, merged: rows.filter((r) => r.turn.owner === "done").length, total: rows.length, rows }];
              return <ScopeTicketTable groups={groups} onOpenTicket={onOpenTicket} emptyText={S.noFeatureTickets} />;
            }),
          },
          {
            id: "control", label: S.lay.tabControl,
            content: (
              <ControlSplit
                left={
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
                    error={null}
                    onError={showError}
                  />
                }
                right={<ControlConversation scope={{ featureId: feature.id }} rootSessionId={null} sessions={conversationSessions(feature.sessions, S)} />}
              />
            ),
          },
          {
            id: "summary",
            label: <>{S.lay.tabSummary}{blockers > 0 && <span className="blocker">{S.featureBlockedCount(blockers)}</span>}</>,
            content: <FeatureSummaryTab feature={feature} onOpenTicket={onOpenTicket} onRun={runSummary} />,
          },
        ]}
      />
      {newTicket && (
        <NewTicketDialog
          feature={feature}
          onClose={() => setNewTicket(false)}
          onRestored={(key) => (setNewTicket(false), onTicketCreated(key))}
          onCreated={(key) => (setNewTicket(false), onTicketCreated(key))}
        />
      )}
    </div>
  );
}
