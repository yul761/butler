import type { Followup, FollowupKind, FollowupSource, FollowupStatus, FollowupTrigger, TicketCloseSource } from "../../shared/types";
import type { Db } from "./database";

interface FollowupRow {
  id: string;
  ticket_key: string;
  kind: string;
  description: string;
  trigger: string;
  due_date: string | null;
  status: string;
  snoozed_until: string | null;
  source: string;
  created_at: number;
  done_at: number | null;
  resolved_reason?: string | null;
  resolved_source?: string | null;
  ignored_by_close?: number;
}

function toFollowup(r: FollowupRow): Followup {
  return {
    id: r.id,
    ticketKey: r.ticket_key,
    kind: r.kind as FollowupKind,
    description: r.description,
    trigger: r.trigger as FollowupTrigger,
    dueDate: r.due_date,
    status: r.status as FollowupStatus,
    snoozedUntil: r.snoozed_until,
    source: r.source as FollowupSource,
    createdAt: r.created_at,
    doneAt: r.done_at,
    resolvedReason: r.resolved_reason ?? null,
    resolvedSource: (r.resolved_source ?? null) as TicketCloseSource | null,
    ignoredByClose: r.ignored_by_close === 1,
  };
}

export interface FollowupPatch {
  kind?: FollowupKind;
  description?: string;
  trigger?: FollowupTrigger;
  dueDate?: string | null;
}

export class FollowupsRepo {
  constructor(private readonly db: Db) {}

  insert(f: Followup): void {
    this.db
      .prepare(
        `INSERT INTO followups (id, ticket_key, kind, description, trigger, due_date, status, snoozed_until, source, created_at, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.id, f.ticketKey, f.kind, f.description, f.trigger, f.dueDate, f.status, f.snoozedUntil, f.source, f.createdAt, f.doneAt);
  }

  get(id: string): Followup | null {
    const row = this.db.prepare(`SELECT * FROM followups WHERE id = ?`).get(id) as FollowupRow | undefined;
    return row ? toFollowup(row) : null;
  }

  listByTicket(ticketKey: string): Followup[] {
    const rows = this.db.prepare(`SELECT * FROM followups WHERE ticket_key = ? ORDER BY created_at, id`).all(ticketKey) as unknown as FollowupRow[];
    return rows.map(toFollowup);
  }

  /** 所有没处理完的（open、snoozed），按 ticket、创建时间排。 */
  listOpen(): Followup[] {
    const rows = this.db.prepare(`SELECT * FROM followups WHERE status IN ('open', 'snoozed') ORDER BY ticket_key, created_at, id`).all() as unknown as FollowupRow[];
    return rows.map(toFollowup);
  }

  update(id: string, p: FollowupPatch): void {
    const cur = this.get(id);
    if (!cur) return;
    this.db
      .prepare(`UPDATE followups SET kind = ?, description = ?, trigger = ?, due_date = ? WHERE id = ?`)
      .run(p.kind ?? cur.kind, p.description ?? cur.description, p.trigger ?? cur.trigger, p.dueDate !== undefined ? p.dueDate : cur.dueDate, id);
  }

  /** done 记录完成时间；snoozed 记录推迟到哪天；其他状态清空这两项。原因、来源、关 ticket 时记的旧状态都清掉：用户重新处理过了。 */
  setStatus(id: string, status: FollowupStatus, at: number, snoozedUntil: string | null = null): void {
    this.db
      .prepare(
        `UPDATE followups SET status = ?, done_at = ?, snoozed_until = ?, resolved_reason = NULL, resolved_source = NULL,
           ignored_by_close = 0, prior_status = NULL, prior_snoozed_until = NULL WHERE id = ?`,
      )
      .run(status, status === "done" ? at : null, status === "snoozed" ? snoozedUntil : null, id);
  }

  /** 总控处理一条后续事项（resolve_followup）：标成完成或忽略，记下原因和来源。 */
  resolve(id: string, status: "done" | "ignored", at: number, reason: string, source: TicketCloseSource): void {
    this.db
      .prepare(
        `UPDATE followups SET status = ?, done_at = ?, snoozed_until = NULL, resolved_reason = ?, resolved_source = ?,
           ignored_by_close = 0, prior_status = NULL, prior_snoozed_until = NULL WHERE id = ?`,
      )
      .run(status, status === "done" ? at : null, reason, source, id);
  }

  /** 关 ticket：没处理完的（open、snoozed）都标成忽略，记下原来的状态，重新打开时还原。返回改了几条。 */
  ignoreForClose(ticketKey: string, reason: string, source: TicketCloseSource): number {
    const r = this.db
      .prepare(
        `UPDATE followups SET prior_status = status, prior_snoozed_until = snoozed_until, status = 'ignored', snoozed_until = NULL,
           ignored_by_close = 1, resolved_reason = ?, resolved_source = ? WHERE ticket_key = ? AND status IN ('open', 'snoozed')`,
      )
      .run(reason, source, ticketKey);
    return Number(r.changes);
  }

  /** 重新打开 ticket：关的时候忽略的、之后没人动过的，还原成原来的状态。返回还原了几条。 */
  restoreAfterReopen(ticketKey: string): number {
    const r = this.db
      .prepare(
        `UPDATE followups SET status = COALESCE(prior_status, 'open'), snoozed_until = prior_snoozed_until, ignored_by_close = 0,
           prior_status = NULL, prior_snoozed_until = NULL, resolved_reason = NULL, resolved_source = NULL
         WHERE ticket_key = ? AND ignored_by_close = 1 AND status = 'ignored'`,
      )
      .run(ticketKey);
    return Number(r.changes);
  }
}
