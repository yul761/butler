import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { NowTarget, OpenSessionRequest } from "../../shared/types";
import { api } from "./api";
import { onError, reportError } from "./errors";
import { firstRunProps, homeOpenedSignal } from "./home-view";
import { fixLanding, missingTicket, routeGone } from "./route-view";
import { ArchivedPage } from "./components/ArchivedPage";
import { AuditPage } from "./components/AuditPage";
import { ShipherdPage } from "./components/ShipherdPage";
import { NewFeatureDialog } from "./components/NewFeatureDialog";
import { FirstRunHome } from "./components/FirstRunHome";
import { useTurnBoard } from "./components/useTurnBoard";
import { EffectPage } from "./components/EffectPage";
import { UpdateBanner } from "./components/UpdateBanner";
import { SettingsPage } from "./components/SettingsPage";
import { sameDots, scopeDots, type Dot } from "./sidebar-view";
import { LessonsPage } from "./components/LessonsPage";
import { Wizard } from "./components/Wizard";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { onOpenFeedback, openFeedback, type FeedbackRequest } from "./feedback-bus";
import { S } from "./strings";
import { onboardingReducer } from "./wizard";
import type { SettingsSection } from "../../shared/settings-layout";
import type { Turn } from "../../shared/turn";
import { createLiveStore, LiveStoreContext, selectAllTickets } from "./live-store";
import { LiveAllWorkPage, LiveFeatureRoute, LiveHomePage, LiveNewTicketDialog, LiveSidebar, LiveTicketRoute, LiveUnclaimedPage } from "./components/live-pages";

export type Route =
  | { page: "home" }
  /** landing：从卡片的「去看看」进来时那张卡片的轮次，TicketPage 按它落到对应的页签（landingTab）。 */
  | { page: "ticket"; key: string; landing?: Turn }
  /**
   * focusSession：从「现在」页点进来时先切到的那个 session 的终端。
   * landing "control"：刚开好修复 session（fixLanding），落到「总控」页签看 focusTerm 那个终端；landingSeq 每次开都递增，页面已经开着也会再落一次。
   */
  | { page: "feature"; id: number; focusSession?: string | null; landing?: "control"; focusTerm?: string | null; landingSeq?: number }
  /** Shipherd 总控（BTL-190 第 5 点）。 */
  | { page: "shipherd"; focusSession?: string | null }
  /** 效果与花费页。 */
  | { page: "effect" }
  /** 全部工作（UI 重做第 2 层）；section：从提醒跳来时要展开的那一块。 */
  | { page: "all"; section?: "stacks" | "intake" }
  | { page: "unclaimed" }
  | { page: "archived" }
  /** section：要看的那个 tab 或高级里的分组（首页的提醒跳来时用 health / routing）。 */
  | { page: "settings"; section?: SettingsSection; /** 每次从菜单打开都换一个：已经在设置页别的 tab 上也切过去。 */ nonce?: number }
  | { page: "audit" }
  /** tab：从「现在」页的检查升降级提醒跳来时直接打开检查标签。 */
  | { page: "lessons"; tab?: "checks" };

