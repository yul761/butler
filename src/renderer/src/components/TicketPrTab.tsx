// ticket 页「PR 详情」页签（UI 重做第 3 层）：阶段、CI · review · 风险 · 就绪、未处理的评论，上下依次摆，三个组件内部不动。
// 6 步「阶段」默认收起，按 ticket 记住开合（BTL-244）。
import type { ReactNode } from "react";
import { S } from "../strings";
import { GroupToggle } from "./HomeMore";
import { TicketPrStages } from "./PrStages";
import { TicketComments } from "./TicketComments";
import { TicketReview } from "./TicketReview";
import { useCollapsed } from "./useCollapsed";

/** 只负责摆放三块的位置和小标题。 */
export function TicketPrBody({ ticketKey, stages, review, comments }: { ticketKey: string; stages: ReactNode; review: ReactNode; comments: ReactNode }) {
  const [stagesCollapsed, toggleStages] = useCollapsed(`ticket-pr-stages:${ticketKey}`, true);
  return (
    <div className="ticket-pr">
      <section className="ticket-pr-stages">
        <h3><GroupToggle open={!stagesCollapsed} onToggle={toggleStages}>{S.lay.prSecStages}</GroupToggle></h3>
        {!stagesCollapsed && stages}
      </section>
      <section className="ticket-pr-review">
        <h3>{S.lay.prSecReview}</h3>
        {review}
      </section>
      <section className="ticket-pr-comments">
        <h3>{S.lay.prSecComments}</h3>
        {comments}
      </section>
    </div>
  );
}

export function TicketPrTab({ ticketKey }: { ticketKey: string }) {
  return (
    <TicketPrBody
      ticketKey={ticketKey}
      stages={<TicketPrStages ticketKey={ticketKey} />}
      review={<TicketReview ticketKey={ticketKey} />}
      comments={<TicketComments ticketKey={ticketKey} />}
    />
  );
}
