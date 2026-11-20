import type { TicketGlance } from "../../shared/ticket-glance";
import type { Session } from "../../shared/types";

export interface GlanceDeps {
  /** 这个 ticket 的 session 的 head，最近活动的在前（和 TicketView.sessions 同一份）。 */
  headsOf(ticketKey: string): Pick<Session, "id" | "fixesSession">[];
  rootOf(id: string): string | null;
  lastReplyOf(id: string): { id: string; text: string; at: number | null } | null;
  contextOf(id: string): number | null;
  threshold(): number;
}

/** 一个 ticket 的概览：agent 最后说的话、主 session 的上下文占用、对话链的根。只读。 */
export function ticketGlance(ticketKey: string, d: GlanceDeps): TicketGlance {
  const heads = d.headsOf(ticketKey);
  const main = heads.find((h) => h.fixesSession === null) ?? heads[0];
  let lastSaid: TicketGlance["lastSaid"] = null;
  for (const h of heads) {
    const r = d.lastReplyOf(h.id);
    if (r) {
      lastSaid = { text: r.text, at: r.at };
      break;
    }
  }
  if (!main) return { rootSessionId: null, lastSaid, context: null };
  const tokens = d.contextOf(main.id);
  return {
    rootSessionId: d.rootOf(main.id),
    lastSaid,
    context: tokens === null ? null : { tokens, threshold: d.threshold() },
  };
}
