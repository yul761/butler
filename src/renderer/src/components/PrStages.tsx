import { PR_STAGES, type PrStageCell, type PrStagesTicket, type PrStagesView } from "../../../shared/pr-stages";
import { api } from "../api";
import { reportError } from "../errors";
import { cellLabel, cellText, newestRow, timelineText, usePrStages } from "../pr-stages-view";
import { S } from "../strings";
import { useCollapsed } from "./useCollapsed";

function Cell({ cell, named }: { cell: PrStageCell; named: boolean }) {
  const symbol = cell.state === "done" || cell.state === "failed" || cell.state === "todo";
  const label = cellLabel(cell);
  return (
    <span className={`pr-cell pr-${cell.state}`} title={symbol ? label : undefined} aria-label={symbol ? label : undefined}>
      {named && <span className="pr-cell-name">{S.prStage[cell.id]}</span>}
      <span className="pr-cell-state">{cellText(cell)}</span>
    </span>
  );
}

/** 一行的 key：PR 行按 PR，没有 PR 的行按仓库（和以前每个仓库一行时的 key 一样，记住的收起状态还在）。 */
const rowKey = (r: PrStagesView): string => (r.prId === null ? String(r.repoId) : `pr:${r.prId}`);

const timeOf = (ms: number): string => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 主进程只开 ticket 链接过、主机允许的 PR；不让开（bad_url）就什么都不做。 */
const openPr = (url: string): void => void api.prOpen(url).catch(reportError);

function RepoStages({ row, showName }: { row: PrStagesView; showName: boolean }) {
  const [collapsed, toggle] = useCollapsed(`pr-timeline:${row.ticketKey}:${rowKey(row)}`);
  // 不是 ticket 仓库的 PR 总是写 slug；ticket 仓库的行，多于一行时才写仓库名。
  const name = row.slug ?? (showName ? row.repoName : null);
  const prUrl = row.prUrl;
  return (
    <section className="pr-repo">
      <div className="pr-steps">
        {name !== null && <span className="pr-repo-name">{name}</span>}
        {row.stages.map((c) => <Cell key={c.id} cell={c} named />)}
        {row.noPr && <span className="pr-no-pr muted">{S.prNoPrYet}</span>}
        {prUrl && <button className="pr-link link" title={prUrl} onClick={() => openPr(prUrl)}>{row.prNumber === null ? "PR" : `#${row.prNumber}`}</button>}
        {row.closed && <span className="pr-closed">{S.prClosed}</span>}
      </div>
      {row.timeline.length > 0 && (
        <>
          <button className="link pr-timeline-toggle" onClick={toggle}>{collapsed ? S.prTimelineShow : S.prTimelineHide}</button>
          {!collapsed && (
            <ul className="pr-timeline">
              {row.timeline.map((e, i) => (
                <li key={i} className={e.back ? "pr-back" : undefined}>
                  <span className="muted">{timeOf(e.at)}</span> {timelineText(e)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** ticket tab 的 PR 行：顺序照主进程给的（没有 PR 的行在前，然后 PR 新的在前）。 */
export function TicketPrRows({ rows }: { rows: PrStagesView[] }) {
  if (rows.length === 0) return <p className="muted">{S.prNoRepos}</p>;
  return (
    <div className="pr-stages">
      {rows.map((r) => <RepoStages key={rowKey(r)} row={r} showName={rows.length > 1} />)}
    </div>
  );
}

export function TicketPrStages({ ticketKey }: { ticketKey: string }) {
  const tickets = usePrStages({ ticketKey });
  if (tickets === null) return null;
  return <TicketPrRows rows={tickets[0]?.rows ?? []} />;
}

/** 一张表：一行一个 ticket（含已归档的），六列是它最新那一行的进度；已合并的 ticket 有标记，没有仓库的写一句。整行可点，打开 ticket。 */
function TicketsTable({ tickets, onOpenTicket }: { tickets: PrStagesTicket[]; onOpenTicket: (key: string) => void }) {
  return (
    <table className="pr-table">
      <thead>
        <tr>
          <th />
          {PR_STAGES.map((id) => <th key={id}>{S.prStage[id]}</th>)}
        </tr>
      </thead>
      <tbody>
        {tickets.map((t) => {
          const r = newestRow(t);
          const prs = t.rows.filter((x) => x.prId !== null).length;
          return (
            <tr key={t.ticketKey} className="clickable" onClick={() => onOpenTicket(t.ticketKey)}>
              <td className="pr-row-name">
                <button className="chip" onClick={(ev) => (ev.stopPropagation(), onOpenTicket(t.ticketKey))}>{t.ticketKey}</button>
                {prs > 1 && <span className="muted"> {S.prCount(prs)}</span>}
                {t.merged && <span className="pill merged">{S.prPill.merged}</span>}
                {t.archived && <span className="pr-archived">{S.prArchived}</span>}
                {r?.closed && <span className="pr-closed">{S.prClosed}</span>}
              </td>
              {/* 看有没有行而不是 hasRepos：没有仓库、只有别的仓库的 PR 的 ticket 照样显示进度。 */}
              {r === null
                ? <td className="muted" colSpan={PR_STAGES.length}>{S.prTicketNoRepos}</td>
                : r.stages.map((c) => <td key={c.id}><Cell cell={c} named={false} /></td>)}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** feature 的 PR 进度表（不取数据，便于测试）。 */
export function FeaturePrRows({ tickets, onOpenTicket }: { tickets: PrStagesTicket[]; onOpenTicket: (key: string) => void }) {
  if (tickets.length === 0) return <p className="muted">{S.prNoTickets}</p>;
  return <TicketsTable tickets={tickets} onOpenTicket={onOpenTicket} />;
}

export function FeaturePrStages({ featureId, onOpenTicket }: { featureId: number; onOpenTicket: (key: string) => void }) {
  const tickets = usePrStages({ featureId });
  if (tickets === null) return null;
  return <FeaturePrRows tickets={tickets} onOpenTicket={onOpenTicket} />;
}
