import type { AuditEntry, AuditStatus, PrivacyLevel, ScanHit } from "../../shared/llm";
import type { Db } from "./database";

/** 审计里每段文本的上限：响应异常大时也不会把数据库撑爆。 */
export const AUDIT_TEXT_LIMIT = 200_000;

/** 这些状态下什么都没发出去：请求体和响应一律不落盘。 */
const NO_PAYLOAD_STATUSES: ReadonlySet<string> = new Set<AuditStatus>(["blocked", "budget", "declined"]);

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

/** 截断到 AUDIT_TEXT_LIMIT，且不把代理对（surrogate pair）从中间切开。 */
function cap(s: string | null | undefined): string | null {
  if (s == null) return null;
  if (s.length <= AUDIT_TEXT_LIMIT) return s;
  let end = AUDIT_TEXT_LIMIT;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

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

interface NewAuditCommon {
  ts: number;
  provider: string;
  model: string;
  level: PrivacyLevel;
  blockedReason?: ScanHit[] | null;
  error?: string | null;
}

/**
 * 写入审计时的请求行。已经发出（或正要发出）的状态必须带请求体；
 * blocked / budget / declined 没有发出任何东西，类型上就不允许带请求体（仓库层也会强制为 NULL）。
 */
export type NewAudit =
  | (NewAuditCommon & { status: "pending" | "sent" | "failed"; payloadSent: string | null })
  | (NewAuditCommon & { status: "blocked" | "budget" | "declined"; payloadSent?: null });

interface AuditFinishCommon {
  response?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  error?: string | null;
}

/**
 * payloadSent：最终发出的请求体和第一次不同时（换了 token 参数名重试）传入；省略时保留之前记录的请求体。
 * null 表示其实什么都没发出去（例如连接前就失败），清空 pending 时记下的请求体：只有 failed / declined 可以这样传。
 * declined 时请求体一律不落盘。
 */
export type AuditFinish =
  | (AuditFinishCommon & { status: "sent"; payloadSent?: string })
  | (AuditFinishCommon & { status: "failed" | "declined"; payloadSent?: string | null });

export class AuditRepo {
  constructor(private readonly db: Db) {}

  insert(a: NewAudit): number {
    const payload = NO_PAYLOAD_STATUSES.has(a.status) ? null : cap(a.payloadSent ?? null);
    const r = this.db
      .prepare(
        `INSERT INTO llm_audit (ts, provider, model, level, status, payload_sent, blocked_reason, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.ts, a.provider, a.model, a.level, a.status, payload, a.blockedReason ? JSON.stringify(a.blockedReason) : null, cap(a.error));
    return Number(r.lastInsertRowid);
  }

  finish(id: number, f: AuditFinish): void {
    if (f.status === "sent" && (f as { payloadSent?: string | null }).payloadSent === null) {
      throw new Error("a sent request always has a body");
    }
    // declined 清空请求体和响应，payloadSent: null 清空请求体；其余字段缺省时保留之前记录的值（例如花费不会被后续的 failed 清零）。
    this.db
      .prepare(
        `UPDATE llm_audit SET
           status = ?,
           payload_sent = CASE WHEN ? = 'declined' OR ? = 1 THEN NULL ELSE COALESCE(?, payload_sent) END,
           response = CASE WHEN ? = 'declined' THEN NULL ELSE COALESCE(?, response) END,
           tokens_in = COALESCE(?, tokens_in),
           tokens_out = COALESCE(?, tokens_out),
           cost_usd = COALESCE(?, cost_usd),
           error = ?
         WHERE id = ?`,
      )
      .run(
        f.status,
        f.status,
        f.payloadSent === null ? 1 : 0,
        cap(f.payloadSent ?? null),
        f.status,
        cap(f.response ?? null),
        f.tokensIn ?? null,
        f.tokensOut ?? null,
        f.costUsd ?? null,
        cap(f.error ?? null),
        id,
      );
  }

  /** 新的在前；beforeId 用来翻页。limit 限制在 1..500。 */
  list(limit = 50, beforeId?: number): AuditEntry[] {
    const n = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.trunc(limit))) : 50;
    const rows = this.db
      .prepare(`SELECT * FROM llm_audit WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
      .all(beforeId ?? null, beforeId ?? null, n) as unknown as AuditRow[];
    return rows.map(toEntry);
  }

  costSince(ms: number): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM llm_audit WHERE ts >= ?`).get(ms) as { c: number };
    return r.c;
  }

  /**
   * 启动时调用：上次运行退出时还停在 pending 的记录一律改成 failed，返回改了几条。
   * 请求体保留：退出前可能已经发出去了，用户要能看到。
   */
  failStalePending(error: string): number {
    return Number(this.db.prepare(`UPDATE llm_audit SET status = 'failed', error = ? WHERE status = 'pending'`).run(cap(error)).changes);
  }

  /** 删掉 beforeMs 之前的记录（保留期，设计文档 7.7）。 */
  prune(beforeMs: number): number {
    return Number(this.db.prepare(`DELETE FROM llm_audit WHERE ts < ?`).run(beforeMs).changes);
  }
}
