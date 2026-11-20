import type { EpicView, FeatureView, TicketView } from "../../../shared/types";
import type { Route } from "../App";
import { dotKey, youBadge, type Dot } from "../sidebar-view";
import { featuresOutsideEpics } from "./epic-row";
import { useCollapsed } from "./useCollapsed";
import { api } from "../api";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

// 侧栏（UI 重做第 2 层，spec §5.3）：轮到你、全部工作的树、总控、「Butler 自己」一组、防休眠。
// 树里每个节点的点只表示谁该动（第 1 层的 turn:board 算出来，App 传进 dots）。

interface Props {
  /** 单独的 ticket（feature 下的 ticket 在 features 里）。 */
  tickets: TicketView[];
  features: FeatureView[];
  /** 未归档的 epic；它们下面的 feature 只列在 epic 下面。 */
  epics: EpicView[];
  /** 轮到你的件数；null = 还没取到过。0 和 null 都不显示徽标。 */
  youCount: number | null;
  /** dotKey(kind, id) → 点；没有的节点不画点。 */
  dots: Map<string, Dot>;
  route: Route;
  onNavigate: (r: Route) => void;
  /** 防休眠开关（托盘菜单里也有同一个）。 */
  keepAwake: boolean;
  onKeepAwake: (on: boolean) => void;
}

/** 侧栏「轮到你」按钮的描述（轮到你的个数）的元素 id。 */
const NEEDS_YOU_DESC_ID = "sidebar-needs-you-count";

const cls = (base: string, active: boolean) => (active ? `${base} active` : base);

/** 节点后面的点和「轮到你」的数字。 */
function DotMark({ dot }: { dot: Dot | null }) {
  if (!dot) return null;
  return (
    <>
      <span className={`turn-dot turn-${dot.tone}`} title={S.hm.dotTitle[dot.tone]} />
      {dot.you > 0 && <span className="cnt">{dot.you}</span>}
    </>
  );
}

export function Sidebar({ tickets, features, epics, youCount, dots, route, onNavigate, keepAwake, onKeepAwake }: Props) {
  const lessonsPending = useStateRefetch("lessons-pending", api.lessonsPending) ?? 0;
  const looseFeatures = featuresOutsideEpics(features, epics);
  const badge = youCount !== null && youCount > 0 ? youCount : 0;
  const ticketButton = (t: TicketView) => (
    <button
      key={t.key}
      className={cls("ticket", route.page === "ticket" && route.key === t.key)}
      title={t.title ? `${t.key} ${t.title}` : t.key}
      onClick={() => onNavigate({ page: "ticket", key: t.key })}
    >
      <span className="key">{t.key}</span>
      {t.title && <span className="title">{t.title}</span>}
      <DotMark dot={dots.get(dotKey("ticket", t.key)) ?? null} />
    </button>
  );
  const allActive = route.page === "all" || route.page === "unclaimed" || route.page === "archived";
  return (
    <nav className="sidebar">
      {/* 可访问名固定是「轮到你」：徽标里的数字不算进名字，读屏从 aria-describedby 指向的隐藏文字读到个数。 */}
      <button
        className={cls("nav home", route.page === "home")}
        aria-label={S.home}
        aria-describedby={badge > 0 ? NEEDS_YOU_DESC_ID : undefined}
        onClick={() => onNavigate({ page: "home" })}
      >
        {S.home}
        {badge > 0 && (
          <>
            <span className="needs-you-badge" aria-hidden="true" title={S.nowNeedsYouBadge(badge)}>{youBadge(badge)}</span>
            <span id={NEEDS_YOU_DESC_ID} className="sr-only">{S.nowNeedsYouBadge(badge)}</span>
          </>
        )}
      </button>
      <button className={cls("nav all", allActive)} onClick={() => onNavigate({ page: "all" })}>{S.allWork}</button>
      <div className="ticket-groups">
        {epics.map((e) => (
          <EpicGroup key={e.id} epic={e} features={features.filter((f) => f.epicId === e.id)} route={route} onNavigate={onNavigate} ticketButton={ticketButton} dots={dots} />
        ))}
        {looseFeatures.map((f) => (
          <FeatureGroup key={f.id} feature={f} route={route} onNavigate={onNavigate} ticketButton={ticketButton} dots={dots} />
        ))}
        {tickets.map(ticketButton)}
      </div>
      <button className={cls("nav butler", route.page === "butler")} onClick={() => onNavigate({ page: "butler" })}>{S.butlerNav}</button>
      <h3 className="nav-group">{S.selfGroup}</h3>
      <button className={cls("nav", route.page === "lessons")} data-testid="lessons-nav" title={lessonsPending > 0 ? S.lessonsNavCount(lessonsPending) : undefined} onClick={() => onNavigate({ page: "lessons" })}>
        {S.lessons}{lessonsPending > 0 ? ` · ${lessonsPending}` : ""}
      </button>
      <button className={cls("nav effect", route.page === "effect")} data-testid="nav-effect" onClick={() => onNavigate({ page: "effect" })}>{S.effectNav}</button>
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
  dots: Map<string, Dot>;
}

interface GroupRowProps {
  name: string;
  /** 下面有多少项：没有就不用三角，收起时显示这个数。 */
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  active: boolean;
  onOpen: () => void;
  dot: Dot | null;
}

/** 侧栏里 epic 和 feature 的一行：前面的三角收起/展开下面的内容，点名字进它的页面；点看的是它下面的全部。 */
function GroupRow({ name, count, collapsed, onToggle, active, onOpen, dot }: GroupRowProps) {
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
      <button className={cls("ticket feature", active)} title={name} onClick={onOpen}>
        <span className="key">{name}</span>
        {collapsed && <span className="title">{count}</span>}
        <DotMark dot={dot} />
      </button>
    </div>
  );
}

