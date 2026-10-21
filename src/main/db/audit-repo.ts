import type { AuditEntry, AuditStatus, PrivacyLevel, ScanHit } from "../../shared/llm";
import type { Db } from "./database";

/** 审计里每段文本的上限：响应异常大时也不会把数据库撑爆。 */
export const AUDIT_TEXT_LIMIT = 200_000;

interface AuditRow {
  id: number;
  ts: number;
  provider: string;
  model: string;
  level: string;
  status: string;
  payload_sent: string | null;
  response: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  blocked_reason: string | null;
  error: string | null;
}

const cap = (s: string | null | undefined): string | null => (s == null ? null : s.length > AUDIT_TEXT_LIMIT ? s.slice(0, AUDIT_TEXT_LIMIT) : s);

function parseHits(text: string | null): ScanHit[] | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? (v as ScanHit[]) : null;
  } catch {
    return null;
  }
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    ts: r.ts,
    provider: r.provider,
    model: r.model,
    level: r.level as PrivacyLevel,
    status: r.status as AuditStatus,
    payloadSent: r.payload_sent,
    response: r.response,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    blockedReason: parseHits(r.blocked_reason),
    error: r.error,
  };
}

export interface NewAudit {
  ts: number;
  provider: string;
  model: string;
  level: PrivacyLevel;
  status: AuditStatus;
  /** 原样的请求体；拒发 / 超预算时为 null（什么都没发，被拦下的内容也不落盘）。 */
  payloadSent: string | null;
  blockedReason?: ScanHit[] | null;
  error?: string | null;
}

export interface AuditFinish {
  status: "sent" | "failed" | "declined";
  /** 最终发出的请求体和第一次不同时（换了 token 参数名重试）传入。 */
  payloadSent?: string;
  response?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  error?: string | null;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  insert(a: NewAudit): number {
    const r = this.db
      .prepare(
        `INSERT INTO llm_audit (ts, provider, model, level, status, payload_sent, blocked_reason, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.ts, a.provider, a.model, a.level, a.status, cap(a.payloadSent), a.blockedReason ? JSON.stringify(a.blockedReason) : null, cap(a.error));
    return Number(r.lastInsertRowid);
  }

  finish(id: number, f: AuditFinish): void {
    this.db
      .prepare(
        `UPDATE llm_audit SET status = ?, payload_sent = COALESCE(?, payload_sent), response = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, error = ?
         WHERE id = ?`,
      )
      .run(f.status, cap(f.payloadSent), cap(f.response), f.tokensIn ?? null, f.tokensOut ?? null, f.costUsd ?? null, cap(f.error), id);
  }

  /** 新的在前；beforeId 用来翻页。 */
  list(limit = 50, beforeId?: number): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM llm_audit WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
      .all(beforeId ?? null, beforeId ?? null, limit) as unknown as AuditRow[];
    return rows.map(toEntry);
  }

  costSince(ms: number): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM llm_audit WHERE ts >= ?`).get(ms) as { c: number };
    return r.c;
  }

  /** 删掉 beforeMs 之前的记录（保留期，设计文档 7.7）。 */
  prune(beforeMs: number): number {
    return Number(this.db.prepare(`DELETE FROM llm_audit WHERE ts < ?`).run(beforeMs).changes);
  }
}
