import type { HookEnvelope } from "../../shared/hook-envelope";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";

export type HookEffect =
  | { kind: "session_started"; sessionId: string; ticketKey: string | null; replaced: string | null }
  | { kind: "waiting"; sessionId: string; waiting: boolean }
  | { kind: "ended"; sessionId: string }
  | { kind: "ignored"; reason: string };

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function applyHookEnvelope(env: HookEnvelope, deps: { sessions: SessionsRepo; tickets: TicketsRepo }): HookEffect {
  const p = (env.payload && typeof env.payload === "object" ? env.payload : {}) as HookPayload;
  const event = str(p.hook_event_name);
  const id = str(p.session_id);
  if (!event || !id) return { kind: "ignored", reason: "missing_fields" };

  const { sessions, tickets } = deps;
  const at = env.receivedAt;
  const cwd = str(p.cwd) ?? "";
  // 这个终端当前对应的 session（/clear 之后 id 会变，BUTLER_SESSION 不变）。
  const prevHead = env.butlerSession ? sessions.head(env.butlerSession) : null;
  const envTicket = env.ticket && tickets.get(env.ticket) ? env.ticket : null;
  const ticketKey = envTicket ?? prevHead?.ticketKey ?? null;
  const fromButler = Boolean(env.butlerSession || env.ticket);

  // 事件可能乱序到达（例如 Stop 先于 SessionStart 被处理），所以每种事件都先确保 session 存在。
  const ensure = () => {
    const inserted = sessions.insertIfAbsent({ id, ticketKey, cwd, origin: fromButler ? "butler" : "discovered", lastActivityAt: at, createdAt: at });
    if (inserted) return;
    sessions.fillDetails(id, { cwd, lastActivityAt: at });
    if (ticketKey && !sessions.get(id)?.ticketKey) sessions.setTicket(id, ticketKey);
  };

  switch (event) {
    case "SessionStart": {
      ensure();
      let replaced: string | null = null;
      if (prevHead && prevHead.id !== id) {
        sessions.setReplacedBy(prevHead.id, id);
        replaced = prevHead.id;
      }
      return { kind: "session_started", sessionId: id, ticketKey, replaced };
    }
    case "Stop":
      ensure();
      sessions.setWaiting(id, true, at);
      return { kind: "waiting", sessionId: id, waiting: true };
    case "UserPromptSubmit":
      ensure();
      sessions.setWaiting(id, false, at);
      return { kind: "waiting", sessionId: id, waiting: false };
    case "SessionEnd":
      ensure();
      sessions.setWaiting(id, false, at);
      return { kind: "ended", sessionId: id };
    default:
      return { kind: "ignored", reason: `unhandled_event:${event}` };
  }
}
