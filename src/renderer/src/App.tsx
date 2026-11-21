import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FeatureView, NowTarget, NowView, OpenSessionRequest, TicketView } from "../../shared/types";
import { api } from "./api";
import { onError, reportError } from "./errors";
import { firstRunProps, homeOpenedSignal, isNoWork, type NameCtx } from "./home-view";
import { fixLanding, missingTicket, routeGone } from "./route-view";
import { ArchivedPage } from "./components/ArchivedPage";
import { AuditPage } from "./components/AuditPage";
import { ButlerPage } from "./components/ButlerPage";
import { FeaturePage } from "./components/FeaturePage";
import { NewFeatureDialog } from "./components/NewFeatureDialog";
import { NewTicketDialog } from "./components/NewTicketDialog";
import { AllWorkPage } from "./components/AllWorkPage";
import { HomePage } from "./components/HomePage";
import { FirstRunHome } from "./components/FirstRunHome";
import { useTurnBoard } from "./components/useTurnBoard";
import { EffectPage } from "./components/EffectPage";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { scopeDots } from "./sidebar-view";
import { TicketPage } from "./components/TicketPage";
import { LessonsPage } from "./components/LessonsPage";
import { UnclaimedPage } from "./components/UnclaimedPage";
import { Wizard } from "./components/Wizard";
import { S } from "./strings";
import { onboardingReducer } from "./wizard";
import type { SettingsSection } from "../../shared/settings-layout";
import type { Turn } from "../../shared/turn";

/** 状态变化事件合并的时间窗。 */
const STATE_DEBOUNCE_MS = 80;

