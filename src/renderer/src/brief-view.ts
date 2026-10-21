import type { BriefItem, BriefSection } from "../../shared/brief";
import type { OpenSessionRequest, TicketView } from "../../shared/types";
import { S } from "./strings";

export const SECTION_ORDER: BriefSection[] = ["first", "today", "watch"];

export type ItemAction = "open" | "done" | "snooze" | "ignore" | "claim";

export function groupItems(items: BriefItem[]): { section: BriefSection; items: BriefItem[] }[] {
  return SECTION_ORDER.map((section) => ({ section, items: items.filter((i) => i.section === section) })).filter((g) => g.items.length > 0);
}

export function itemTitle(i: BriefItem): string {
  return S.briefRule[i.rule](i);
}

export function itemPrefill(i: BriefItem): string | null {
  const f = S.briefPrefill[i.rule];
  return f ? f(i).replace(/\s+/g, " ").trim() : null;
}

export function itemActions(i: BriefItem): ItemAction[] {
  return i.rule === "unclaimed" ? ["claim"] : ["open", "done", "snooze", "ignore"];
}

/** “打开”：恢复这个 ticket 最近的 session（ticket.sessions 已按最近活动排序），没有就新建；并预填提示。 */
export function openRequest(i: BriefItem, ticket: TicketView | undefined): OpenSessionRequest | null {
  if (!i.ticketKey || !ticket) return null;
  const prefill = itemPrefill(i);
  const recent = ticket.sessions[0];
  return { ticketKey: i.ticketKey, ...(recent ? { sessionId: recent.id } : {}), ...(prefill ? { prefill } : {}) };
}
