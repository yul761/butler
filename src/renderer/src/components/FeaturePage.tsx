import { useEffect, useState } from "react";
import type { FeatureView, NowTarget } from "../../../shared/types";
import type { Route } from "../App";
import { api, ShipherdError } from "../api";
import { summaryOutcomeIsError, summaryOutcomeMessage } from "../feature-summary-view";
import type { NameCtx } from "../home-view";
import { blockGroups, scopeBoardView, scopeTotal, ticketRows, ticketsWithPr } from "../scope-view";
import { S } from "../strings";
import { conversationSessions, defaultConvRoot } from "../ticket-view";
import { ControlConversation } from "./ControlConversation";
import { Messages } from "./MessageList";
import { InfoFlowPanel } from "./InfoFlow";
import { FeatureSummaryTab, type SummaryRunMessage } from "./FeatureSummaryTab";
import { EpicLevel } from "./EpicLevel";
import { NewTicketDialog } from "./NewTicketDialog";
import { PageTabs } from "./PageTabs";
import { ControlSplit, ScopeBoard, ScopeOverview, ScopeRunning, ScopeTicketTable } from "./ScopeParts";
import { useNow } from "./TicketActivity";
import { useTurnBoard } from "./useTurnBoard";
import { SessionArea, useSessionPanes, WorkspaceHeader } from "./WorkspaceParts";

interface Props {
  feature: FeatureView;
  onOpenTicket: (key: string) => void;
  /** 新建的 ticket：重读列表后跳过去。 */
  onTicketCreated: (key: string) => void;
  /** 打开时先切到「总控」页签、看这个 session 的终端（从首页点进来时）。 */
  focusSession?: string | null;
  /** "control"：落到「总控」页签、看 focusTerm 那个终端（App 开好修复 session 后带过来，见 fixLanding）；landingSeq 变了就再落一次。 */
  landing?: "control";
  focusTerm?: string | null;
  landingSeq?: number;
  /** 概况里的卡片「去看看」：落到那一页的那个 session。 */
  onOpenTarget: (t: NowTarget) => void;
  /** 概况里的卡片要的名字、开修复 session 和跳转（同首页）。 */
  ctx: NameCtx;
  onFix: (featureId: number, sessionId: string) => void;
  onGo: (r: Route) => void;
}

const errorText = (e: unknown) => (e instanceof ShipherdError ? (S.createErrors[e.code] ?? e.message) : (e as Error).message);

/**
 * feature 页（UI 重做第 3 层，spec §5.2）：标题栏下五个页签——概况、进行中、全部 ticket、总控（终端和对话）、AI 总结。
 * 前三个共用一份 turn:board（只按这个 feature 取）。
 */
