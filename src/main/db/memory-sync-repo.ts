import type { Db } from "./database";

/** 每个 ticket 已经写进 StateCore 的最新 handoff id（handoff 和 learnings 只写一次；决策和 followup 每次都按现状比对）。 */
export class MemorySyncRepo {
  constructor(private readonly db: Db) {}

  /** 还没同步过时为 0。 */
  cursor(ticketKey: string): number {
    const r = this.db.prepare(`SELECT handoff_id FROM memory_sync WHERE ticket_key = ?`).get(ticketKey) as { handoff_id: number } | undefined;
    return r?.handoff_id ?? 0;
  }

  /** 只往前走：并发的两次同步里后完成的那次不会把游标拨回去。 */
  setCursor(ticketKey: string, handoffId: number, at: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_sync (ticket_key, handoff_id, synced_at) VALUES (?, ?, ?)
         ON CONFLICT(ticket_key) DO UPDATE SET handoff_id = MAX(handoff_id, excluded.handoff_id), synced_at = excluded.synced_at`,
      )
      .run(ticketKey, handoffId, at);
  }
}
