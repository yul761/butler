// 首页「运行情况」折叠里的东西（UI 重做第 2 层）：从原来的「现在」页原样搬来——实况窗口、内存、最近合并、自动接活、用量。
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { MemoryHistoryPoint, MemorySnapshot } from "../../../shared/mem-usage";
import type { IntakeRecentEntry } from "../../../shared/intake";
import type { MergeEvent, NowTarget, NowView, UsageSummary } from "../../../shared/types";
import { api } from "../api";
import type { Route } from "../App";
import { reportError } from "../errors";
import { intakeRecentText } from "../intake-view";
import { setWizardSkipped, wizardSkipped } from "../local-prefs";
import { butlerLines, formatKb, heavyMcp, peakKb, sharedMcpSavingKb, snapshotLine, sparkPath } from "../mem-view";
import { mergeEventText } from "../merge-events-view";
import { usageDetails, usageLine } from "../now-view";
import { S } from "../strings";
import { LiveWindow } from "./LiveWindow";
import { useCollapsed } from "./useCollapsed";

export interface HomeMoreProps {
  view: NowView;
  onOpen: (t: NowTarget) => void;
  /** “最近合并”里的 ticket 号：点了打开 ticket 页。 */
  onOpenTicket: (key: string) => void;
  /** 还没归档的 ticket：只有它们在“最近合并”里能点。 */
  liveTickets: Set<string>;
  onGo: (r: Route) => void;
}

/** 运行情况：内存、实况窗口、最近合并、自动接活、一行用量。空的块不出。 */
export function HomeMore({ view, onOpen, onOpenTicket, liveTickets, onGo }: HomeMoreProps) {
  const usage = useUsage();
  return (
    <div className="home-more">
      {view.mem && <MemoryCard snap={view.mem} view={view} />}
      <LiveWindow view={view} onOpen={onOpen} />
      <RecentMerges merges={view.merges} onOpenTicket={onOpenTicket} liveTickets={liveTickets} />
      {view.intake && <IntakeRecent entries={view.intake} onGo={onGo} />}
      {usage && <UsageLine usage={usage} />}
    </div>
  );
}

/** 用量不跟每次 stateChanged 重取：一分钟一次就够了。 */
const USAGE_REFRESH_MS = 60_000;

/** 向导点了“稍后再说”：提醒还没设置完（和原来简报页上的一样）。“不再提示”清掉本地的跳过记号，以后都不再出现。 */
export function SetupSkipped({ onResumeSetup }: { onResumeSetup: () => void }) {
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
export function useUsage(): UsageSummary | null {
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

interface ToggleProps {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}

/** 可收起的一块的标题按钮。 */
export function GroupToggle({ open, onToggle, children, className }: ToggleProps) {
  return (
    <button className={className ? `section-toggle ${className}` : "section-toggle"} aria-expanded={open} onClick={onToggle}>
      <span className="twisty">{open ? "▾" : "▸"}</span>
      {children}
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

/** 自动接活（工作流 N）最近 24 小时自动做了什么：不用你管的那些，收起着。 */
function IntakeRecent({ entries, onGo }: { entries: IntakeRecentEntry[]; onGo: (r: Route) => void }) {
  const [open, toggle] = useCollapsed("now:intake");
  if (entries.length === 0) return null;
  return (
    <section className="now-merges" data-testid="now-intake">
      <h3>
        <GroupToggle open={open} onToggle={toggle}>
          {S.ik.recentTitle}
          <span className="now-summary">{entries.length}</span>
        </GroupToggle>
      </h3>
      {open && (
        <>
          {entries.map((e) => (
            <div key={`${e.key}:${e.at}`} className="merge-event" data-testid="now-intake-entry">
              <span className="muted">{new Date(e.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="text">{intakeRecentText(e, S)}</span>
            </div>
          ))}
          <div className="actions"><button onClick={() => onGo({ page: "all", section: "intake" })}>{S.ik.noticeOpen}</button></div>
        </>
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
