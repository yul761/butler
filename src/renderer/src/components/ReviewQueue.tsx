// 待 review（工作流 G，设计 §10）：原来在进度页上，UI 重做第 3 层放进全部工作页的「更多」，挨着栈和 intake。
import type { ReviewQueueItem } from "../../../shared/prereview";
import { api } from "../api";
import { reportError } from "../errors";
import { riskPill } from "../review-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const openPr = (url: string): void => void api.prOpen(url).catch(reportError);

/** 一个 PR 的风险和就绪徽标；没评估过的不显示。 */
export function ReviewBadges({ item }: { item: ReviewQueueItem | undefined }) {
  if (!item) return <>—</>;
  return (
    <span data-testid="review-badges">
      {item.risk && <span className={`pill ${riskPill(item.risk)}`}>{S.rv.riskBadge(S.rv.level[item.risk])}</span>}
      {item.ready !== null && <span className={item.ready ? "pill approved" : "pill pending"}>{item.ready ? S.rv.ready : S.rv.notReady}</span>}
    </span>
  );
}

/** 未就绪在前 → 风险高在前 → 等得久在前（主进程排好）。items 为 null = 还没取到，只显示标题。 */
export function ReviewQueueList({ items, onOpenTicket }: { items: ReviewQueueItem[] | null; onOpenTicket: (key: string) => void }) {
  return (
    <section className="review-queue" data-testid="review-queue">
      <h3>{S.rv.queueTitle}</h3>
      <p className="muted">{S.rv.queueIntro}</p>
      {items === null ? null : items.length === 0 ? <p className="muted">{S.rv.queueNone}</p> : (
        <table className="ticket-table">
          <tbody>
            {items.map((i) => (
              <tr key={i.prId} data-testid={`review-queue-${i.number}`}>
                <td><button className="pr-link link" title={i.url} onClick={() => openPr(i.url)}>{`${i.repoSlug}#${i.number}`}</button></td>
                <td>{i.title ?? ""}</td>
                <td><button className="chip" onClick={() => onOpenTicket(i.ticketKey)}>{i.ticketKey}</button></td>
                <td><ReviewBadges item={i} /></td>
                <td className="muted">{i.missing.length > 0 ? S.rv.missing(i.missing.map((m) => S.rv.cond[m.key]).join(", ")) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 自己取数据（stateChanged 时重取）的那一份，全部工作页用。 */
export function ReviewQueue({ onOpenTicket }: { onOpenTicket: (key: string) => void }) {
  const items = useStateRefetch("review-queue", api.reviewQueue);
  return <ReviewQueueList items={items} onOpenTicket={onOpenTicket} />;
}
