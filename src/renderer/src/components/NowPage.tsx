import type { NowEpic, NowFeature, NowRow, NowTarget, NowView } from "../../../shared/types";
import { rowMemDetail, rowMemText } from "../mem-view";
import { groupSummary, needsYouText, needsYouTotal, prPill, rowKey, rowLabel, rowPlace, rowText } from "../now-view";
import { S } from "../strings";
import type { Route } from "../App";
import { HomeMore, GroupToggle, SetupSkipped } from "./HomeMore";
import { DecisionCard } from "./InboxPanes";
import { Notice, noticeKey } from "./Notice";
import { formatDuration, useNow } from "./TicketActivity";
import { useCollapsed } from "./useCollapsed";

interface Props {
  /** 还没取到时为 null。 */
  view: NowView | null;
  onOpen: (t: NowTarget) => void;
  /** “最近合并”里的 ticket 号：点了打开 ticket 页。 */
  onOpenTicket: (key: string) => void;
  /** 还没归档的 ticket：只有它们在“最近合并”里能点。 */
  liveTickets: Set<string>;
  /** 跳过了向导的人点“继续设置”：重新打开向导。 */
  onResumeSetup: () => void;
  /** 提醒上的“查看状态”“打开复盘”：跳到别的页面。 */
  onGo: (r: Route) => void;
}

/**
 * 首页「现在」（设计文档 2026-11-06）：最上面是实况窗口（BTL-190 第 7 点），然后是需要你的，下面按 epic → feature → 行排，每一层都能收起；
 * 最下面是最近合并和一行用量。只显示和跳转，数据由主进程的 buildNowView 拼好。
 */
export function NowPage({ view, onOpen, onOpenTicket, liveTickets, onResumeSetup, onGo }: Props) {
  const now = useNow();
  const setup = <SetupSkipped onResumeSetup={onResumeSetup} />;
  if (!view) return <div className="page now-page">{setup}<p className="muted">{S.loading}</p></div>;
  return (
    <div className="page now-page">
      {setup}
      <header className="now-top">
        <h2>{S.nowTitle}</h2>
        <span className="muted">{S.nowRunning(view.running)}</span>
      </header>
      {view.notices.map((n) => <Notice key={noticeKey(n)} notice={n} now={now} onOpen={onOpen} onGo={onGo} />)}
      {needsYouTotal(view) > 0 && <NeedsYou view={view} now={now} onOpen={onOpen} />}
      {view.butler && (
        <section className="now-epic now-butler">
          <h3><span className="name">{S.butlerNav}</span></h3>
          <div className="now-rows"><Row row={view.butler} now={now} onOpen={onOpen} /></div>
        </section>
      )}
      {view.epics.map((e) => <EpicBlock key={e.id ?? "none"} epic={e} now={now} onOpen={onOpen} />)}
      <HomeMore view={view} onOpen={onOpen} onOpenTicket={onOpenTicket} liveTickets={liveTickets} onGo={onGo} />
    </div>
  );
}

const since = (r: NowRow, now: number): string => (r.since === null ? "" : formatDuration(now - r.since, S));

/**
 * 「需要你」：先是 ask_user 提的「待你决定」，每条一张能直接回答的卡片（BTL-190 第 2+3 点）；
 * 然后每条一行，ticket 号（或总控）、所在的 feature、理由、时长、打开。
 */
function NeedsYou({ view, now, onOpen }: { view: NowView; now: number; onOpen: (t: NowTarget) => void }) {
  return (
    <section className="now-needs">
      <h3>{S.nowNeedsYou}<span className="count">{needsYouTotal(view)}</span></h3>
      {view.decisions.length > 0 && (
        <div className="now-decisions">
          {view.decisions.map((d) => <DecisionCard key={d.id} item={d} onGo={() => onOpen(d.target)} />)}
        </div>
      )}
      {view.needsYou.map((r) => {
        const place = rowPlace(view, r, S);
        return (
          <button key={rowKey(r)} className="now-need" onClick={() => onOpen(r.target)}>
            <span className="now-key">{place.label}</span>
            {place.name && <span className="name">{place.name}</span>}
            <span className="why">{needsYouText(r, S)}</span>
            <span className="since">{since(r, now)}</span>
            <span className="go">{S.nowOpen}</span>
          </button>
        );
      })}
    </section>
  );
}

