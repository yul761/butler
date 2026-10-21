import type { Handoff } from "../../shared/handoff";
import type { HandoffTrigger, TicketStatus } from "../../shared/types";
import { withTransaction, type Db } from "../db/database";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { planFollowupMerge } from "./followup-merge";
import { deriveStatus } from "./status";

export interface IngestDeps {
  db: Db;
  tickets: TicketsRepo;
  handoffs: HandoffsRepo;
  followups: FollowupsRepo;
  now: () => number;
  newFollowupId: () => string;
}

export interface IngestInput {
  ticketKey: string;
  sessionId: string | null;
  trigger: HandoffTrigger;
  /** 校验通过的 handoff；null 表示 degraded。 */
  payload: Handoff | null;
  rawText: string | null;
  sourceRef?: string | null;
}

export type IngestResult =
  | { stored: true; handoffId: number; degraded: boolean; status: TicketStatus | null }
  | { stored: false; reason: "no_ticket" | "duplicate" };

type StatusDeps = Pick<IngestDeps, "tickets" | "handoffs" | "followups" | "now">;

function applyStatus(d: StatusDeps, ticketKey: string, payload: Handoff, now: number): TicketStatus {
  const open = d.followups.listByTicket(ticketKey).filter((f) => f.status === "open" || f.status === "snoozed").length;
  const status = deriveStatus(payload, open);
  d.tickets.setStatus(ticketKey, status, now);
  return status;
}

/** 写入一条 handoff（只追加），合并 followups，重新推导 ticket 状态。全部在一个事务里。 */
export function ingestHandoff(d: IngestDeps, input: IngestInput): IngestResult {
  if (!d.tickets.get(input.ticketKey)) return { stored: false, reason: "no_ticket" };
  const now = d.now();
  return withTransaction(d.db, (): IngestResult => {
    // ticket 以 Butler 的记录为准，模型写错了也不影响归属。
    const payload = input.payload ? { ...input.payload, ticket: input.ticketKey } : null;
    const id = d.handoffs.insert({
      ticketKey: input.ticketKey, sessionId: input.sessionId, trigger: input.trigger, createdAt: now,
      payload, rawText: input.rawText, sourceRef: input.sourceRef ?? null,
    });
    if (id === null) return { stored: false, reason: "duplicate" };
    if (!payload) return { stored: true, handoffId: id, degraded: true, status: null };

    const plan = planFollowupMerge(d.followups.listByTicket(input.ticketKey), payload.followups, {
      ticketKey: input.ticketKey, now, newId: d.newFollowupId, source: "session",
    });
    for (const f of plan.inserts) d.followups.insert(f);
    for (const u of plan.updates) d.followups.update(u.id, u.patch);
    for (const fid of plan.done) d.followups.setStatus(fid, "done", now);
    return { stored: true, handoffId: id, degraded: false, status: applyStatus(d, input.ticketKey, payload, now) };
  });
}

/** followup 被手动完成/忽略/恢复后重新推导（例如最后一个合并后任务做完 → done）。没有完整 handoff 时不动。 */
export function rederiveTicketStatus(d: StatusDeps, ticketKey: string): TicketStatus | null {
  const latest = d.handoffs.latestValid(ticketKey);
  if (!latest?.payload) return null;
  return applyStatus(d, ticketKey, latest.payload, d.now());
}
