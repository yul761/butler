import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { MergeEvent, NowEpic, NowFeature, NowNotice, NowRow, NowTarget, NowView, UsageSummary } from "../../../shared/types";
import { api } from "../api";
import { ciReasonText, noticeText, type NoticeAction } from "../availability-view";
import { costAmount } from "../cost-view";
import { reportError } from "../errors";
import { saveTab, saveTabOpen, setWizardSkipped, wizardSkipped } from "../local-prefs";
import { mergeEventText } from "../merge-events-view";
import { butlerLines, formatKb, heavyMcp, peakKb, rowMemDetail, rowMemText, sharedMcpSavingKb, snapshotLine, sparkPath } from "../mem-view";
import type { MemoryHistoryPoint, MemorySnapshot } from "../../../shared/mem-usage";
import { groupSummary, needsYouText, needsYouTotal, prPill, rowKey, rowLabel, rowPlace, rowText, usageDetails, usageLine } from "../now-view";
import { S } from "../strings";
import type { Route } from "../App";
import { DecisionCard } from "./InboxPanes";
import { LiveWindow } from "./LiveWindow";
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
  /** 提醒上的“查看状态”“打开复盘”：跳到别的页面。 */
  onGo: (r: Route) => void;
}

/**
 * 首页「现在」（设计文档 2026-11-06）：最上面是实况窗口（BTL-190 第 7 点），然后是需要你的，下面按 epic → feature → 行排，每一层都能收起；
 * 最下面是最近合并和一行用量。只显示和跳转，数据由主进程的 buildNowView 拼好。
 */
export function NowPage({ view, onOpen, onOpenTicket, liveTickets, onResumeSetup, onGo }: Props) {
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
      {view.notices.map((n) => <Notice key={noticeKey(n)} notice={n} now={now} onOpen={onOpen} onGo={onGo} />)}
      {view.mem && <MemoryCard snap={view.mem} view={view} />}
      {/* 实况（BTL-190 第 7 点）：没人在干活时它说“现在没有正在进行的工作”，下面的列表可能是空的。 */}
      <LiveWindow view={view} onOpen={onOpen} />
      {needsYouTotal(view) > 0 && <NeedsYou view={view} now={now} onOpen={onOpen} />}
      {view.butler && (
        <section className="now-epic now-butler">
          <h3><span className="name">{S.butlerNav}</span></h3>
          <div className="now-rows"><Row row={view.butler} now={now} onOpen={onOpen} /></div>
        </section>
      )}
      {view.epics.map((e) => <EpicBlock key={e.id ?? "none"} epic={e} now={now} onOpen={onOpen} />)}
      <RecentMerges merges={view.merges} onOpenTicket={onOpenTicket} liveTickets={liveTickets} />
      {usage && <UsageLine usage={usage} />}
    </div>
  );
}

/** 顶上的一条提醒：一句话加几个按钮；恢复、重试都是让复盘队列重新开始。 */
function noticeKey(n: NowNotice): string {
  if (n.kind === "cost") return `cost:${n.breaker.subjectKind}:${n.breaker.subjectId}`;
  if (n.kind === "comments_waiting") return `comments_waiting:${n.waiting.reason}:${n.waiting.prId}`;
  if (n.kind === "stack") return `stack:${n.stack.reason}:${n.stack.stackId}:${n.stack.branch}`;
  if (n.kind === "ci_undelivered") return `ci_undelivered:${n.ci.item.kind}:${n.ci.item.kind === "pr" ? n.ci.item.id : n.ci.item.repoId}`;
  if (n.kind !== "session_limited") return n.kind;
  const t = n.target;
  return `session_limited:${t.page}:${"key" in t ? t.key : "id" in t ? t.id : ""}:${t.sessionId ?? ""}`;
}

