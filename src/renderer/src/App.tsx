import { useCallback, useEffect, useState } from "react";
import type { OpenSessionRequest, TicketView } from "../../shared/types";
import { api } from "./api";
import { onError, reportError } from "./errors";
import { BriefPage } from "./components/BriefPage";
import { NewTicketDialog } from "./components/NewTicketDialog";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { TicketPage } from "./components/TicketPage";
import { UnclaimedPage } from "./components/UnclaimedPage";
import { S } from "./strings";

export type Route = { page: "home" } | { page: "ticket"; key: string } | { page: "unclaimed" } | { page: "settings" };

export function App() {
  const [route, setRoute] = useState<Route>({ page: "home" });
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 从简报点“打开”时要在 ticket 页上执行的打开请求（执行一次后清空）。 */
  const [pendingOpen, setPendingOpen] = useState<OpenSessionRequest | null>(null);

  useEffect(() => onError(setError), []);
  // 点击晚间小结的系统通知：回到简报。
  useEffect(() => api.onNavigate(() => setRoute({ page: "home" })), []);

  const refresh = useCallback(async () => {
    try {
      const [t, u] = await Promise.all([api.listTickets(), api.unclaimed()]);
      setTickets(t);
      setUnclaimedCount(u.length);
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return api.onStateChanged(() => void refresh());
  }, [refresh]);

  const openTicket = (key: string, req?: OpenSessionRequest) => {
    setPendingOpen(req ?? null);
    setRoute({ page: "ticket", key });
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
        {route.page === "home" && <BriefPage tickets={tickets} onOpenTicket={openTicket} onUnclaimed={() => setRoute({ page: "unclaimed" })} />}
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
        {route.page === "settings" && <SettingsPage />}
      </main>
      {showNew && (
        <NewTicketDialog
          onClose={() => setShowNew(false)}
          onCreated={(key) => {
            setShowNew(false);
            setRoute({ page: "ticket", key });
            void refresh();
          }}
        />
      )}
    </div>
  );
}
