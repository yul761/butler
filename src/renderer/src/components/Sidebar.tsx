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
  /** 「现在」页里需要你的条数：大于 0 时入口后面显示红点和数字。 */
  needsYouCount: number;
  route: Route;
  onNavigate: (r: Route) => void;
  onNew: () => void;
  onNewFeature: () => void;
  onNewEpic: () => void;
  /** 防休眠开关（托盘菜单里也有同一个）。 */
  keepAwake: boolean;
  onKeepAwake: (on: boolean) => void;
}

/** 侧栏“现在”按钮的描述（需要你的个数）的元素 id。 */
const NEEDS_YOU_DESC_ID = "sidebar-needs-you-count";

const cls = (base: string, active: boolean) => (active ? `${base} active` : base);

export function Sidebar({ tickets, features, epics, unclaimedCount, needsYouCount, route, onNavigate, onNew, onNewFeature, onNewEpic, keepAwake, onKeepAwake }: Props) {
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
      {/* 可访问名固定是“现在”：红点里的数字不算进名字，读屏从 aria-describedby 指向的隐藏文字（“1 个需要你”）读到个数。 */}
      <button
        className={cls("nav home", route.page === "home")}
        aria-label={S.home}
        aria-describedby={needsYouCount > 0 ? NEEDS_YOU_DESC_ID : undefined}
        onClick={() => onNavigate({ page: "home" })}
      >
        {S.home}
        {needsYouCount > 0 && (
          <>
            <span className="needs-you-badge" aria-hidden="true" title={S.nowNeedsYouBadge(needsYouCount)}>
              {needsYouCount}
            </span>
            <span id={NEEDS_YOU_DESC_ID} className="sr-only">{S.nowNeedsYouBadge(needsYouCount)}</span>
          </>
        )}
      </button>
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

interface GroupRowProps {
  name: string;
  /** 下面有多少项：没有就不用三角，收起时显示这个数。 */
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  active: boolean;
  onOpen: () => void;
  waiting: boolean;
  stuck: boolean;
}

/** 侧栏里 epic 和 feature 的一行：前面的三角收起/展开下面的内容，点名字进它的页面；等待标记和红点看的是它下面的全部。 */
function GroupRow({ name, count, collapsed, onToggle, active, onOpen, waiting, stuck }: GroupRowProps) {
  return (
    <div className="feature-row">
      <button
        className="twisty"
        aria-expanded={!collapsed}
        aria-label={collapsed ? S.expand : S.collapse}
        title={collapsed ? S.expand : S.collapse}
        disabled={count === 0}
        onClick={onToggle}
      >
        {collapsed ? "▸" : "▾"}
      </button>
      <button className={cls("ticket feature", active)} onClick={onOpen}>
        <span className="key">{name}</span>
        {collapsed && <span className="title">{count}</span>}
        {waiting && <span className="badge" title={S.waiting}>●</span>}
        {stuck && <span className="stuck-mark" title={S.stuckDot}>●</span>}
      </button>
    </div>
  );
}

interface EpicGroupProps extends Omit<FeatureGroupProps, "feature"> {
  epic: EpicView;
  features: FeatureView[];
}

/** 侧栏里的一个 epic，下面列它的 feature。 */
function EpicGroup({ epic: e, features, route, onNavigate, ticketButton }: EpicGroupProps) {
  const [collapsed, toggle] = useCollapsed(`sidebar-epic:${e.id}`);
  // 收起时正在看的那个 feature（或它下面的 ticket）还留着，不然不知道自己在哪。
  const isHere = (f: FeatureView) => (route.page === "feature" && route.id === f.id) || (route.page === "ticket" && f.tickets.some((t) => t.key === route.key));
  const shown = collapsed ? features.filter(isHere) : features;
  return (
    <div className="feature-group epic-group">
      <GroupRow
        name={e.name} count={features.length} collapsed={collapsed} onToggle={toggle}
        active={route.page === "epic" && route.id === e.id} onOpen={() => onNavigate({ page: "epic", id: e.id })}
        waiting={e.waiting} stuck={e.stuck}
      />
      {shown.length > 0 && (
        <div className="feature-tickets">
          {shown.map((f) => <FeatureGroup key={f.id} feature={f} route={route} onNavigate={onNavigate} ticketButton={ticketButton} />)}
        </div>
      )}
    </div>
  );
}

/** 侧栏里的一个 feature，下面列它的 ticket。 */
function FeatureGroup({ feature: f, route, onNavigate, ticketButton }: FeatureGroupProps) {
  const [collapsed, toggle] = useCollapsed(`sidebar:${f.id}`);
  // 收起时正在看的那个 ticket 还留着，不然不知道自己在哪。
  const shown = collapsed ? f.tickets.filter((t) => route.page === "ticket" && route.key === t.key) : f.tickets;
  return (
    <div className="feature-group">
      <GroupRow
        name={f.name} count={f.tickets.length} collapsed={collapsed} onToggle={toggle}
        active={route.page === "feature" && route.id === f.id} onOpen={() => onNavigate({ page: "feature", id: f.id })}
        waiting={f.waiting} stuck={Object.values(f.activity).some((a) => a.stuck === true)}
      />
      {shown.length > 0 && <div className="feature-tickets">{shown.map(ticketButton)}</div>}
    </div>
  );
}
