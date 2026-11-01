import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { BriefKind } from "../../shared/brief";
import type { EpicView, FeatureView, OpenSessionRequest, TicketView } from "../../shared/types";
import { api } from "./api";
import { onError, reportError } from "./errors";
import { setCollapsed } from "./local-prefs";
import { routeGone } from "./route-view";
import { ArchivedPage } from "./components/ArchivedPage";
import { AuditPage } from "./components/AuditPage";
import { BriefPage } from "./components/BriefPage";
import { EpicPage } from "./components/EpicPage";
import { FeaturePage, type StuckReveal } from "./components/FeaturePage";
import { NewEpicDialog } from "./components/NewEpicDialog";
import { NewFeatureDialog } from "./components/NewFeatureDialog";
import { NewTicketDialog } from "./components/NewTicketDialog";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { TicketPage } from "./components/TicketPage";
import { UnclaimedPage } from "./components/UnclaimedPage";
import { Wizard } from "./components/Wizard";
import { S } from "./strings";
import { onboardingReducer } from "./wizard";

/** 状态变化事件合并的时间窗。 */
const STATE_DEBOUNCE_MS = 80;

export type Route =
  | { page: "home"; kind?: BriefKind }
  | { page: "ticket"; key: string }
  | { page: "feature"; id: number }
  | { page: "epic"; id: number }
  | { page: "unclaimed" }
  | { page: "archived" }
  | { page: "settings" }
  | { page: "audit" };

