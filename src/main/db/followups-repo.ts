import type { Followup, FollowupKind, FollowupSource, FollowupStatus, FollowupTrigger } from "../../shared/types";
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

  /** 所有未归档 ticket 的 followups（简报用）。 */
  listActiveTickets(): Followup[] {
    const rows = this.db
      .prepare(`SELECT f.* FROM followups f JOIN tickets t ON t.key = f.ticket_key WHERE t.archived_at IS NULL ORDER BY f.created_at, f.id`)
      .all() as unknown as FollowupRow[];
    return rows.map(toFollowup);
  }

  update(id: string, p: FollowupPatch): void {
    const cur = this.get(id);
    if (!cur) return;
    this.db
      .prepare(`UPDATE followups SET kind = ?, description = ?, trigger = ?, due_date = ? WHERE id = ?`)
      .run(p.kind ?? cur.kind, p.description ?? cur.description, p.trigger ?? cur.trigger, p.dueDate !== undefined ? p.dueDate : cur.dueDate, id);
  }

  /** done 记录完成时间；snoozed 记录推迟到哪天；其他状态清空这两项。 */
  setStatus(id: string, status: FollowupStatus, at: number, snoozedUntil: string | null = null): void {
    this.db
      .prepare(`UPDATE followups SET status = ?, done_at = ?, snoozed_until = ? WHERE id = ?`)
      .run(status, status === "done" ? at : null, status === "snoozed" ? snoozedUntil : null, id);
  }
}
