import { withTransaction, type Db } from "./database";

export type MemorySampleKind = "session" | "shipherd" | "system";

export interface MemorySampleRow {
  at: number;
  kind: MemorySampleKind;
  /** kind 为 session 时是 head 的 id。 */
  sessionId: string | null;
  totalKb: number;
  /** 各类别的明细（JSON 解析后）；没有为 null。 */
  detail: Record<string, number> | null;
}

/** 内存历史（WS-M A）：每 5 分钟一批，留 14 天。 */
export class MemorySamplesRepo {
  constructor(private readonly db: Db) {}

  insertMany(rows: MemorySampleRow[]): void {
    const stmt = this.db.prepare(`INSERT INTO memory_samples (at, kind, session_id, total_kb, detail) VALUES (?, ?, ?, ?, ?)`);
    withTransaction(this.db, () => {
      for (const r of rows) stmt.run(r.at, r.kind, r.sessionId, Math.round(r.totalKb), r.detail ? JSON.stringify(r.detail) : null);
    });
  }

  /** since 之后的行，按时间从早到晚。 */
  since(since: number, kind?: MemorySampleKind): MemorySampleRow[] {
    const rows = (
      kind
        ? this.db.prepare(`SELECT at, kind, session_id, total_kb, detail FROM memory_samples WHERE at >= ? AND kind = ? ORDER BY at, id`).all(since, kind)
        : this.db.prepare(`SELECT at, kind, session_id, total_kb, detail FROM memory_samples WHERE at >= ? ORDER BY at, id`).all(since)
    ) as { at: number; kind: MemorySampleKind; session_id: string | null; total_kb: number; detail: string | null }[];
    return rows.map((r) => ({ at: Number(r.at), kind: r.kind, sessionId: r.session_id, totalKb: Number(r.total_kb), detail: r.detail ? (JSON.parse(r.detail) as Record<string, number>) : null }));
  }

  /** 删掉 before 之前的；返回删掉的行数。 */
  prune(before: number): number {
    return Number(this.db.prepare(`DELETE FROM memory_samples WHERE at < ?`).run(before).changes);
  }
}