interface EpicGroupProps extends Omit<FeatureGroupProps, "feature"> {
  epic: EpicView;
  features: FeatureView[];
}

/** 侧栏里的一个 epic，下面列它的 feature。 */
function EpicGroup({ epic: e, features, route, onNavigate, ticketButton, dots }: EpicGroupProps) {
  const [collapsed, toggle] = useCollapsed(`sidebar-epic:${e.id}`);
  // 收起时正在看的那个 feature（或它下面的 ticket）还留着，不然不知道自己在哪。
  const isHere = (f: FeatureView) => (route.page === "feature" && route.id === f.id) || (route.page === "ticket" && f.tickets.some((t) => t.key === route.key));
  const shown = collapsed ? features.filter(isHere) : features;
  return (
    <div className="feature-group epic-group">
      <GroupRow
        name={e.name} count={features.length} collapsed={collapsed} onToggle={toggle}
        active={route.page === "epic" && route.id === e.id} onOpen={() => onNavigate({ page: "epic", id: e.id })}
        dot={dots.get(dotKey("epic", e.id)) ?? null}
      />
      {shown.length > 0 && (
        <div className="feature-tickets">
          {shown.map((f) => <FeatureGroup key={f.id} feature={f} route={route} onNavigate={onNavigate} ticketButton={ticketButton} dots={dots} />)}
        </div>
      )}
    </div>
  );
}

/** 侧栏里的一个 feature，下面列它的 ticket。 */
function FeatureGroup({ feature: f, route, onNavigate, ticketButton, dots }: FeatureGroupProps) {
  const [collapsed, toggle] = useCollapsed(`sidebar:${f.id}`);
  // 收起时正在看的那个 ticket 还留着，不然不知道自己在哪。
  const shown = collapsed ? f.tickets.filter((t) => route.page === "ticket" && route.key === t.key) : f.tickets;
  return (
    <div className="feature-group">
      <GroupRow
        name={f.name} count={f.tickets.length} collapsed={collapsed} onToggle={toggle}
        active={route.page === "feature" && route.id === f.id} onOpen={() => onNavigate({ page: "feature", id: f.id })}
        dot={dots.get(dotKey("feature", f.id)) ?? null}
      />
      {shown.length > 0 && <div className="feature-tickets">{shown.map(ticketButton)}</div>}
    </div>
  );
}