export function App() {
  const [route, setRoute] = useState<Route>({ page: "home" });
  // 切到首页时告诉第 1 层一次（它按需补查「请你 review」）；规则和测试在 homeOpenedSignal。失败第 1 层自己记日志，这里不提示。
  const homeOpened = useRef(homeOpenedSignal());
  useEffect(() => {
    if (homeOpened.current.observe(route.page)) api.turnHomeOpened().catch(() => undefined);
  }, [route.page]);
  /**
   * ticket、feature 列表和「运行情况」放在 store 里（BTL-277）：App 不订阅它们，页面和侧栏各自只订自己用的那一块，
   * hook 事件一来不再整棵树重画。跳转、打开时要的最新列表从 live.getState() 读。
   */
  const [live] = useState(() => createLiveStore(api, { onError: reportError }));
  const routeRef = useRef(route);
  routeRef.current = route;
  const [showNewFeature, setShowNewFeature] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 跳到 ticket 页时要在那里执行的打开请求（执行一次后清空）。 */
  const [pendingOpen, setPendingOpen] = useState<OpenSessionRequest | null>(null);

  const [onboarding, dispatchOnboarding] = useReducer(onboardingReducer, null);
  /** 首页、侧栏、全部工作共用的一份「谁该动」（第 1 层的 turn:board）。 */
  const turn = useTurnBoard();

  useEffect(() => onError(setError), []);
  // 防休眠开关：托盘菜单里改了、或者合上盖子自动关掉，主进程都会通知。
  useEffect(() => {
    api.keepAwake().then(setKeepAwake, reportError);
    return api.onKeepAwakeChanged(setKeepAwake);
  }, []);
  /**
   * 发送反馈（BTL-254）：菜单、设置「关于」、向导失败的步骤都打开这一个对话框。
   * 应用菜单（BTL-253 / 254）：「检查更新…」在主进程查，这里打开设置 › 关于看结果；「发送反馈…」打开反馈对话框。
   */
  const [feedback, setFeedback] = useState<FeedbackRequest | null>(null);
  useEffect(() => {
    const off = onOpenFeedback(setFeedback);
    const offMenu = api.onAppMenu((action) => {
      if (action === "checkUpdates") setRoute({ page: "settings", section: "about", nonce: Date.now() });
      else if (action === "sendFeedback") openFeedback();
    });
    return () => {
      off();
      offMenu();
    };
  }, []);
  const refresh = live.refresh;
  // 向导状态只在启动时读一次；之后由“重新运行”和“完成/跳过”直接改变，不随每次 state-changed 重读。
  useEffect(() => {
    api.settings().then(
      (settings) => dispatchOnboarding({ type: "loaded", settings }),
      (e) => {
        reportError(e);
        dispatchOnboarding({ type: "loadFailed" });
      },
    );
  }, []);

  // 读一次，之后跟着 state:changed 防抖重读（规矩和测试在 live-store）。
  useEffect(() => live.start(), [live]);

  // 归档可能要等两分钟：等完时用户在看别的页面就留在那里；在看的页面跟着归档了（ticket 跟着 feature）就回首页，不留空白；
  // 路由停在这一版已经没有的页面（旧版本留下的）也回首页。
  // 只在列表变了时检查，不看 route：跳转时列表可能还没刷新（刷新被新的一次顶掉时），这时对象并没有消失。
  // 在 store 更新的当下查（在重画之前）：空白不画出来。
  useLayoutEffect(() => {
    let prev = live.getState();
    return live.subscribe(() => {
      const s = live.getState();
      if (s.tickets === prev.tickets && s.features === prev.features) return;
      prev = s;
      if (routeGone(routeRef.current, selectAllTickets(s), s.features)) setRoute({ page: "home" });
    });
  }, [live]);

  // 下面这些回调都是稳定的（BTL-277）：首页的卡片、行是 memo 的，回调每次换新就白 memo 了。
  /** 跳到 ticket 页；req 是到了那里要打开（已经开着就切过去）的 session。 */
  const openTicket = useCallback((key: string, req?: OpenSessionRequest) => {
    // 要去的 ticket 可能已经归档：不跳到空白页，也不留下悬空的打开请求。
    if (missingTicket({ page: "ticket", key }, selectAllTickets(live.getState())) !== null) {
      reportError(new Error(S.ticketMissing(key)));
      return;
    }
    setPendingOpen(req ?? null);
    setRoute({ page: "ticket", key });
  }, [live]);
  const openTicketOnly = useCallback((key: string) => openTicket(key), [openTicket]);
  /** 卡片的「去看看」等跳转：去 ticket 页时同 openTicket，先看它还在不在。 */
  const go = useCallback((r: Route) => {
    const gone = missingTicket(r, selectAllTickets(live.getState()));
    if (gone !== null) reportError(new Error(S.ticketMissing(gone)));
    else setRoute(r);
  }, [live]);

  /** 「现在」页的一行点开：ticket 走 openTicket（切到那个终端）；feature 页打开时先看那个 session 的终端。 */
  const openTarget = useCallback((t: NowTarget) => {
    if (t.page === "ticket") openTicket(t.key, t.sessionId ? { ticketKey: t.key, sessionId: t.sessionId } : undefined);
    else if (t.page === "shipherd") setRoute({ page: "shipherd", focusSession: t.sessionId });
    else if (t.page === "feature") setRoute({ page: "feature", id: t.id, focusSession: t.sessionId });
    // 别的（旧版本主进程给的、这一版已经没有的页面）不跳。
  }, [openTicket]);

  // 恢复归档：先重读列表再跳过去，否则 ticket 页找不到它。
  const showRestored = useCallback((key: string) => {
    setShowNew(false);
    void refresh().then((ok) => ok && setRoute({ page: "ticket", key }));
  }, [refresh]);

  const goTicket = useCallback((key: string) => void refresh().then(() => setRoute({ page: "ticket", key })), [refresh]);
  const goFeature = useCallback((id: number) => void refresh().then(() => setRoute({ page: "feature", id })), [refresh]);

  // 点的内容没变就留着旧的 Map（BTL-277）：侧栏是 memo 的。
  const lastDots = useRef<Map<string, Dot> | null>(null);
  const dots = useMemo(() => {
    const next = scopeDots(turn.board?.items ?? []);
    if (lastDots.current && sameDots(lastDots.current, next)) return lastDots.current;
    return (lastDots.current = next);
  }, [turn.board]);
  const onKeepAwake = useCallback((on: boolean) => void api.setKeepAwake(on).then(setKeepAwake, reportError), []);
  /** 「开修复 session」（首页、ticket 页、feature 页的卡片）：开好了去 feature 页的「总控」看它的终端（修复 session 在那里），失败报到全局错误条。 */
  const fixSeq = useRef(0);
  const openFix = useCallback((featureId: number, stuckSessionId: string) => {
    api.openFixSession({ featureId, stuckSessionId }).then((r) => {
      if (r.ok) setRoute(fixLanding(featureId, r.termId, ++fixSeq.current));
      else reportError(new Error(S.openErrors[r.reason] ?? r.reason));
    }, reportError);
  }, []);
  const onNewTicket = useCallback(() => setShowNew(true), []);
  const onNewFeature = useCallback(() => setShowNewFeature(true), []);
  const onResumeSetup = useCallback(() => dispatchOnboarding({ type: "rerun" }), []);
  const firstRun = useMemo(() => <FirstRunHome {...firstRunProps({ onNewTicket, onNewFeature, onGo: go })} />, [onNewTicket, onNewFeature, go]);

  return (
    <LiveStoreContext.Provider value={live}>
    <div className="app">
      <LiveSidebar
        youCount={turn.board?.counts.you ?? null} dots={dots} route={route} onNavigate={setRoute}
        keepAwake={keepAwake} onKeepAwake={onKeepAwake}
      />
      <main className="main">
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>{S.close}</button>
          </div>
        )}
        <UpdateBanner />
        {onboarding === null ? null : onboarding ? (
          <Wizard
            onDone={() => {
              dispatchOnboarding({ type: "finished" });
              setRoute({ page: "home" });
            }}
          />
        ) : (
          <>
            {route.page === "home" && (
              <LiveHomePage
                state={turn} firstRun={firstRun}
                onFix={openFix} onOpen={openTarget} onGo={go} onOpenTicket={openTicketOnly} onChanged={turn.reload}
                onResumeSetup={onResumeSetup}
              />
            )}
            {route.page === "ticket" && (
              <LiveTicketRoute
                key={route.key}
                ticketKey={route.key}
                initialOpen={pendingOpen?.ticketKey === route.key ? pendingOpen : null}
                onInitialOpenDone={() => setPendingOpen(null)}
                landing={route.landing}
                onFix={openFix}
                onArchived={() => setRoute({ page: "home" })}
                onOpenFeature={(id) => setRoute({ page: "feature", id })}
              />
            )}
            {route.page === "feature" && (
              <LiveFeatureRoute
                key={route.id}
                featureId={route.id}
                onOpenTicket={openTicketOnly}
                onTicketCreated={goTicket}
                focusSession={route.focusSession}
                landing={route.landing}
                focusTerm={route.focusTerm}
                landingSeq={route.landingSeq}
                onOpenTarget={openTarget}
                onFix={openFix}
                onGo={go}
              />
            )}
            {route.page === "shipherd" && <ShipherdPage key={route.focusSession ?? ""} focusSession={route.focusSession} />}
            {route.page === "all" && (
              <LiveAllWorkPage
                key={route.section ?? ""}
                board={turn.board}
                focusMore={route.section}
                onNewTicket={onNewTicket}
                onNewFeature={onNewFeature}
                onGo={go}
                onOpenTicket={openTicketOnly}
              />
            )}
            {route.page === "effect" && <EffectPage />}
            {route.page === "unclaimed" && <LiveUnclaimedPage />}
            {route.page === "archived" && <ArchivedPage onRestored={showRestored} onFeatureRestored={goFeature} />}
            {route.page === "settings" && <SettingsPage section={route.section} nonce={route.nonce} onRerunWizard={() => dispatchOnboarding({ type: "rerun" })} />}
            {route.page === "audit" && <AuditPage />}
            {route.page === "lessons" && <LessonsPage tab={route.tab} onOpenSession={(id) => setRoute({ page: "shipherd", focusSession: id })} />}
          </>
        )}
      </main>
      {showNewFeature && (
        <NewFeatureDialog
          onClose={() => setShowNewFeature(false)}
          onCreated={(id) => {
            setShowNewFeature(false);
            goFeature(id);
          }}
        />
      )}
      {showNew && (
        <LiveNewTicketDialog
          onClose={() => setShowNew(false)}
          onRestored={showRestored}
          onCreated={(key) => {
            setShowNew(false);
            // 先重读列表再跳过去，免得 ticket 页一闪而过的空白。
            void refresh().then(() => setRoute({ page: "ticket", key }));
          }}
        />
      )}
      {feedback && <FeedbackDialog key={`${feedback.kind ?? ""}:${feedback.step ?? ""}`} request={feedback} onClose={() => setFeedback(null)} />}
    </div>
    </LiveStoreContext.Provider>
  );
}
