import type { Turn } from "../../shared/turn";

export const TICKET_TABS = ["overview", "conversation", "terminal", "pr", "log"] as const;
export type TicketTab = (typeof TICKET_TABS)[number];
export const SCOPE_TABS = ["overview", "running", "tickets", "control", "summary"] as const;
export type ScopeTab = (typeof SCOPE_TABS)[number];

/**
 * 从「去看看」进 ticket 页时落在哪个页签：要回答它、看它为什么卡住 -> conversation（对话 tab 里能看前因后果、能直接发话）；
 * agent 停了要看现场 -> terminal；要看 CI、评论、在等什么 -> pr；其余主按钮就在概况里。
 */
export function landingTab(turn: Turn): TicketTab {
  switch (turn.owner) {
    case "you":
      switch (turn.kind) {
        case "answer":
        case "stuck":
          return "conversation";
        case "unattended":
          return turn.why === "agent_stopped" ? "terminal" : "pr";
        default:
          return "overview";
      }
    case "external":
      return "pr";
    default:
      return "overview";
  }
}
