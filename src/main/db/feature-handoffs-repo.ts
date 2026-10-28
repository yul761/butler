import type { FeatureHandoff } from "../../shared/handoff";
import type { FeatureHandoffRecord, FeatureHandoffTrigger } from "../../shared/types";
import type { Db } from "./database";

interface FeatureHandoffRow {
  id: number;
  feature_id: number;
  session_id: string | null;
  trigger: string;
  created_at: number;
  covers_until: number | null;
  payload: string | null;
  degraded: number;
  raw_text: string | null;
  source_ref: string | null;
}

function parsePayload(text: string | null): FeatureHandoff | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as FeatureHandoff;
  } catch {
    return null;
  }
}

function toRecord(r: FeatureHandoffRow): FeatureHandoffRecord {
  const payload = parsePayload(r.payload);
  return {
    id: Number(r.id),
    featureId: Number(r.feature_id),
    sessionId: r.session_id,
    trigger: r.trigger as FeatureHandoffTrigger,
    createdAt: r.created_at,
    coversUntil: r.covers_until,
    payload,
    degraded: r.degraded === 1 || payload === null,
    rawText: r.raw_text,
    sourceRef: r.source_ref,
  };
}

export interface NewFeatureHandoff {
  featureId: number;
  sessionId: string | null;
  trigger: FeatureHandoffTrigger;
  createdAt: number;
  /** null 表示 degraded（校验失败）。 */
  payload: FeatureHandoff | null;
  rawText: string | null;
  /** /handoff 输出所在的 transcript 条目 uuid，用来去重。 */
  sourceRef?: string | null;
}

/** feature 汇总，和 handoffs 一样只追加（covers_until 例外，只从 NULL 写一次）。 */
export class FeatureHandoffsRepo {
  constructor(private readonly db: Db) {}

  /** sourceRef 重复时不插入，返回 null。 */
  insert(h: NewFeatureHandoff): number | null {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO feature_handoffs (feature_id, session_id, trigger, created_at, payload, degraded, raw_text, source_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(h.featureId, h.sessionId, h.trigger, h.createdAt, h.payload ? JSON.stringify(h.payload) : null, h.payload ? 0 : 1, h.rawText, h.sourceRef ?? null);
    return Number(r.changes) > 0 ? Number(r.lastInsertRowid) : null;
  }

  get(id: number): FeatureHandoffRecord | null {
    const row = this.db.prepare(`SELECT * FROM feature_handoffs WHERE id = ?`).get(id) as FeatureHandoffRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 最新的在前。 */
  listByFeature(featureId: number, limit = 50): FeatureHandoffRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM feature_handoffs WHERE feature_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(featureId, limit) as unknown as FeatureHandoffRow[];
    return rows.map(toRecord);
  }

  /** 最新的一条（可能是 degraded）。 */
  latest(featureId: number): FeatureHandoffRecord | null {
    return this.listByFeature(featureId, 1)[0] ?? null;
  }

  /** 最新的一条完整汇总；payload 读不出来的行跳过，取下一条。 */
  latestValid(featureId: number): FeatureHandoffRecord | null {
    const rows = this.db
      .prepare(`SELECT * FROM feature_handoffs WHERE feature_id = ? AND degraded = 0 AND payload IS NOT NULL ORDER BY created_at DESC, id DESC`)
      .iterate(featureId) as Iterable<FeatureHandoffRow>;
    for (const row of rows) {
      const rec = toRecord(row);
      if (rec.payload) return rec;
    }
    return null;
  }

  /** 只在当前为 NULL 时写，写过的不改。 */
  setCoversUntil(id: number, at: number): void {
    this.db.prepare(`UPDATE feature_handoffs SET covers_until = ? WHERE id = ? AND covers_until IS NULL`).run(at, id);
  }
}
