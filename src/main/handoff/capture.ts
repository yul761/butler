import { createHash } from "node:crypto";
import { HandoffSchema, upgradeLegacyPr } from "../../shared/handoff";
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { IngestInput, IngestResult } from "./ingest";
import { parseJsonLoose, validate } from "./schema";
import { findHandoffBlock, readLastTurnInfo, type FoundHandoff } from "./transcript";

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
  /** 测试注入；默认真的等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Stop hook 有时比 claude 把最后一条回答写进 transcript 还早（Windows 上更常见）：认出是 /handoff、却还没有代码块时，
 * 隔一会儿再读，最多再读这么多次（共约 7 秒）。
 */
export const CAPTURE_RETRY_MS = [500, 1500, 5000];

/**
 * Stop 之后看这一轮有没有 /handoff 的输出，有就入库（trigger=command）。
 * 归属：session 已挂的 ticket；没挂的话用代码块里写的 ticket（必须已存在）。
 * 不是 /handoff、或读不到文件时返回 null；是 /handoff 但等了几次都没有代码块时返回 no_block（调用方记日志）。
 */
export async function captureCommandHandoff(d: CaptureDeps, stop: StopEvent): Promise<IngestResult | null> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let found: FoundHandoff | null;
  for (let attempt = 0; ; attempt++) {
    try {
      const last = await readLastTurnInfo(stop.transcriptPath);
      if (!last.isHandoffCommand) return null; // 只收 /handoff 的输出，不收 assistant 随口引用的代码块。
      found = findHandoffBlock(last.turn);
    } catch {
      return null;
    }
    if (found || attempt >= CAPTURE_RETRY_MS.length) break;
    await sleep(CAPTURE_RETRY_MS[attempt]);
  }
  if (!found) return { stored: false, reason: "no_block" };
  // 旧版本的 /handoff 命令输出单个 pr：先换成 prs 再校验。
  const checked = validate(HandoffSchema, upgradeLegacyPr(parseJsonLoose(found.block)));
  const claimed = checked.ok ? checked.value.ticket.trim().toUpperCase() : null;
  const ticketKey = d.sessions.get(stop.sessionId)?.ticketKey ?? (claimed && d.tickets.get(claimed) ? claimed : null);
  if (!ticketKey) return { stored: false, reason: "no_ticket" };
  const sourceRef = found.uuid ?? `${stop.sessionId}:${createHash("sha1").update(found.block).digest("hex")}`;
  return d.ingest({
    ticketKey, sessionId: stop.sessionId, trigger: "command",
    payload: checked.ok ? checked.value : null, rawText: found.block, sourceRef,
  });
}
