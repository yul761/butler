// ticket 页「PR 详情」页签（UI 重做第 3 层）：阶段、CI · review · 风险 · 就绪、未处理的评论，上下依次摆，三个组件内部不动。
import type { ReactNode } from "react";
import { S } from "../strings";
import { TicketPrStages } from "./PrStages";
import { TicketComments } from "./TicketComments";
import { TicketReview } from "./TicketReview";

/** 只负责摆放三块的位置和小标题。 */
export function TicketPrBody({ stages, review, comments }: { stages: ReactNode; review: ReactNode; comments: ReactNode }) {
  return (
    <div className="ticket-pr">
      <section className="ticket-pr-stages">
        <h3>{S.lay.prSecStages}</h3>
        {stages}
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
      stages={<TicketPrStages ticketKey={ticketKey} />}
      review={<TicketReview ticketKey={ticketKey} />}
      comments={<TicketComments ticketKey={ticketKey} />}
    />
  );
}