export type Route =
  | { page: "home" }
  /** landing：从卡片的「去看看」进来时那张卡片的轮次，TicketPage 按它落到对应的页签（landingTab）。 */
  | { page: "ticket"; key: string; landing?: Turn }
  /**
   * focusSession：从「现在」页点进来时先切到的那个 session 的终端。
   * landing "control"：刚开好修复 session（fixLanding），落到「总控」页签看 focusTerm 那个终端；landingSeq 每次开都递增，页面已经开着也会再落一次。
   */
  | { page: "feature"; id: number; focusSession?: string | null; landing?: "control"; focusTerm?: string | null; landingSeq?: number }
  /** Butler 总控（BTL-190 第 5 点）。 */
  | { page: "butler"; focusSession?: string | null }
  /** 效果与花费页。 */
  | { page: "effect" }
  /** 全部工作（UI 重做第 2 层）；section：从提醒跳来时要展开的那一块。 */
  | { page: "all"; section?: "stacks" | "intake" }
  | { page: "unclaimed" }
  | { page: "archived" }
  /** section：要看的那个 tab 或高级里的分组（首页的提醒跳来时用 health / routing）。 */
  | { page: "settings"; section?: SettingsSection }
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
  /** 单独的 ticket；feature 下的 ticket 在 features[].tickets 里。 */
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [features, setFeatures] = useState<FeatureView[]>([]);
  /** 首页「现在」的数据：和列表一起刷新。 */
  const [nowView, setNowView] = useState<NowView | null>(null);
  const [showNewFeature, setShowNewFeature] = useState(false);
  const [unclaimedCount, setUnclaimedCount] = useState(0);
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
  /** 每次 refresh 的序号：只有最新一次的结果写进状态（hook 事件密集时，慢的旧响应不会盖掉新的）。 */
  const refreshSeq = useRef(0);
  /** 重读 ticket 列表和「现在」页；列表失败时报错并返回 false。 */
  const refresh = useCallback(async (): Promise<boolean> => {
    const seq = ++refreshSeq.current;
    // 「现在」页单独取、单独报错：它失败了侧栏和列表照样刷新。
    void api.nowView().then(
      (n) => seq === refreshSeq.current && setNowView(n),
      (e) => seq === refreshSeq.current && reportError(e),
    );
    try {
      const [t, f, u] = await Promise.all([api.listTickets(), api.listFeatures(), api.unclaimed()]);
      if (seq !== refreshSeq.current) return true;
      setTickets(t);
      setFeatures(f);
      setUnclaimedCount(u.length);
      return true;
    } catch (e) {
      if (seq === refreshSeq.current) reportError(e);
      return false;
    }
  }, []);

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

  useEffect(() => {
    void refresh();
    // hook 事件一来一串：合并成一次刷新。
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), STATE_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [refresh]);

  /** 所有未归档的 ticket，含 feature 下的（认领、ticket 页都按 ticket 号找）。 */
  const allTickets = [...tickets, ...features.flatMap((f) => f.tickets)];

  // 归档可能要等两分钟：等完时用户在看别的页面就留在那里；在看的页面跟着归档了（ticket 跟着 feature）就回首页，不留空白；
  // 路由停在这一版已经没有的页面（旧版本留下的）也回首页。
  // 只在列表变了时检查，不看 route：跳转时列表可能还没刷新（刷新被新的一次顶掉时），这时对象并没有消失。layout effect：空白不画出来。
  useLayoutEffect(() => {
    if (routeGone(route, allTickets, features)) setRoute({ page: "home" });
  }, [tickets, features]);

  /** 跳到 ticket 页；req 是到了那里要打开（已经开着就切过去）的 session。 */
  const openTicket = (key: string, req?: OpenSessionRequest) => {
    // 要去的 ticket 可能已经归档：不跳到空白页，也不留下悬空的打开请求。
    if (missingTicket({ page: "ticket", key }, allTickets) !== null) {
      reportError(new Error(S.ticketMissing(key)));
      return;
    }
    setPendingOpen(req ?? null);
    setRoute({ page: "ticket", key });
  };
  /** 卡片的「去看看」等跳转：去 ticket 页时同 openTicket，先看它还在不在。 */
  const go = (r: Route) => {
    const gone = missingTicket(r, allTickets);
    if (gone !== null) reportError(new Error(S.ticketMissing(gone)));
    else setRoute(r);
  };

  /** 「现在」页的一行点开：ticket 走 openTicket（切到那个终端）；feature 页打开时先看那个 session 的终端。 */
  const openTarget = (t: NowTarget) => {
    if (t.page === "ticket") openTicket(t.key, t.sessionId ? { ticketKey: t.key, sessionId: t.sessionId } : undefined);
    else if (t.page === "butler") setRoute({ page: "butler", focusSession: t.sessionId });
    else if (t.page === "feature") setRoute({ page: "feature", id: t.id, focusSession: t.sessionId });
    // 别的（旧版本主进程给的、这一版已经没有的页面）不跳。
  };

  // 恢复归档：先重读列表再跳过去，否则 ticket 页找不到它。
  const showRestored = (key: string) => {
    setShowNew(false);
    void refresh().then((ok) => ok && setRoute({ page: "ticket", key }));
  };

  const current = route.page === "ticket" ? (allTickets.find((t) => t.key === route.key) ?? null) : null;
  const currentFeature = route.page === "feature" ? (features.find((f) => f.id === route.id) ?? null) : null;
  const featureOf = (t: TicketView) => (t.featureId === null ? null : (features.find((f) => f.id === t.featureId) ?? null));
  const goTicket = (key: string) => void refresh().then(() => setRoute({ page: "ticket", key }));
  const goFeature = (id: number) => void refresh().then(() => setRoute({ page: "feature", id }));

  const dots = useMemo(() => scopeDots(turn.board?.items ?? []), [turn.board]);
  const ctx: NameCtx = {
    features: new Map(features.map((f) => [f.id, f.name])),
    tickets: new Map(allTickets.map((t) => [t.key, t.title])),
  };
  /** 「开修复 session」（首页、ticket 页、feature 页的卡片）：开好了去 feature 页的「总控」看它的终端（修复 session 在那里），失败报到全局错误条。 */
  const fixSeq = useRef(0);
  const openFix = (featureId: number, stuckSessionId: string) => {
    api.openFixSession({ featureId, stuckSessionId }).then((r) => {
      if (r.ok) setRoute(fixLanding(featureId, r.termId, ++fixSeq.current));
      else reportError(new Error(S.openErrors[r.reason] ?? r.reason));
    }, reportError);
  };

  return (
    <div className="app">
      <Sidebar
        tickets={tickets} features={features} youCount={turn.board?.counts.you ?? null} dots={dots} route={route} onNavigate={setRoute}
        keepAwake={keepAwake} onKeepAwake={(on) => api.setKeepAwake(on).then(setKeepAwake, reportError)}
      />
      <main className="main">
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>{S.close}</button>
          </div>
        )}
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
              <HomePage
                state={turn} noWork={isNoWork(allTickets.length + features.length, turn.board?.items ?? null, nowView?.notices.length ?? 0)}
                firstRun={<FirstRunHome {...firstRunProps({ onNewTicket: () => setShowNew(true), onNewFeature: () => setShowNewFeature(true), onGo: go })} />}
                ctx={ctx} nowView={nowView} liveTickets={new Set(allTickets.map((t) => t.key))}
                onFix={openFix} onOpen={openTarget} onGo={go} onOpenTicket={(key) => openTicket(key)} onChanged={turn.reload}
                onResumeSetup={() => dispatchOnboarding({ type: "rerun" })}
              />
            )}
            {route.page === "ticket" && current && (
              <TicketPage
                key={current.key}
                ticket={current}
                initialOpen={pendingOpen?.ticketKey === current.key ? pendingOpen : null}
                onInitialOpenDone={() => setPendingOpen(null)}
                landing={route.landing}
                onFix={openFix}
                onArchived={() => setRoute({ page: "home" })}
                feature={featureOf(current)}
                onOpenFeature={(id) => setRoute({ page: "feature", id })}
              />
            )}
            {route.page === "feature" && currentFeature && (
              <FeaturePage
                key={currentFeature.id}
                feature={currentFeature}
                onOpenTicket={(key) => openTicket(key)}
                onTicketCreated={goTicket}
                focusSession={route.focusSession}
                landing={route.landing}
                focusTerm={route.focusTerm}
                landingSeq={route.landingSeq}
                onOpenTarget={openTarget}
                ctx={ctx}
                onFix={openFix}
                onGo={go}
              />
            )}
            {route.page === "butler" && <ButlerPage key={route.focusSession ?? ""} focusSession={route.focusSession} />}
            {route.page === "all" && (
              <AllWorkPage
                key={route.section ?? ""}
                board={turn.board}
                features={features}
                tickets={tickets}
                unclaimedCount={unclaimedCount}
                now={Date.now()}
                focusMore={route.section}
                onNewTicket={() => setShowNew(true)}
                onNewFeature={() => setShowNewFeature(true)}
                onGo={go}
                onOpenTicket={(key) => openTicket(key)}
              />
            )}
            {route.page === "effect" && <EffectPage />}
            {route.page === "unclaimed" && <UnclaimedPage tickets={allTickets} />}
            {route.page === "archived" && <ArchivedPage onRestored={showRestored} onFeatureRestored={goFeature} />}
            {route.page === "settings" && <SettingsPage section={route.section} onRerunWizard={() => dispatchOnboarding({ type: "rerun" })} />}
            {route.page === "audit" && <AuditPage />}
            {route.page === "lessons" && <LessonsPage tab={route.tab} onOpenSession={(id) => setRoute({ page: "butler", focusSession: id })} />}
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
        <NewTicketDialog
          onClose={() => setShowNew(false)}
          onRestored={showRestored}
          onCreated={(key) => {
            setShowNew(false);
            // 先重读列表再跳过去，免得 ticket 页一闪而过的空白。
            void refresh().then(() => setRoute({ page: "ticket", key }));
          }}
        />
      )}
    </div>
  );
}
