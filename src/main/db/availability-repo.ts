import type { AvailabilityHit, LessonsPause } from "../../shared/availability";
import type { Db } from "./database";

export interface StoredAvailability {
  current: AvailabilityHit | null;
  lastHit: AvailabilityHit | null;
  retryAt: number | null;
  backoffStep: number;
  lessonsPause: LessonsPause | null;
}

/** claude_availability 表（只有 id = 1 一行）：限流状态和复盘暂停，重启后接着用。 */
export class AvailabilityRepo {
  constructor(private db: Db, private log: (msg: string, err?: unknown) => void = () => undefined) {}

  load(): StoredAvailability | null {
    const row = this.db.prepare(`SELECT state FROM claude_availability WHERE id = 1`).get() as { state: string } | undefined;
    if (!row) return null;
    try {
      const s = JSON.parse(row.state) as StoredAvailability;
      if (typeof s !== "object" || s === null || typeof s.backoffStep !== "number") throw new Error("not an availability state");
      return s;
    } catch (e) {
      this.log("availability: stored state is unreadable, starting clean", e);
      return null;
    }
  }

  save(s: StoredAvailability, now: number): void {
    this.db
      .prepare(`INSERT INTO claude_availability (id, state, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
      .run(JSON.stringify(s), now);
  }
}
