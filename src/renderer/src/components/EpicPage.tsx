import { useState, type ReactNode } from "react";
import type { TurnBoard } from "../../../shared/turn";
import type { EpicView, FeatureView, NowTarget } from "../../../shared/types";
import type { Route } from "../App";
import { api } from "../api";
import { summaryOutcomeIsError, summaryOutcomeMessage } from "../feature-summary-view";
import { runningRows, youCards, type NameCtx } from "../home-view";
import { groupByFeature, scopeTotal, ticketRows } from "../scope-view";
import { S } from "../strings";
import { conversationSessions } from "../ticket-view";
import { ControlConversation } from "./ControlConversation";
import { EpicSummaryTab, type SummaryRunMessage } from "./EpicSummaryTab";
import { epicErrorText, epicOpenError } from "./epic-row";
import { NewFeatureDialog } from "./NewFeatureDialog";
import { PageTabs } from "./PageTabs";
import { ControlSplit, ScopeOverview, ScopeRunning, ScopeTicketTable } from "./ScopeParts";
import { useTurnBoard } from "./useTurnBoard";
import { SessionArea, useSessionPanes, WorkspaceHeader } from "./WorkspaceParts";

interface Props {
  epic: EpicView;
  /** 这个 epic 下没归档的 feature（App 传）：「全部 ticket」按它们分组。 */
  features: FeatureView[];
  onOpenFeature: (id: number) => void;
  onOpenTicket: (key: string) => void;
  /** 新建的 feature：重读列表后跳过去。 */
  onFeatureCreated: (id: number) => void;
  /** 打开时先切到「总控」页签、看这个 session 的终端（从首页点进来时）。 */
  focusSession?: string | null;
  /** 概况里的卡片「去看看」：落到那一页的那个 session。 */
  onOpenTarget: (t: NowTarget) => void;
  /** 概况里的卡片要的名字、开修复 session 和跳转（同首页）。 */
  ctx: NameCtx;
  onFix: (featureId: number, sessionId: string) => void;
  onGo: (r: Route) => void;
}

/**
 * epic 页（UI 重做第 3 层，spec §5.2）：标题栏下五个页签——概况、进行中、全部 ticket、总控（终端和对话）、AI 总结。
 * 前三个共用一份 turn:board（只按这个 epic 取）。
 */
