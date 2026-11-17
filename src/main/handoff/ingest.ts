import type { Handoff, Pr } from "../../shared/handoff";
import type { HandoffTrigger, TicketStatus } from "../../shared/types";
import { rememberMergedPrs, splitOwnAndRemembered } from "../../shared/pr-memory";
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
  /** 存下来的 PR 列表链接到 ticket_prs。在事务里调用：抛错会让这条 handoff 一起回滚。 */
  linkPrs?: (ticketKey: string, prs: Pr[]) => void;
  /** ticket_prs 里这个 ticket 是否有链接的 PR 还开着。 */
  linkedOpen?: (ticketKey: string) => boolean;
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
  | { stored: false; reason: "no_ticket" | "duplicate" | "no_block" };

type StatusDeps = Pick<IngestDeps, "tickets" | "handoffs" | "followups" | "now" | "linkedOpen">;

const openFollowups = (d: StatusDeps, ticketKey: string): number =>
  d.followups.listByTicket(ticketKey).filter((f) => f.status === "open" || f.status === "snoozed").length;

/** 写入一条 handoff（只追加），合并 followups，重新推导 ticket 状态。全部在一个事务里。 */
export function ingestHandoff(d: IngestDeps, input: IngestInput): IngestResult {
  if (!d.tickets.get(input.ticketKey)) return { stored: false, reason: "no_ticket" };
  const now = d.now();
  const given = input.payload;
  const reported = given?.prs ?? [];
  return withTransaction(d.db, (): IngestResult => {
    // ticket 以 Butler 的记录为准，模型写错了也不影响归属。以前合并过的 PR 记着（模型这次没提、或者报错了状态）。
    const stored = given ? rememberMergedPrs(given.prs, [d.handoffs.knownPrs(input.ticketKey)]) : [];
    const payload = given ? { ...given, ticket: input.ticketKey, prs: stored } : null;
    const id = d.handoffs.insert({
      ticketKey: input.ticketKey, sessionId: input.sessionId, trigger: input.trigger, createdAt: now,
      payload, rawText: input.rawText, sourceRef: input.sourceRef ?? null,
    });
    if (id === null) return { stored: false, reason: "duplicate" };
    if (!payload) return { stored: true, handoffId: id, degraded: true, status: null };
    d.linkPrs?.(input.ticketKey, payload.prs);

    const plan = planFollowupMerge(d.followups.listByTicket(input.ticketKey), payload.followups, {
      ticketKey: input.ticketKey, now, newId: d.newFollowupId, source: "session",
    });
    for (const f of plan.inserts) d.followups.insert(f);
    for (const u of plan.updates) d.followups.update(u.id, u.patch);
    for (const fid of plan.done) d.followups.setStatus(fid, "done", now);
    // 状态按模型自己报的 PR 算；记着的和链接的只能让它保持 in_review。
    const { own, remembered } = splitOwnAndRemembered(reported, stored);
    const status = deriveStatus({ ...payload, prs: own }, openFollowups(d, input.ticketKey), { remembered, linkedOpen: d.linkedOpen?.(input.ticketKey) ?? false });
    d.tickets.setStatus(input.ticketKey, status, now);
    return { stored: true, handoffId: id, degraded: false, status };
  });
}

/**
 * followup 被手动完成/忽略/恢复后重新推导（例如最后一个合并后任务做完 → done）。没有完整 handoff 时不动。
 * 当前自动状态已经是 done / merged_pending_followup 时只按 followup 数在两者间切换；
 * 否则 handoff 里的 PR 都当“记着的”，只用来看有没有开着的，不会把 active 变成 done。
 */
export function rederiveTicketStatus(d: StatusDeps, ticketKey: string): TicketStatus | null {
  const latest = d.handoffs.latestValid(ticketKey);
  if (!latest?.payload) return null;
  const open = openFollowups(d, ticketKey);
  const current = d.tickets.get(ticketKey)?.status;
  const status =
    current === "done" || current === "merged_pending_followup"
      ? open > 0 ? "merged_pending_followup" : "done"
      : deriveStatus({ ...latest.payload, prs: [] }, open, { remembered: latest.payload.prs, linkedOpen: d.linkedOpen?.(ticketKey) ?? false });
  d.tickets.setStatus(ticketKey, status, d.now());
  return status;
}
