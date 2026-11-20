import type { PrStageCell, PrStagesView } from "../../../shared/pr-stages";
import { api } from "../api";
import { reportError } from "../errors";
import { cellLabel, cellText, timelineText, usePrStages } from "../pr-stages-view";
import { S } from "../strings";
import { useCollapsed } from "./useCollapsed";

function Cell({ cell }: { cell: PrStageCell }) {
  const symbol = cell.state === "done" || cell.state === "failed" || cell.state === "todo";
  const label = cellLabel(cell);
  return (
    <span className={`pr-cell pr-${cell.state}`} title={symbol ? label : undefined} aria-label={symbol ? label : undefined}>
      <span className="pr-cell-name">{S.prStage[cell.id]}</span>
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
        {row.stages.map((c) => <Cell key={c.id} cell={c} />)}
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
