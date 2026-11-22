import { AUDIT_KINDS, type AuditKind, type ExternalActionEntry, type ExternalOutcome } from "../../shared/external";
import type { Db } from "./database";

/** 审计里每段文本的上限：内容异常大时也不会把数据库撑爆。 */
export const AUDIT_TEXT_LIMIT = 200_000;

interface Row {
  id: number;
  ts: number;
  kind: string;
  repo_slug: string | null;
  ticket_key: string | null;
  target: string | null;
  summary: string;
  payload: string | null;
  outcome: ExternalOutcome;
  error: string | null;
}

/** 截断到上限，且不把代理对从中间切开。 */
function cap(s: string | null | undefined, limit = AUDIT_TEXT_LIMIT): string | null {
  if (s == null) return null;
  if (s.length <= limit) return s;
  let end = limit;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

const isKind = (k: string): k is AuditKind => (AUDIT_KINDS as readonly string[]).includes(k);

export type NewExternalAction = Omit<ExternalActionEntry, "id">;

/** 对外动作的审计（契约 4.8）：做了、失败了、开关关着没做（skipped），都记一笔。 */
export class ExternalAuditRepo {
  constructor(private readonly db: Db) {}

  insert(e: NewExternalAction): number {
    const r = this.db
      .prepare(
        `INSERT INTO external_action_audit (ts, kind, repo_slug, ticket_key, target, summary, payload, outcome, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.ts, e.kind, e.repoSlug, e.ticketKey, cap(e.target, 2000), cap(e.summary, 2000) ?? "", cap(e.payload), e.outcome, cap(e.error, 4000));
    return Number(r.lastInsertRowid);
  }

  /** 新的在前；kind 给了只看那一种。 */
  list(opts: { limit?: number; kind?: AuditKind } = {}): ExternalActionEntry[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    // 以后的版本加了新种类、又退回老版本时，不认识的种类不显示（在 SQL 里筛，LIMIT 才准）。
    const kinds = opts.kind ? [opts.kind] : [...AUDIT_KINDS];
    const rows = this.db
      .prepare(`SELECT * FROM external_action_audit WHERE kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...kinds, limit) as unknown as Row[];
    return rows.filter((r) => isKind(r.kind)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), kind: r.kind as AuditKind, repoSlug: r.repo_slug, ticketKey: r.ticket_key, target: r.target,
      summary: r.summary, payload: r.payload, outcome: r.outcome, error: r.error,
    }));
  }

  /** 删掉 beforeMs 之前的（保留期和 LLM 审计一样，auditRetentionDays）。 */
  prune(beforeMs: number): number {
    return Number(this.db.prepare(`DELETE FROM external_action_audit WHERE ts < ?`).run(beforeMs).changes);
  }
}