function Notice({ notice: n, now, onOpen, onGo }: { notice: NowNotice; now: number; onOpen: (t: NowTarget) => void; onGo: (r: Route) => void }) {
  const { text, actions } = noticeText(n, S, now);
  const label: Record<NoticeAction, string> = { resume: S.noticeResume, retry: S.noticeRetry, health: S.noticeHealth, lessons: S.noticeLessons, open: S.noticeOpen, routing: S.rt.nowOpen, resend: S.noticeResend, raise: S.cs.raise, comments: S.lp.noticeOpen, stacks: S.sk.noticeOpen };
  // 重发的结果（CI 结果未能送达）：送到了提醒会在下一次刷新时消失，没送到写上为什么。
  const [result, setResult] = useState<string | null>(null);
  const run = (a: NoticeAction): void => {
    if (a === "resume" || a === "retry") void api.availabilityAct({ op: "resumeLessons" }).catch(reportError);
    else if (a === "health") onGo({ page: "settings", section: "health" });
    else if (a === "lessons") onGo({ page: "lessons" });
    else if (a === "routing") onGo({ page: "settings", section: "routing" });
    else if (a === "raise" && n.kind === "cost") {
      setResult(null);
      void api.costResume(n.breaker.subjectKind, n.breaker.subjectId).then((r) => setResult(r.ok ? S.cs.raised(costAmount(r.cap, n.breaker.unit, S)) : S.cs.raiseGone), reportError);
    } else if (a === "resend" && n.kind === "ci_undelivered") {
      setResult(null);
      void api.ciResend(n.ci.item).then((r) => setResult(r === "sent" || r === "delivered" ? S.ciResendSent : r === "busy_delivering" ? S.ciResendBusy : S.ciResendNot(ciReasonText(r, S))), reportError);
    } else if (a === "comments" && n.kind === "comments_waiting") {
      // 打开 ticket 时直接停在「评论」标签。
      saveTab(`ticket:${n.waiting.ticketKey}`, "comments");
      saveTabOpen(`ticket:${n.waiting.ticketKey}`, true);
      onOpen(n.target);
    } else if (a === "stacks") onGo({ page: "progress" });
    else if (n.kind === "session_limited" || n.kind === "ci_undelivered") onOpen(n.target);
    else if (n.kind === "stack" && n.target) onOpen(n.target);
    else if (n.kind === "cost" && n.target) onOpen(n.target);
  };
  return (
    <div className="notice" data-testid={`now-notice-${n.kind}`}>
      <p>{text}</p>
      {result && <p className="muted" data-testid="now-notice-result">{result}</p>}
      <div className="actions">
        {actions.map((a) => <button key={a} data-testid={`now-notice-${n.kind}-${a}`} className={a === "raise" ? "primary" : undefined} onClick={() => run(a)}>{label[a]}</button>)}
      </div>
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

/** 历史曲线多久重取一次（历史每 5 分钟才多一个点）。 */
const MEM_HISTORY_REFRESH_MS = 5 * 60_000;

/** 内存卡片（WS-M A）：一行汇总，展开后是 Butler 自己的明细、24 小时的曲线和「你装的 MCP 太大」的提示。默认收起。 */
function MemoryCard({ snap, view }: { snap: MemorySnapshot; view: NowView }) {
  // 这个记号在存储里的意思是“展开了”。
  const [open, toggle] = useCollapsed("now:mem");
  const [history, setHistory] = useState<MemoryHistoryPoint[]>([]);
  useEffect(() => {
    if (!open) return;
    const load = () => void api.memUsageHistory(24).then(setHistory, reportError);
    load();
    const t = setInterval(load, MEM_HISTORY_REFRESH_MS);
    return () => clearInterval(t);
  }, [open]);
  const W = 240, H = 36;
  const d = open ? sparkPath(history, W, H) : null;
  const heavy = open ? heavyMcp(view) : [];
  return (
    <section className="now-usage now-mem-card">
      <GroupToggle open={open} onToggle={toggle}>{S.perf.memTitle}: {snapshotLine(snap, S)}</GroupToggle>
      {open && (
        <div className="now-usage-details">
          <div>
            <h4>{S.perf.memButler}</h4>
            <ul>{butlerLines(snap, S).map((l) => <li key={l}>{l}</li>)}</ul>
            {view.sharedMcp === false && sharedMcpSavingKb(snap) > 0 && <p className="muted">{S.perf.sharedMcpSave(formatKb(sharedMcpSavingKb(snap)))}</p>}
          </div>
          <div>
            <h4>{S.perf.memHistory}{history.length > 1 ? ` · ${formatKb(peakKb(history))}` : ""}</h4>
            {d ? (
              <svg className="mem-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={S.perf.memHistory}>
                <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            ) : <p className="muted">{S.perf.memNone}</p>}
          </div>
          {heavy.length > 0 && (
            <div>
              <p>{S.perf.tipsHeavyMcp(heavy.join(", "))}</p>
              <p className="muted">{S.perf.tipsMcp}</p>
            </div>
          )}
        </div>
      )}
    </section>
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