export function EpicPage({ epic, features, onOpenFeature, onOpenTicket, onFeatureCreated, focusSession, onOpenTarget, ctx, onFix, onGo }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newFeature, setNewFeature] = useState(false);
  const errorText = (e: unknown) => epicErrorText(e, S);
  const showError = (e: unknown) => setError(errorText(e));
  const panes = useSessionPanes(epic.sessions, {
    openSession: (sessionId) => api.openEpicSession({ epicId: epic.id, sessionId }),
    openFailure: (reason) => epicOpenError(reason, S),
    errorText,
    setError,
    initialActive: focusSession,
  });
  /** 落到「总控」页签：n 递增，同一个页签也能再落一次。点进来要看某个 epic session 时先落一次（useSessionPanes 已经切到它的终端）。 */
  const [control, setControl] = useState<number | null>(() => (focusSession && epic.sessions.some((s) => s.id === focusSession) ? 0 : null));
  /** 概况卡片「去看看」：这个 epic 自己的 session 就地切到「总控」看它的终端（终端关着就打开）；别的 session 跳到它的页面。 */
  const openTarget = (t: NowTarget) => {
    if (t.page !== "epic" || t.id !== epic.id || t.sessionId === null) return onOpenTarget(t);
    setControl((n) => (n ?? 0) + 1);
    const termId = epic.sessions.find((s) => s.id === t.sessionId)?.termId;
    if (termId) panes.show(termId);
    else void panes.open(t.sessionId);
  };
  const turn = useTurnBoard({ epicId: epic.id });
  const board = turn.board;
  const live = epic.features.filter((f) => f.status !== "archived");
  const now = Date.now();
  const running = board === null ? null : runningRows(board.items, S, now);
  const tickets = features.flatMap((f) => f.tickets);
  const youItems = board === null ? [] : youCards(board.items);

  /** 看板还没取到时是骨架（不闪空状态）；取不到就说为什么（board-error：和页面的 .error 分开，不会同时被找到）。 */
  const withBoard = (render: (b: TurnBoard) => ReactNode): ReactNode => {
    if (board !== null) return render(board);
    if (turn.error !== null) return <p className="board-error">{turn.error}</p>;
    return <div className="scope-overview" aria-busy="true"><p className="muted">…</p></div>;
  };

  const runSummary = (featureId: number): Promise<SummaryRunMessage> =>
    api.runFeatureSummary(featureId).then(
      (o) => ({ text: summaryOutcomeMessage(o), bad: summaryOutcomeIsError(o) }),
      (e: unknown) => ({ text: errorText(e), bad: true }),
    );

  return (
    <div className="ticket-page epic-page">
      <WorkspaceHeader
        name={epic.name}
        nameLabel={S.epicName}
        workspaceDir={epic.workspaceDir}
        onRename={(name) => api.renameEpic(epic.id, name)}
        archiveLabel={S.archiveEpic}
        archivingLabel={live.length > 0 ? S.archivingSummaries : S.archiving}
        onArchive={() => api.archiveEpic(epic.id)}
        onError={showError}
      />
      {/* 页面的错误（改名、归档、打开 session）放在页签外面：停在哪个页签都看得到。 */}
      {error && <p className="error">{error}</p>}

      <PageTabs
        page={`epic:${epic.id}`}
        defaultTab="overview"
        forceTab={control === null ? null : "control"}
        forceSeq={control ?? undefined}
        actions={<button onClick={() => setNewFeature(true)}>+ {S.newFeature}</button>}
        tabs={[
          {
            id: "overview", label: S.lay.tabOverview, className: youItems.length > 0 ? "attention" : undefined,
            content: withBoard((b) => (
              <ScopeOverview
                rows={b.scopes.filter((r) => r.kind === "feature")}
                total={scopeTotal(b.scopes, "epic", epic.id)}
                youItems={youItems}
                kind="epic"
                emptyText={S.noEpicFeatures}
                cards={{ ctx, now, onFix, onOpen: openTarget, onGo, onChanged: turn.reload }}
                onOpenRow={(id) => onOpenFeature(Number(id))}
                onCreate={() => setNewFeature(true)}
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
            label: <>{S.lay.tabTickets}<span className="muted">{tickets.length}</span></>,
            content: withBoard((b) => (
              <ScopeTicketTable
                groups={groupByFeature(ticketRows(tickets, b.items), features).map((g) => ({ name: g.feature.name, merged: g.merged, total: g.rows.length, rows: g.rows }))}
                onOpenTicket={onOpenTicket}
                emptyText={S.noEpicFeatures}
              />
            )),
          },
          {
            id: "control", label: S.lay.tabControl,
            content: (
              <ControlSplit
                left={
                  <SessionArea
                    repos={epic.repos}
                    reposHint={S.epicReposHint}
                    onAddRepo={(path) => api.addEpicRepo(epic.id, path)}
                    onRemoveRepo={(id) => api.removeEpicRepo(id)}
                    sessions={epic.sessions}
                    hiddenSessions={epic.hiddenSessions}
                    panes={panes}
                    placeOf={() => S.epicSession}
                    noSessions={S.noEpicSessions}
                    newSession={S.newEpicSession}
                    newSessionHint={S.epicSessionHint}
                    error={null}
                    onError={showError}
                  />
                }
                right={<ControlConversation scope={{ epicId: epic.id }} rootSessionId={null} sessions={conversationSessions(epic.sessions, S)} />}
              />
            ),
          },
          { id: "summary", label: S.lay.tabSummary, content: <EpicSummaryTab rows={live} onRun={runSummary} /> },
        ]}
      />
      {newFeature && (
        <NewFeatureDialog
          epicId={epic.id}
          onClose={() => setNewFeature(false)}
          onCreated={(id) => (setNewFeature(false), onFeatureCreated(id))}
        />
      )}
    </div>
  );
}
