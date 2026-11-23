import type { Db } from "./database";

/**
 * epic 记忆的溢出存档（BTL-246 §5）：StateCore 每个 scope 最多 30 条笔记，挤不下的旧笔记 Shipherd 先搬到这里，
 * 再渲染进 epic 记忆的 handoff（「以前的约定」）。source：ticket 或总控 session 写进 epic 记忆的是 "notes"，
 * 从旧 epic 记忆搬过来的是 "epic:<id>"（每个旧 epic 只搬一次）。
 */
export interface EpicArchiveEntry {
  id: number;
  featureId: number;
  text: string;
  source: string;
  /** 这条笔记原来写下的时间。 */
  notedAt: number;
  archivedAt: number;
}

interface Row {
  id: number;
  feature_id: number;
  text: string;
  source: string;
  noted_at: number;
  archived_at: number;
}

const toEntry = (r: Row): EpicArchiveEntry => ({
  id: Number(r.id), featureId: Number(r.feature_id), text: r.text, source: r.source, notedAt: r.noted_at, archivedAt: r.archived_at,
});

export class EpicArchiveRepo {
  constructor(private readonly db: Db) {}

  /** text 为空：只记下这个 source 搬过了（旧 epic 记忆里没有笔记时），list 不返回它。 */
  add(e: Omit<EpicArchiveEntry, "id">): void {
    this.db
      .prepare(`INSERT INTO epic_memory_archive (feature_id, text, source, noted_at, archived_at) VALUES (?, ?, ?, ?, ?)`)
      .run(e.featureId, e.text, e.source, e.notedAt, e.archivedAt);
  }

  /** 按原来写下的时间，从旧到新。 */
  list(featureId: number): EpicArchiveEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM epic_memory_archive WHERE feature_id = ? AND text <> '' ORDER BY noted_at, id`)
      .all(featureId) as unknown as Row[];
    return rows.map(toEntry);
  }

  has(featureId: number, source: string): boolean {
    return this.db.prepare(`SELECT 1 FROM epic_memory_archive WHERE feature_id = ? AND source = ? LIMIT 1`).get(featureId, source) !== undefined;
  }

  /** 只留最新的 max 条（按原来写下的时间），返回删掉的。 */
  trim(featureId: number, max: number): EpicArchiveEntry[] {
    const all = this.list(featureId);
    const drop = all.slice(0, Math.max(0, all.length - max));
    const st = this.db.prepare(`DELETE FROM epic_memory_archive WHERE id = ?`);
    for (const e of drop) st.run(e.id);
    return drop;
  }
}
