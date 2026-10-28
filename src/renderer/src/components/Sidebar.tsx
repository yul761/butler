import type { FeatureView, TicketView } from "../../../shared/types";
import type { Route } from "../App";
import { groupTickets } from "../group";
import { useCollapsed } from "./useCollapsed";
import { S, STATUS_LABEL } from "../strings";

interface Props {
  /** 单独的 ticket（feature 下的 ticket 在 features 里）。 */
  tickets: TicketView[];
  features: FeatureView[];
  unclaimedCount: number;
  route: Route;
  onNavigate: (r: Route) => void;
  onNew: () => void;
  onNewFeature: () => void;
  /** 防休眠开关（托盘菜单里也有同一个）。 */
  keepAwake: boolean;
  onKeepAwake: (on: boolean) => void;
}

const cls = (base: string, active: boolean) => (active ? `${base} active` : base);

export function Sidebar({ tickets, features, unclaimedCount, route, onNavigate, onNew, onNewFeature, keepAwake, onKeepAwake }: Props) {
  const ticketButton = (t: TicketView) => (
    <button
      key={t.key}
      className={cls("ticket", route.page === "ticket" && route.key === t.key)}
      onClick={() => onNavigate({ page: "ticket", key: t.key })}
    >
      <span className="key">{t.key}</span>
      {t.title && <span className="title">{t.title}</span>}
      {t.waiting && <span className="badge" title={S.waiting}>●</span>}
    </button>
  );
  return (
    <nav className="sidebar">
      <button className={cls("nav", route.page === "home")} onClick={() => onNavigate({ page: "home" })}>{S.home}</button>
      <button className="new-ticket" onClick={onNew}>+ {S.newTicket}</button>
      <button className="new-ticket" onClick={onNewFeature}>+ {S.newFeature}</button>
      <div className="ticket-groups">
        {features.length > 0 && (
          <section>
            <h3>{S.features}</h3>
            {features.map((f) => (
              <FeatureGroup key={f.id} feature={f} route={route} onNavigate={onNavigate} ticketButton={ticketButton} />
            ))}
          </section>
        )}
        {groupTickets(tickets).map((g) => (
          <section key={g.status}>
            <h3>{STATUS_LABEL[g.status]}</h3>
            {g.tickets.map(ticketButton)}
          </section>
        ))}
      </div>
      <button className={cls("nav", route.page === "unclaimed")} onClick={() => onNavigate({ page: "unclaimed" })}>
        {S.unclaimed}{unclaimedCount > 0 ? ` (${unclaimedCount})` : ""}
      </button>
      <button className={cls("nav", route.page === "archived")} onClick={() => onNavigate({ page: "archived" })}>{S.archived}</button>
      <button className={cls("nav", route.page === "audit")} onClick={() => onNavigate({ page: "audit" })}>{S.audit}</button>
      <button className={cls("nav", route.page === "settings")} onClick={() => onNavigate({ page: "settings" })}>{S.settings}</button>
      <label className={cls("keep-awake", keepAwake)} title={S.keepAwakeHint}>
        <input type="checkbox" checked={keepAwake} onChange={(e) => onKeepAwake(e.target.checked)} />
        {keepAwake ? S.keepAwakeOn : S.keepAwake}
      </label>
    </nav>
  );
}

interface FeatureGroupProps {
  feature: FeatureView;
  route: Route;
  onNavigate: (r: Route) => void;
  ticketButton: (t: TicketView) => React.ReactNode;
}

/** 侧栏里的一个 feature：前面的三角收起/展开它下面的 ticket，点名字进 feature 页。 */
function FeatureGroup({ feature: f, route, onNavigate, ticketButton }: FeatureGroupProps) {
  const [collapsed, toggle] = useCollapsed(`sidebar:${f.id}`);
  // 收起时正在看的那个 ticket 还留着，不然不知道自己在哪。
  const shown = collapsed ? f.tickets.filter((t) => route.page === "ticket" && route.key === t.key) : f.tickets;
  const waiting = f.sessions.some((s) => s.waitingForInput) || (collapsed && f.tickets.some((t) => t.waiting));
  return (
    <div className="feature-group">
      <div className="feature-row">
        <button
          className="twisty"
          aria-expanded={!collapsed}
          aria-label={collapsed ? S.expand : S.collapse}
          title={collapsed ? S.expand : S.collapse}
          disabled={f.tickets.length === 0}
          onClick={toggle}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button className={cls("ticket feature", route.page === "feature" && route.id === f.id)} onClick={() => onNavigate({ page: "feature", id: f.id })}>
          <span className="key">{f.name}</span>
          {collapsed && <span className="title">{f.tickets.length}</span>}
          {waiting && <span className="badge" title={S.waiting}>●</span>}
        </button>
      </div>
      {shown.length > 0 && <div className="feature-tickets">{shown.map(ticketButton)}</div>}
    </div>
  );
}