function EpicBlock({ epic: e, now, onOpen }: { epic: NowEpic; now: number; onOpen: (t: NowTarget) => void }) {
  const [collapsed, toggle] = useCollapsed(`now:epic:${e.id ?? "none"}`);
  return (
    <section className="now-epic">
      <h3>
        <GroupToggle open={!collapsed} onToggle={toggle}>
          <span className="name">{e.id === null ? S.nowNoEpic : e.name}</span>
          <span className="now-summary">{groupSummary(e.counts, S)}</span>
        </GroupToggle>
      </h3>
      {!collapsed && (
        <div className="now-epic-body">
          {e.rows.length > 0 && <div className="now-rows">{e.rows.map((r) => <Row key={rowKey(r)} row={r} now={now} onOpen={onOpen} />)}</div>}
          {e.features.map((f) => <FeatureBlock key={f.id ?? "none"} feature={f} now={now} onOpen={onOpen} />)}
        </div>
      )}
    </section>
  );
}

function FeatureBlock({ feature: f, now, onOpen }: { feature: NowFeature; now: number; onOpen: (t: NowTarget) => void }) {
  const id = f.id ?? "none";
  const [collapsed, toggle] = useCollapsed(`now:feature:${id}`);
  // 空闲的行默认收起：这个记号在存储里的意思是“展开了”（和 feature 页 TicketRow 的面板一样）。
  const [idleOpen, toggleIdle] = useCollapsed(`now:idle:${id}`);
  const busy = f.rows.filter((r) => !r.idle);
  const idle = f.rows.filter((r) => r.idle);
  return (
    <section className="now-feature">
      <h4>
        <GroupToggle open={!collapsed} onToggle={toggle}>
          <span className="name">{f.id === null ? S.nowNoFeature : f.name}</span>
          <span className="now-summary">{groupSummary(f.counts, S)}</span>
        </GroupToggle>
      </h4>
      {!collapsed && (
        <div className="now-rows">
          {busy.map((r) => <Row key={rowKey(r)} row={r} now={now} onOpen={onOpen} />)}
          {idle.length > 0 && (
            <div className="now-idle">
              <GroupToggle open={idleOpen} onToggle={toggleIdle}>{S.nowIdle(idle.length)}</GroupToggle>
              {idleOpen && idle.map((r) => <Row key={rowKey(r)} row={r} now={now} onOpen={onOpen} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 一行：ticket 号（总控、修复 session 写它是什么）、在做什么、PR 标签、时长。整行可点。 */
function Row({ row: r, now, onOpen }: { row: NowRow; now: number; onOpen: (t: NowTarget) => void }) {
  const t = rowText(r, S, now);
  const pills = r.prs.flatMap((p) => {
    const pill = prPill(p, S);
    return pill ? [{ ...pill, url: p.url }] : [];
  });
  const label = rowLabel(r, S);
  return (
    <button className={`now-row ${t.tone}`} title={r.title ?? undefined} onClick={() => onOpen(r.target)}>
      <span className="now-key">
        {label}
        {r.ticketKey !== null && r.coordinator && <small>{S.coordinator}</small>}
        {r.repo && <small>{r.repo}</small>}
      </span>
      <span className="now-what">
        <span className="now-dot" aria-hidden="true" />
        <span className="main">{t.main}</span>
        {t.sub && <small>{t.sub}</small>}
      </span>
      <span className="now-prs">
        {pills.map((p, n) => <span key={p.url ?? n} className={`pill ${p.tone}`} title={p.url ?? undefined}>{p.text}</span>)}
      </span>
      <span className="now-mem" title={r.mem ? rowMemDetail(r.mem, S) : undefined}>{rowMemText(r.mem, S)}</span>
      <span className="now-since">{since(r, now)}</span>
    </button>
  );
}

