import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { MergeEvent, NowEpic, NowFeature, NowRow, NowTarget, NowView, UsageSummary } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { setWizardSkipped, wizardSkipped } from "../local-prefs";
import { mergeEventText } from "../merge-events-view";
import { groupSummary, needsYouText, prPill, rowKey, rowPlace, rowText, usageDetails, usageLine } from "../now-view";
import { S } from "../strings";
import { formatDuration, useNow } from "./TicketActivity";
import { useCollapsed } from "./useCollapsed";

/** 用量不跟每次 stateChanged 重取：一分钟一次就够了。 */
const USAGE_REFRESH_MS = 60_000;

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
}

/**
 * 首页「现在」（设计文档 2026-11-06）：最上面是需要你的，下面按 epic → feature → 行排，每一层都能收起；
 * 最下面是最近合并和一行用量。只显示和跳转，数据由主进程的 buildNowView 拼好。
 */
export function NowPage({ view, onOpen, onOpenTicket, liveTickets, onResumeSetup }: Props) {
  const now = useNow();
  const usage = useUsage();
  const setup = <SetupSkipped onResumeSetup={onResumeSetup} />;
  if (!view) return <div className="page now-page">{setup}<p className="muted">{S.loading}</p></div>;
  return (
    <div className="page now-page">
      {setup}
      <header className="now-top">
        <h2>{S.nowTitle}</h2>
        <span className="muted">{S.nowRunning(view.running)}</span>
      </header>
      {view.needsYou.length > 0 && <NeedsYou view={view} now={now} onOpen={onOpen} />}
      {view.epics.length === 0 && <p className="muted">{S.nowEmpty}</p>}
      {view.epics.map((e) => <EpicBlock key={e.id ?? "none"} epic={e} now={now} onOpen={onOpen} />)}
      <RecentMerges merges={view.merges} onOpenTicket={onOpenTicket} liveTickets={liveTickets} />
      {usage && <UsageLine usage={usage} />}
    </div>
  );
}

/** 向导点了“稍后再说”：提醒还没设置完（和原来简报页上的一样）。“不再提示”清掉本地的跳过记号，以后都不再出现。 */
function SetupSkipped({ onResumeSetup }: { onResumeSetup: () => void }) {
  const [skipped, setSkipped] = useState(wizardSkipped);
  if (!skipped) return null;
  return (
    <div className="notice setup-skipped">
      <p>{S.setupSkipped}</p>
      <div className="actions">
        <button className="primary" onClick={onResumeSetup}>{S.resumeSetup}</button>
        <button
          onClick={() => {
            setWizardSkipped(false);
            setSkipped(false);
          }}
        >
          {S.dismissForever}
        </button>
      </div>
    </div>
  );
}

/** 用量：打开页面时取一次，之后每分钟一次。 */
function useUsage(): UsageSummary | null {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.usageSummary().then((u) => live && setUsage(u), reportError);
    void load();
    const timer = setInterval(() => void load(), USAGE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return usage;
}

const since = (r: NowRow, now: number): string => (r.since === null ? "" : formatDuration(now - r.since, S));

/** 「需要你」：每条一行，ticket 号（或总控）、所在的 feature、理由、时长、打开。 */
function NeedsYou({ view, now, onOpen }: { view: NowView; now: number; onOpen: (t: NowTarget) => void }) {
  return (
    <section className="now-needs">
      <h3>{S.nowNeedsYou}<span className="count">{view.needsYou.length}</span></h3>
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

interface ToggleProps {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}

/** 可收起的一块的标题按钮。 */
function GroupToggle({ open, onToggle, children, className }: ToggleProps) {
  return (
    <button className={className ? `section-toggle ${className}` : "section-toggle"} aria-expanded={open} onClick={onToggle}>
      <span className="twisty">{open ? "▾" : "▸"}</span>
      {children}
    </button>
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
  const label = r.ticketKey ?? (r.coordinator ? S.coordinator : S.fixSessionFor(null));
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
      <span className="now-since">{since(r, now)}</span>
    </button>
  );
}

/** 最近合并（默认收起）：一行一条；已归档或不存在的 ticket 只显示文字。 */
function RecentMerges({ merges, onOpenTicket, liveTickets }: { merges: MergeEvent[]; onOpenTicket: (key: string) => void; liveTickets: Set<string> }) {
  // 这个记号在存储里的意思是“展开了”。
  const [open, toggle] = useCollapsed("now:merges");
  if (merges.length === 0) return null;
  return (
    <section className="now-merges">
      <h3>
        <GroupToggle open={open} onToggle={toggle}>
          {S.nowRecentMerges}
          <span className="now-summary">{merges.length}</span>
        </GroupToggle>
      </h3>
      {open && merges.map((e) => {
        const { repo, parts } = mergeEventText(e, S);
        return (
          <div key={e.id} className="merge-event">
            <span className="muted">{new Date(e.createdAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            <span className="muted">{repo}</span>
            <span className="text">
              {parts.map((p, n) =>
                typeof p === "string" ? <Fragment key={n}>{p}</Fragment> : liveTickets.has(p.ticket) ? (
                  <button key={n} className="chip" onClick={() => onOpenTicket(p.ticket)}>{p.ticket}</button>
                ) : <Fragment key={n}>{p.ticket}</Fragment>,
              )}
            </span>
          </div>
        );
      })}
    </section>
  );
}

/** 一行用量小字，点开列出按类型和按模型的占比（默认收起）。 */
function UsageLine({ usage }: { usage: UsageSummary }) {
  // 这个记号在存储里的意思是“展开了”。
  const [open, toggle] = useCollapsed("now:usage");
  const details = open ? usageDetails(usage, S) : null;
  return (
    <section className="now-usage">
      <GroupToggle open={open} onToggle={toggle}>{usageLine(usage, S)}</GroupToggle>
      {details && (
        <div className="now-usage-details">
          <div>
            <h4>{S.nowUsageByKind}</h4>
            <ul>{details.byKind.map((l) => <li key={l}>{l}</li>)}</ul>
          </div>
          {details.byModel.length > 0 && (
            <div>
              <h4>{S.nowUsageByModel}</h4>
              <ul>{details.byModel.map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
