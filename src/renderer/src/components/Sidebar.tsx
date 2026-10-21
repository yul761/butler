import type { TicketView } from "../../../shared/types";
import type { Route } from "../App";
import { groupTickets } from "../group";
import { S, STATUS_LABEL } from "../strings";

interface Props {
  tickets: TicketView[];
  unclaimedCount: number;
  route: Route;
  onNavigate: (r: Route) => void;
  onNew: () => void;
}

const cls = (base: string, active: boolean) => (active ? `${base} active` : base);

export function Sidebar({ tickets, unclaimedCount, route, onNavigate, onNew }: Props) {
  return (
    <nav className="sidebar">
      <button className={cls("nav", route.page === "home")} onClick={() => onNavigate({ page: "home" })}>{S.home}</button>
      <button className="new-ticket" onClick={onNew}>+ {S.newTicket}</button>
      <div className="ticket-groups">
        {groupTickets(tickets).map((g) => (
          <section key={g.status}>
            <h3>{STATUS_LABEL[g.status]}</h3>
            {g.tickets.map((t) => (
              <button
                key={t.key}
                className={cls("ticket", route.page === "ticket" && route.key === t.key)}
                onClick={() => onNavigate({ page: "ticket", key: t.key })}
              >
                <span className="key">{t.key}</span>
                {t.title && <span className="title">{t.title}</span>}
                {t.waiting && <span className="badge" title={S.waiting}>●</span>}
              </button>
            ))}
          </section>
        ))}
      </div>
      <button className={cls("nav", route.page === "unclaimed")} onClick={() => onNavigate({ page: "unclaimed" })}>
        {S.unclaimed}{unclaimedCount > 0 ? ` (${unclaimedCount})` : ""}
      </button>
      <button className={cls("nav", route.page === "audit")} onClick={() => onNavigate({ page: "audit" })}>{S.audit}</button>
      <button className={cls("nav", route.page === "settings")} onClick={() => onNavigate({ page: "settings" })}>{S.settings}</button>
    </nav>
  );
}
