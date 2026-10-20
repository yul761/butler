import type { TicketStatus, TicketView } from "../../shared/types";
import { STATUS_ORDER } from "./strings";

export function groupTickets(tickets: TicketView[]): { status: TicketStatus; tickets: TicketView[] }[] {
  return STATUS_ORDER.map((status) => ({
    status,
    tickets: tickets
      .filter((t) => t.effectiveStatus === status)
      .sort((a, b) => Number(b.waiting) - Number(a.waiting) || a.key.localeCompare(b.key)),
  })).filter((g) => g.tickets.length > 0);
}
