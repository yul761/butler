import { useState } from "react";
import type { PrStageCell, PrStagesView } from "../../../shared/pr-stages";
import { epicPrSummary, timelineText, usePrStages } from "../pr-stages-view";
import { S } from "../strings";
import { useCollapsed } from "./useCollapsed";

/** cell 上写的状态：完成 / 进行中 / 失败 / 没开始用符号，跳过、未知、在 feature 层用文字（两种语言都一样的符号不用翻译）。 */
function cellText(c: PrStageCell): string {
  switch (c.state) {
    case "done": return "✓";
    case "active": return "…";
    case "failed": return "✗";
    case "todo": return "—";
    case "skipped": return S.prStageSkipped;
    case "unknown": return S.prStageUnknown;
    case "feature_level": return S.prStageFeatureLevel;
  }
}

function Cell({ cell, named }: { cell: PrStageCell; named: boolean }) {
  return (
    <span className={`pr-cell pr-${cell.state}`}>
      {named && <span className="pr-cell-name">{S.prStage[cell.id]}</span>}
      <span className="pr-cell-state">{cellText(cell)}</span>
      {cell.round > 1 && <span className="pr-cell-round">{S.prRound(cell.round)}</span>}
    </span>
  );
}

const timeOf = (ms: number): string => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function RepoStages({ row, showName }: { row: PrStagesView; showName: boolean }) {
  const [collapsed, toggle] = useCollapsed(`pr-timeline:${row.ticketKey}:${row.repoId}`);
  return (
    <section className="pr-repo">
      <div className="pr-steps">
        {showName && <span className="pr-repo-name">{row.repoName}</span>}
        {row.stages.map((c) => <Cell key={c.id} cell={c} named />)}
        {row.prUrl && (
          <a className="pr-link" href={row.prUrl} target="_blank" rel="noreferrer">{S.prOpenPr(row.prNumber)}</a>
        )}
      </div>
      {row.timeline.length > 0 && (
        <>
          <button className="link pr-timeline-toggle" onClick={toggle}>{collapsed ? S.prTimelineShow : S.prTimelineHide}</button>
          {!collapsed && (
            <ul className="pr-timeline">
              {row.timeline.map((e, i) => (
                <li key={i} className={e.back ? "pr-back" : undefined}>
                  <span className="muted">{timeOf(e.at)}</span> <span className="muted">{S.prStage[e.stage]}</span> {timelineText(e)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function TicketPrStages({ ticketKey }: { ticketKey: string }) {
  const rows = usePrStages({ ticketKey });
  if (rows === null) return null;
  if (rows.length === 0) return <p className="muted">{S.prNoRepos}</p>;
  return (
    <div className="pr-stages">
      {rows.map((r) => <RepoStages key={r.repoId} row={r} showName={rows.length > 1} />)}
    </div>
  );
}

/** 一张表：每行 ticket 号（多仓库时加仓库名），六列。onOpenTicket 给了就整行可点。 */
function StagesTable({ rows, onOpenTicket }: { rows: PrStagesView[]; onOpenTicket?: (key: string) => void }) {
  const perTicket = new Map<string, number>();
  for (const r of rows) perTicket.set(r.ticketKey, (perTicket.get(r.ticketKey) ?? 0) + 1);
  return (
    <table className="pr-table">
      <thead>
        <tr>
          <th />
          {rows[0]?.stages.map((c) => <th key={c.id}>{S.prStage[c.id]}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.ticketKey}:${r.repoId}`} className={onOpenTicket ? "clickable" : undefined} onClick={onOpenTicket && (() => onOpenTicket(r.ticketKey))}>
            <td className="pr-row-name">
              {r.ticketKey}
              {(perTicket.get(r.ticketKey) ?? 0) > 1 && <span className="muted"> {r.repoName}</span>}
            </td>
            {r.stages.map((c) => <td key={c.id}><Cell cell={c} named={false} /></td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FeaturePrStages({ featureId, onOpenTicket }: { featureId: number; onOpenTicket: (key: string) => void }) {
  const rows = usePrStages({ featureId });
  if (rows === null) return null;
  if (rows.length === 0) return <p className="muted">{S.prNoRepos}</p>;
  return <StagesTable rows={rows} onOpenTicket={onOpenTicket} />;
}

export function EpicPrStages({ epicId, features }: { epicId: number; features: { id: number; name: string }[] }) {
  const rows = usePrStages({ epicId });
  const [open, setOpen] = useState<number | null>(null);
  if (rows === null) return null;
  const summary = epicPrSummary(rows);
  return (
    <div className="pr-epic">
      {features.map((f) => {
        const s = summary.get(f.id);
        const total = s?.total ?? 0;
        const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
        const mine = rows.filter((r) => r.featureId === f.id);
        return (
          <div key={f.id}>
            <div className="pr-epic-row clickable" onClick={() => setOpen(open === f.id ? null : f.id)}>
              <span className="pr-epic-name">{f.name}</span>
              <span className="pr-bar">
                <span className="pr-seg pr-done" style={{ width: `${pct(s?.merged ?? 0)}%` }} />
                <span className="pr-seg pr-active" style={{ width: `${pct(s?.active ?? 0)}%` }} />
                <span className="pr-seg pr-failed" style={{ width: `${pct(s?.failed ?? 0)}%` }} />
                <span className="pr-seg pr-todo" style={{ width: `${pct(s?.notStarted ?? 0)}%` }} />
              </span>
              <span className="muted">{S.prMergedOf(s?.merged ?? 0, total)}</span>
            </div>
            {open === f.id && (mine.length === 0 ? <p className="muted">{S.prNoRepos}</p> : <StagesTable rows={mine} />)}
          </div>
        );
      })}
    </div>
  );
}