export function App() {
  const [route, setRoute] = useState<Route>({ page: "home" });
  /** 单独的 ticket；feature 下的 ticket 在 features[].tickets 里。 */
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [features, setFeatures] = useState<FeatureView[]>([]);
  const [epics, setEpics] = useState<EpicView[]>([]);
  const [showNewFeature, setShowNewFeature] = useState(false);
  const [showNewEpic, setShowNewEpic] = useState(false);
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [keepAwake, setKeepAwake] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 从简报点“打开”时要在 ticket 页上执行的打开请求（执行一次后清空）。 */
  const [pendingOpen, setPendingOpen] = useState<OpenSessionRequest | null>(null);

  const [onboarding, dispatchOnboarding] = useReducer(onboardingReducer, null);

  useEffect(() => onError(setError), []);
  // 防休眠开关：托盘菜单里改了、或者合上盖子自动关掉，主进程都会通知。
  useEffect(() => {
    api.keepAwake().then(setKeepAwake, reportError);
    return api.onKeepAwakeChanged(setKeepAwake);
  }, []);
  // 点击晚间小结的系统通知：回到简报。
  const [navNonce, setNavNonce] = useState(0);
  const [stuckReveal, setStuckReveal] = useState<StuckReveal | null>(null);
  useEffect(
    () =>
      api.onNavigate((r) => {
        if (r.page === "feature") {
          // 点卡住通知：展开 ticket 区和这个 ticket 的面板。已经开着的 feature 页听得到这两个改动，不用重新挂载，终端和当前标签都留着。
          setCollapsed(`tickets:${r.featureId}`, false);
          setCollapsed(`stuck-open:${r.stuckTicket}`, true);
          setRoute({ page: "feature", id: r.featureId });
          setStuckReveal({ ticket: r.stuckTicket });
          return;
        }
        setRoute({ page: "home", kind: r.kind });
        // 已经在简报页时也要切到通知对应的标签：换 key 让 BriefPage 重新挂载。
        setNavNonce((n) => n + 1);
      }),
    [],
  );

  /** 每次 refresh 的序号：只有最新一次的结果写进状态（hook 事件密集时，慢的旧响应不会盖掉新的）。 */
  const refreshSeq = useRef(0);
  /** 重读 ticket 列表；失败时报错并返回 false。 */
  const refresh = useCallback(async (): Promise<boolean> => {
    const seq = ++refreshSeq.current;
    try {
      const [t, f, e, u] = await Promise.all([api.listTickets(), api.listFeatures(), api.listEpics(), api.unclaimed()]);
      if (seq !== refreshSeq.current) return true;
      setTickets(t);
      setFeatures(f);
      setEpics(e);
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

  /** 所有未归档的 ticket，含 feature 下的（简报、认领、ticket 页都按 ticket 号找）。 */
  const allTickets = [...tickets, ...features.flatMap((f) => f.tickets)];

  // 归档可能要等两分钟：等完时用户在看别的页面就留在那里；在看的页面跟着归档了（feature、ticket 跟着 epic）就回简报，不留空白。
  // 只在列表变了时检查，不看 route：跳转时列表可能还没刷新（刷新被新的一次顶掉时），这时对象并没有消失。layout effect：空白不画出来。
  useLayoutEffect(() => {
    if (routeGone(route, allTickets, features, epics)) setRoute({ page: "home" });
  }, [tickets, features, epics]);

  const openTicket = (key: string, req?: OpenSessionRequest) => {
    // 简报里的 ticket 可能已经归档：不跳到空白页，也不留下悬空的打开请求。
    if (!allTickets.some((t) => t.key === key)) {
      reportError(new Error(S.ticketMissing(key)));
      return;
    }
    setPendingOpen(req ?? null);
    setRoute({ page: "ticket", key });
  };

  // 恢复归档：先重读列表再跳过去，否则 ticket 页找不到它。
  const showRestored = (key: string) => {
    setShowNew(false);
    void refresh().then((ok) => ok && setRoute({ page: "ticket", key }));
  };

  const current = route.page === "ticket" ? (allTickets.find((t) => t.key === route.key) ?? null) : null;
  const currentFeature = route.page === "feature" ? (features.find((f) => f.id === route.id) ?? null) : null;
  const currentEpic = route.page === "epic" ? (epics.find((e) => e.id === route.id) ?? null) : null;
  const featureOf = (t: TicketView) => (t.featureId === null ? null : (features.find((f) => f.id === t.featureId) ?? null));
  const goTicket = (key: string) => void refresh().then(() => setRoute({ page: "ticket", key }));
  const goFeature = (id: number) => void refresh().then(() => setRoute({ page: "feature", id }));
  const goEpic = (id: number) => void refresh().then(() => setRoute({ page: "epic", id }));

  return (
    <div className="app">
      <Sidebar
        tickets={tickets} features={features} epics={epics} unclaimedCount={unclaimedCount} route={route} onNavigate={setRoute}
        onNew={() => setShowNew(true)} onNewFeature={() => setShowNewFeature(true)} onNewEpic={() => setShowNewEpic(true)}
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
            {route.page === "home" && <BriefPage key={navNonce} initialKind={route.kind} tickets={allTickets} features={features} onOpenTicket={openTicket} onUnclaimed={() => setRoute({ page: "unclaimed" })} onResumeSetup={() => dispatchOnboarding({ type: "rerun" })} />}
            {route.page === "ticket" && current && (
              <TicketPage
                key={current.key}
                ticket={current}
                initialOpen={pendingOpen?.ticketKey === current.key ? pendingOpen : null}
                onInitialOpenDone={() => setPendingOpen(null)}
                onArchived={() => setRoute({ page: "home" })}
                feature={featureOf(current)}
                onOpenFeature={(id) => setRoute({ page: "feature", id })}
              />
            )}
            {route.page === "feature" && currentFeature && (
              <FeaturePage
                key={currentFeature.id}
                feature={currentFeature}
                epics={epics}
                onOpenTicket={(key) => setRoute({ page: "ticket", key })}
                onTicketCreated={goTicket}
                reveal={stuckReveal}
                onRevealed={() => setStuckReveal(null)}
              />
            )}
            {route.page === "epic" && currentEpic && (
              <EpicPage
                key={currentEpic.id}
                epic={currentEpic}
                onOpenFeature={(id) => setRoute({ page: "feature", id })}
                onFeatureCreated={goFeature}
              />
            )}
            {route.page === "unclaimed" && <UnclaimedPage tickets={allTickets} />}
            {route.page === "archived" && <ArchivedPage onRestored={showRestored} onFeatureRestored={goFeature} onEpicRestored={goEpic} />}
            {route.page === "settings" && <SettingsPage onRerunWizard={() => dispatchOnboarding({ type: "rerun" })} />}
            {route.page === "audit" && <AuditPage />}
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
      {showNewEpic && (
        <NewEpicDialog
          onClose={() => setShowNewEpic(false)}
          onCreated={(id) => {
            setShowNewEpic(false);
            goEpic(id);
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