export function FeaturePage({ feature, onOpenTicket, onTicketCreated, focusSession, landing, focusTerm, landingSeq, onOpenTarget, ctx, onFix, onGo }: Props) {
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
  // App 开好修复 session 后（openFixSession 已经返回）带着 landing 和它的终端回到这一页；页面可能一直开着、不重新挂载，
  // 所以按 landingSeq 每次都落：切到「总控」，有终端就切过去。修复 session 可能还没出现在 feature.sessions 里（列表还没刷新），直接按终端 id 切。
  useEffect(() => {
    if (landing !== "control") return;
    toControl();
    if (focusTerm) panes.show(focusTerm);
  }, [landing, focusTerm, landingSeq]);
  /** 概况卡片「去看看」：这个 feature 自己的 session 就地切到「总控」看它的终端（终端关着就打开）；别的 session 跳到它的页面。 */
  const openTarget = (t: NowTarget) => {
    if (t.page !== "feature" || t.id !== feature.id || t.sessionId === null) return onOpenTarget(t);
    toControl();
    panes.reveal(t.sessionId);
  };
  const turn = useTurnBoard({ featureId: feature.id });
  const board = turn.board;
  // 定时走（BTL-277：页面不再跟着每次列表刷新重画，「多久了」要自己往前走）。
  const now = useNow();
  // 卡片、标红和「进行中」按 ticket 级的轮次（同首页、同「全部 ticket」表格）。
  const view = board === null ? null : scopeBoardView(board.items, S, now);
  const running = view?.running ?? null;
  const youItems = view?.youItems ?? [];
  const blockers = feature.summary?.payload?.blockers.length ?? 0;
  // 修复 session 的名字带上它修的那个 ticket（从卡住的 session 反查）。
  const fixedTicket = (stuckId: string) => feature.tickets.find((t) => [...t.sessions, ...t.hiddenSessions].some((x) => x.id === stuckId))?.key ?? null;

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
        archivingLabel={S.archiving}
        onArchive={() => api.archiveFeature(feature.id)}
        onError={showError}
      >
        <EpicLevel featureId={feature.id} value={feature.automationLevel} onError={showError} />
      </WorkspaceHeader>
      {/* 页面的错误（改名、归档、打开 session）放在页签外面：停在哪个页签都看得到。 */}
      {error && <p className="error">{error}</p>}

      <PageTabs
        page={`feature:${feature.id}`}
        defaultTab="overview"
        forceTab={control === null ? null : "control"}
        forceSeq={control ?? undefined}
        actions={<button onClick={() => setNewTicket(true)}>+ {S.newTicket}</button>}
        tabs={[
          {
            id: "overview", label: S.lay.tabOverview, className: view?.attention ? "attention" : undefined,
            content: <ScopeBoard turn={turn}>{(b) => (
              <ScopeOverview
                rows={b.scopes.filter((r) => r.kind === "ticket")}
                total={scopeTotal(b.scopes, "feature", feature.id)}
                youItems={youItems}
                ticketsWithPr={ticketsWithPr(b.items)}
                kind="feature"
                emptyText={S.noFeatureTickets}
                cards={{ ctx, now, onFix, onOpen: openTarget, onGo, onChanged: turn.reload }}
                onOpenRow={(id) => onOpenTicket(String(id))}
                blocks={blockGroups(feature.blocks, feature.tickets, ticketRows(feature.tickets, b.items), S)}
                onOpenTicket={onOpenTicket}
                onCreate={() => setNewTicket(true)}
              />
            )}</ScopeBoard>,
          },
          {
            id: "running",
            label: <>{S.lay.tabRunning}{running && <span className="muted">{running.length}</span>}</>,
            content: <ScopeBoard turn={turn}>{() => <ScopeRunning rows={running ?? []} onOpenTicket={onOpenTicket} />}</ScopeBoard>,
          },
          {
            id: "tickets",
            label: <>{S.lay.tabTickets}<span className="muted">{feature.tickets.length}</span></>,
            content: (
              <ScopeBoard turn={turn}>
                {(b) => <ScopeTicketTable groups={blockGroups(feature.blocks, feature.tickets, ticketRows(feature.tickets, b.items), S)} onOpenTicket={onOpenTicket} emptyText={S.noFeatureTickets} />}
              </ScopeBoard>
            ),
          },
          {
            id: "control", label: S.lay.tabControl,
            content: (
              <ControlSplit
                page="feature"
                lede={S.lay.ctlLede}
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
                right={<ControlConversation scope={{ featureId: feature.id }} rootSessionId={defaultConvRoot(feature.sessions)} sessions={conversationSessions(feature.sessions, S)} footer={<Messages scope={{ featureId: feature.id }} />} />}
              />
            ),
          },
          {
            id: "summary",
            label: <>{S.lay.tabSummary}{blockers > 0 && <span className="blocker">{S.featureBlockedCount(blockers)}</span>}</>,
            content: <FeatureSummaryTab feature={feature} onOpenTicket={onOpenTicket} onRun={runSummary} />,
          },
          // 信息流转（BTL-272）：这个 epic 的对话里抽出来的要点、发给了谁、同步了什么。
          { id: "infoflow", label: S.infoflow.tab, content: <InfoFlowPanel scope={{ featureId: feature.id }} /> },
        ]}
      />
      {newTicket && (
        <NewTicketDialog
          feature={feature}
          contextTickets={feature.tickets}
          takenKeys={[...ctx.tickets.keys()]}
          onClose={() => setNewTicket(false)}
          onRestored={(key) => (setNewTicket(false), onTicketCreated(key))}
          onCreated={(key) => (setNewTicket(false), onTicketCreated(key))}
        />
      )}
    </div>
  );
}
