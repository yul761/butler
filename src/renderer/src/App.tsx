import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { BriefKind } from "../../shared/brief";
import type { OpenSessionRequest, TicketView } from "../../shared/types";
import { api } from "./api";
import { onError, reportError } from "./errors";
import { ArchivedPage } from "./components/ArchivedPage";
import { AuditPage } from "./components/AuditPage";
import { BriefPage } from "./components/BriefPage";
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
  | { page: "unclaimed" }
  | { page: "archived" }
  | { page: "settings" }
  | { page: "audit" };

export function App() {
  const [route, setRoute] = useState<Route>({ page: "home" });
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 从简报点“打开”时要在 ticket 页上执行的打开请求（执行一次后清空）。 */
  const [pendingOpen, setPendingOpen] = useState<OpenSessionRequest | null>(null);

  const [onboarding, dispatchOnboarding] = useReducer(onboardingReducer, null);

  useEffect(() => onError(setError), []);
  // 点击晚间小结的系统通知：回到简报。
  const [navNonce, setNavNonce] = useState(0);
  useEffect(
    () =>
      api.onNavigate((r) => {
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
      const [t, u] = await Promise.all([api.listTickets(), api.unclaimed()]);
      if (seq !== refreshSeq.current) return true;
      setTickets(t);
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

  const openTicket = (key: string, req?: OpenSessionRequest) => {
    // 简报里的 ticket 可能已经归档：不跳到空白页，也不留下悬空的打开请求。
    if (!tickets.some((t) => t.key === key)) {
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

  const current = route.page === "ticket" ? (tickets.find((t) => t.key === route.key) ?? null) : null;

  return (
    <div className="app">
      <Sidebar tickets={tickets} unclaimedCount={unclaimedCount} route={route} onNavigate={setRoute} onNew={() => setShowNew(true)} />
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
            {route.page === "home" && <BriefPage key={navNonce} initialKind={route.kind} tickets={tickets} onOpenTicket={openTicket} onUnclaimed={() => setRoute({ page: "unclaimed" })} onResumeSetup={() => dispatchOnboarding({ type: "rerun" })} />}
            {route.page === "ticket" && current && (
              <TicketPage
                key={current.key}
                ticket={current}
                initialOpen={pendingOpen?.ticketKey === current.key ? pendingOpen : null}
                onInitialOpenDone={() => setPendingOpen(null)}
                onArchived={() => setRoute({ page: "home" })}
              />
            )}
            {route.page === "unclaimed" && <UnclaimedPage tickets={tickets} />}
            {route.page === "archived" && <ArchivedPage onRestored={showRestored} />}
            {route.page === "settings" && <SettingsPage onRerunWizard={() => dispatchOnboarding({ type: "rerun" })} />}
            {route.page === "audit" && <AuditPage />}
          </>
        )}
      </main>
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
