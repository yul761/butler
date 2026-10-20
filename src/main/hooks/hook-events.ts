import type { HookEnvelope } from "../../shared/hook-envelope";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { normalizePromptText } from "../sessions/discovery";

export type HookEffect =
  | { kind: "session_started"; sessionId: string; ticketKey: string | null; replaced: string | null }
  | { kind: "nested"; sessionId: string }
  | { kind: "waiting"; sessionId: string; waiting: boolean }
  | { kind: "ended"; sessionId: string }
  | { kind: "ignored"; reason: string };

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  source?: unknown;
  prompt?: unknown;
}

/** 只有这些来源才是同一个终端里“换了 id 的延续”；其余视为嵌套的 claude 进程。 */
const CHAIN_SOURCES = new Set(["clear", "compact", "resume"]);

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
  const ensure = (key: string | null = ticketKey) => {
    const inserted = sessions.insertIfAbsent({ id, ticketKey: key, cwd, origin: fromButler ? "butler" : "discovered", lastActivityAt: at, createdAt: at });
    if (inserted) return;
    sessions.fillDetails(id, { cwd, lastActivityAt: at });
    const cur = sessions.get(id);
    // 被忽略（dismissed）的 session，例如嵌套的 claude 进程，永远不挂 ticket。
    if (key && cur && !cur.ticketKey && !cur.dismissed) sessions.setTicket(id, key);
  };

  switch (event) {
    case "SessionStart": {
      const source = str(p.source);
      if (prevHead && prevHead.id !== id && !(source && CHAIN_SOURCES.has(source))) {
        // 终端里嵌套启动的 claude（如 `claude -p`）继承了 BUTLER_SESSION，但不是这个终端的会话。
        ensure(null);
        if (sessions.get(id)?.ticketKey) sessions.setTicket(id, null);
        sessions.dismiss(id);
        return { kind: "nested", sessionId: id };
      }
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
      {
        const prompt = typeof p.prompt === "string" ? normalizePromptText(p.prompt) : null;
        if (prompt) sessions.fillDetails(id, { firstPrompt: prompt });
      }
      return { kind: "waiting", sessionId: id, waiting: false };
    case "SessionEnd":
      ensure();
      sessions.setWaiting(id, false, at);
      return { kind: "ended", sessionId: id };
    default:
      return { kind: "ignored", reason: `unhandled_event:${event}` };
  }
}
