import type { Handoff } from "../../shared/handoff";
import type { HandoffRecord, HandoffTrigger } from "../../shared/types";
import type { Db } from "./database";

interface HandoffRow {
  id: number;
  ticket_key: string;
  session_id: string | null;
  trigger: string;
  created_at: number;
  payload: string | null;
  degraded: number;
  raw_text: string | null;
  source_ref: string | null;
}

function parsePayload(text: string | null): Handoff | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Handoff;
  } catch {
    return null;
  }
}

function toRecord(r: HandoffRow): HandoffRecord {
  const payload = parsePayload(r.payload);
  return {
    id: r.id,
    ticketKey: r.ticket_key,
    sessionId: r.session_id,
    trigger: r.trigger as HandoffTrigger,
    createdAt: r.created_at,
    payload,
    degraded: r.degraded === 1 || payload === null,
    rawText: r.raw_text,
    sourceRef: r.source_ref,
  };
}

export interface NewHandoff {
  ticketKey: string;
  sessionId: string | null;
  trigger: HandoffTrigger;
  createdAt: number;
  /** null 表示 degraded（校验失败）。 */
  payload: Handoff | null;
  rawText: string | null;
  /** /handoff 输出所在的 transcript 条目 uuid，用来去重。 */
  sourceRef?: string | null;
}

export class HandoffsRepo {
  constructor(private readonly db: Db) {}

  /** 只追加。sourceRef 重复（同一个 /handoff 输出被处理两次）时不插入，返回 null。 */
  insert(h: NewHandoff): number | null {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO handoffs (ticket_key, session_id, trigger, created_at, payload, degraded, raw_text, source_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(h.ticketKey, h.sessionId, h.trigger, h.createdAt, h.payload ? JSON.stringify(h.payload) : null, h.payload ? 0 : 1, h.rawText, h.sourceRef ?? null);
    return Number(r.changes) > 0 ? Number(r.lastInsertRowid) : null;
  }

  get(id: number): HandoffRecord | null {
    const row = this.db.prepare(`SELECT * FROM handoffs WHERE id = ?`).get(id) as HandoffRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 最新的在前。 */
  listByTicket(ticketKey: string, limit = 50): HandoffRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(ticketKey, limit) as unknown as HandoffRow[];
    return rows.map(toRecord);
  }

  /** 最新的一条（任何触发方式，可能是 degraded）。 */
  latest(ticketKey: string): HandoffRecord | null {
    return this.listByTicket(ticketKey, 1)[0] ?? null;
  }

  /** 最新的一条完整 handoff（含刷新）。payload 读不出来的行跳过，取下一条。 */
  latestValid(ticketKey: string): HandoffRecord | null {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? AND degraded = 0 AND payload IS NOT NULL ORDER BY created_at DESC, id DESC`)
      .iterate(ticketKey) as Iterable<HandoffRow>;
    for (const row of rows) {
      const rec = toRecord(row);
      if (rec.payload) return rec;
    }
    return null;
  }

  /** 最新的一条非刷新 handoff（任何有效性）；早间刷新不会把它顶掉。 */
  latestFull(ticketKey: string): HandoffRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? AND trigger != 'refresh' ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(ticketKey) as HandoffRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 最新的一条非刷新、payload 有效的 handoff。 */
  latestValidFull(ticketKey: string): HandoffRecord | null {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? AND trigger != 'refresh' AND degraded = 0 AND payload IS NOT NULL ORDER BY created_at DESC, id DESC`)
      .iterate(ticketKey) as Iterable<HandoffRow>;
    for (const row of rows) {
      const rec = toRecord(row);
      if (rec.payload) return rec;
    }
    return null;
  }

  /** 最近一次读过 session 的完整 handoff（不算早间刷新和不完整的）的时间；晚间批量据此判断有没有新活动。 */
  lastCapturedAt(ticketKey: string): number | null {
    const r = this.db.prepare(`SELECT MAX(created_at) AS at FROM handoffs WHERE ticket_key = ? AND trigger != 'refresh' AND degraded = 0`).get(ticketKey) as
      | { at: number | null }
      | undefined;
    return r?.at ?? null;
  }

  /** created_at 在 [fromMs, toMs) 之间，旧的在前。 */
  listBetween(fromMs: number, toMs: number): HandoffRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id`)
      .all(fromMs, toMs) as unknown as HandoffRow[];
    return rows.map(toRecord);
  }
}
