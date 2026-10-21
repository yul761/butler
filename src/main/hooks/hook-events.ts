import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { normalizePromptText, type TranscriptState } from "../sessions/discovery";

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

export function applyHookEnvelope(
  env: HookEnvelope,
  deps: { sessions: SessionsRepo; tickets: TicketsRepo; transcriptState?: (sessionId: string) => TranscriptState },
): HookEffect {
  // 晚间 handoff、早间刷新、MCP 探测这些 Butler 自己的 claude 进程也会触发用户级 hook，全部忽略。
  if (isHeadlessEnvelope(env)) return { kind: "ignored", reason: "headless" };
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
    // handleExit 删掉的空 session：迟到的事件不能把它插回来。只有真正的 prompt，或者已有 transcript，才允许重建。
    if (sessions.wasForgotten(id) && event !== "UserPromptSubmit" && deps.transcriptState?.(id) !== "present") return;
    const inserted = sessions.insertIfAbsent({ id, ticketKey: key, cwd, origin: fromButler ? "butler" : "discovered", lastActivityAt: at, createdAt: at });
    if (inserted) return;
    sessions.fillDetails(id, { cwd, lastActivityAt: at });
    const cur = sessions.get(id);
    // 先被磁盘扫描发现、后来在 Butler 终端里续接的 session：来源升级为 butler。
    if (fromButler && cur && cur.origin === "discovered" && !cur.dismissed) sessions.setOrigin(id, "butler");
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
      // 只有新行真的存在时才指过去（ensure 可能因 tombstone 跳过了插入）；否则前一个 head 会指向一个不存在的行。
      if (prevHead && prevHead.id !== id && sessions.get(id)) {
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
