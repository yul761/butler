import type { EpicView, FeatureView, TicketView } from "../../../shared/types";
import type { Route } from "../App";
import { groupTickets } from "../group";
import { featuresOutsideEpics } from "./epic-row";
import { useCollapsed } from "./useCollapsed";
import { S, STATUS_LABEL } from "../strings";

interface Props {
  /** 单独的 ticket（feature 下的 ticket 在 features 里）。 */
  tickets: TicketView[];
  features: FeatureView[];
  /** 未归档的 epic；它们下面的 feature 只列在 epic 下面。 */
  epics: EpicView[];
  unclaimedCount: number;
  route: Route;
  onNavigate: (r: Route) => void;
  onNew: () => void;
  onNewFeature: () => void;
  onNewEpic: () => void;
  /** 防休眠开关（托盘菜单里也有同一个）。 */
  keepAwake: boolean;
  onKeepAwake: (on: boolean) => void;
}

const cls = (base: string, active: boolean) => (active ? `${base} active` : base);

export function Sidebar({ tickets, features, epics, unclaimedCount, route, onNavigate, onNew, onNewFeature, onNewEpic, keepAwake, onKeepAwake }: Props) {
  const looseFeatures = featuresOutsideEpics(features, epics);
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
      <button className="new-ticket" onClick={onNewEpic}>+ {S.newEpic}</button>
      <div className="ticket-groups">
        {epics.length > 0 && (
          <section>
            <h3>{S.epics}</h3>
            {epics.map((e) => (
              <EpicGroup key={e.id} epic={e} features={features.filter((f) => f.epicId === e.id)} route={route} onNavigate={onNavigate} ticketButton={ticketButton} />
            ))}
          </section>
        )}
        {looseFeatures.length > 0 && (
          <section>
            <h3>{S.features}</h3>
            {looseFeatures.map((f) => (
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

interface EpicGroupProps extends Omit<FeatureGroupProps, "feature"> {
  epic: EpicView;
  features: FeatureView[];
}

/** 侧栏里的一个 epic：前面的三角收起/展开下面的 feature，点名字进 epic 页。红点和等待标记看的是整个 epic，收起时也看得到。 */
function EpicGroup({ epic: e, features, route, onNavigate, ticketButton }: EpicGroupProps) {
  const [collapsed, toggle] = useCollapsed(`sidebar-epic:${e.id}`);
  // 收起时正在看的那个 feature（或它下面的 ticket）还留着，不然不知道自己在哪。
  const isHere = (f: FeatureView) => (route.page === "feature" && route.id === f.id) || (route.page === "ticket" && f.tickets.some((t) => t.key === route.key));
  const shown = collapsed ? features.filter(isHere) : features;
  return (
    <div className="feature-group epic-group">
      <div className="feature-row">
        <button
          className="twisty"
          aria-expanded={!collapsed}
          aria-label={collapsed ? S.expand : S.collapse}
          title={collapsed ? S.expand : S.collapse}
          disabled={features.length === 0}
          onClick={toggle}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button className={cls("ticket feature", route.page === "epic" && route.id === e.id)} onClick={() => onNavigate({ page: "epic", id: e.id })}>
          <span className="key">{e.name}</span>
          {collapsed && <span className="title">{features.length}</span>}
          {e.waiting && <span className="badge" title={S.waiting}>●</span>}
          {e.stuck && <span className="stuck-mark" title={S.stuckDot}>●</span>}
        </button>
      </div>
      {shown.length > 0 && (
        <div className="feature-tickets">
          {shown.map((f) => <FeatureGroup key={f.id} feature={f} route={route} onNavigate={onNavigate} ticketButton={ticketButton} />)}
        </div>
      )}
    </div>
  );
}

/** 侧栏里的一个 feature：前面的三角收起/展开它下面的 ticket，点名字进 feature 页。 */
function FeatureGroup({ feature: f, route, onNavigate, ticketButton }: FeatureGroupProps) {
  const [collapsed, toggle] = useCollapsed(`sidebar:${f.id}`);
  // 收起时正在看的那个 ticket 还留着，不然不知道自己在哪。
  const shown = collapsed ? f.tickets.filter((t) => route.page === "ticket" && route.key === t.key) : f.tickets;
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
          {f.waiting && <span className="badge" title={S.waiting}>●</span>}
          {Object.values(f.activity).some((a) => a.stuck === true) && <span className="stuck-mark" title={S.stuckDot}>●</span>}
        </button>
      </div>
      {shown.length > 0 && <div className="feature-tickets">{shown.map(ticketButton)}</div>}
    </div>
  );
}
