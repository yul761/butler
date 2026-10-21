import { createHash } from "node:crypto";
import { HandoffSchema } from "../../shared/handoff";
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { IngestInput, IngestResult } from "./ingest";
import { parseJsonLoose, validate } from "./schema";
import { findHandoffBlock, readLastTurn, type FoundHandoff } from "./transcript";

export interface StopEvent {
  sessionId: string;
  transcriptPath: string;
}

/** Stop 事件里的 session 和 transcript 路径；Butler 自己的 headless 运行不算。 */
export function stopFromEnvelope(env: HookEnvelope): StopEvent | null {
  if (isHeadlessEnvelope(env)) return null;
  const p = (env.payload && typeof env.payload === "object" ? env.payload : {}) as Record<string, unknown>;
  if (p.hook_event_name !== "Stop") return null;
  const sessionId = typeof p.session_id === "string" ? p.session_id : "";
  const transcriptPath = typeof p.transcript_path === "string" ? p.transcript_path : "";
  return sessionId && transcriptPath ? { sessionId, transcriptPath } : null;
}

export interface CaptureDeps {
  sessions: SessionsRepo;
  tickets: TicketsRepo;
  ingest: (input: IngestInput) => IngestResult;
}

/**
 * Stop 之后看这一轮有没有 /handoff 的输出，有就入库（trigger=command）。
 * 归属：session 已挂的 ticket；没挂的话用代码块里写的 ticket（必须已存在）。
 * 读不到文件或没有代码块时返回 null。
 */
export async function captureCommandHandoff(d: CaptureDeps, stop: StopEvent): Promise<IngestResult | null> {
  let found: FoundHandoff | null;
  try {
    found = findHandoffBlock(await readLastTurn(stop.transcriptPath));
  } catch {
    return null;
  }
  if (!found) return null;
  const checked = validate(HandoffSchema, parseJsonLoose(found.block));
  const claimed = checked.ok ? checked.value.ticket.trim().toUpperCase() : null;
  const ticketKey = d.sessions.get(stop.sessionId)?.ticketKey ?? (claimed && d.tickets.get(claimed) ? claimed : null);
  if (!ticketKey) return { stored: false, reason: "no_ticket" };
  const sourceRef = found.uuid ?? `${stop.sessionId}:${createHash("sha1").update(found.block).digest("hex")}`;
  return d.ingest({
    ticketKey, sessionId: stop.sessionId, trigger: "command",
    payload: checked.ok ? checked.value : null, rawText: found.block, sourceRef,
  });
}
