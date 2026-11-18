import type { CostEventKind, CostPauseScope, CostState, CostSubjectKind, CostUnit } from "../../shared/cost";
import type { Db } from "./database";

/** 一个 session（链的根 id）或 ticket 的熔断状态。 */
export interface CostRow {
  subjectKind: CostSubjectKind;
  subjectId: string;
  state: CostState;
  /** 触发时按策略算的上限（策略改了要知道）。 */
  cap: number | null;
  /** 用户点「继续并提高上限」以后的上限；策略的上限一变就作废。 */
  raisedCap: number | null;
  unit: CostUnit | null;
  spent: number;
  partial: boolean;
  scope: CostPauseScope | null;
  fromModel: string | null;
  toModel: string | null;
  trippedAt: number | null;
  pausedAt: number | null;
  pausedSpent: number | null;
  stoppedAt: number | null;
  takenOverAt: number | null;
  updatedAt: number;
}

interface DbRow {
  subject_kind: CostSubjectKind; subject_id: string; state: CostState; cap: number | null; raised_cap: number | null; unit: CostUnit | null;
  spent: number; partial: number; scope: CostPauseScope | null; from_model: string | null; to_model: string | null; tripped_at: number | null;
  paused_at: number | null; paused_spent: number | null; stopped_at: number | null; taken_over_at: number | null; updated_at: number;
}

const num = (v: number | null): number | null => (v === null ? null : Number(v));
const toRow = (r: DbRow): CostRow => ({
  subjectKind: r.subject_kind, subjectId: r.subject_id, state: r.state, cap: num(r.cap), raisedCap: num(r.raised_cap), unit: r.unit,
  spent: Number(r.spent), partial: Number(r.partial) === 1, scope: r.scope, fromModel: r.from_model, toModel: r.to_model,
  trippedAt: num(r.tripped_at), pausedAt: num(r.paused_at), pausedSpent: num(r.paused_spent), stoppedAt: num(r.stopped_at),
  takenOverAt: num(r.taken_over_at), updatedAt: Number(r.updated_at),
});

export interface CostEvent {
  id: number;
  at: number;
  subjectKind: CostSubjectKind;
  subjectId: string;
  kind: CostEventKind;
  spent: number | null;
  cap: number | null;
  unit: string | null;
  detail: string | null;
}

/** 成本熔断的状态和记录（工作流 L）。重启以后接着用：暂停的还是暂停。 */
export class CostRepo {
  constructor(private readonly db: Db) {}

  get(kind: CostSubjectKind, id: string): CostRow | null {
    const r = this.db.prepare(`SELECT * FROM cost_breaker WHERE subject_kind = ? AND subject_id = ?`).get(kind, id) as unknown as DbRow | undefined;
    return r ? toRow(r) : null;
  }

  all(): CostRow[] {
    return (this.db.prepare(`SELECT * FROM cost_breaker ORDER BY updated_at DESC`).all() as unknown as DbRow[]).map(toRow);
  }

  put(r: CostRow): void {
    this.db
      .prepare(
        `INSERT INTO cost_breaker (subject_kind, subject_id, state, cap, raised_cap, unit, spent, partial, scope, from_model, to_model, tripped_at, paused_at, paused_spent,
           stopped_at, taken_over_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_kind, subject_id) DO UPDATE SET state = excluded.state, cap = excluded.cap, raised_cap = excluded.raised_cap, unit = excluded.unit,
           spent = excluded.spent, partial = excluded.partial, scope = excluded.scope, from_model = excluded.from_model, to_model = excluded.to_model,
           tripped_at = excluded.tripped_at, paused_at = excluded.paused_at, paused_spent = excluded.paused_spent, stopped_at = excluded.stopped_at,
           taken_over_at = excluded.taken_over_at, updated_at = excluded.updated_at`,
      )
      .run(r.subjectKind, r.subjectId, r.state, r.cap, r.raisedCap, r.unit, r.spent, r.partial ? 1 : 0, r.scope, r.fromModel, r.toModel, r.trippedAt, r.pausedAt,
        r.pausedSpent, r.stoppedAt, r.takenOverAt, r.updatedAt);
  }

  delete(kind: CostSubjectKind, id: string): void {
    this.db.prepare(`DELETE FROM cost_breaker WHERE subject_kind = ? AND subject_id = ?`).run(kind, id);
  }

  event(e: Omit<CostEvent, "id">): void {
    this.db
      .prepare(`INSERT INTO cost_events (at, subject_kind, subject_id, kind, spent, cap, unit, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.at, e.subjectKind, e.subjectId, e.kind, e.spent, e.cap, e.unit, e.detail);
  }

  events(o: { subjectKind?: CostSubjectKind; subjectId?: string; limit?: number } = {}): CostEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.subjectKind) {
      where.push("subject_kind = ?");
      args.push(o.subjectKind);
    }
    if (o.subjectId) {
      where.push("subject_id = ?");
      args.push(o.subjectId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM cost_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...args, o.limit ?? 100) as unknown as { id: number; at: number; subject_kind: CostSubjectKind; subject_id: string; kind: CostEventKind; spent: number | null; cap: number | null; unit: string | null; detail: string | null }[];
    return rows.map((r) => ({ id: Number(r.id), at: Number(r.at), subjectKind: r.subject_kind, subjectId: r.subject_id, kind: r.kind, spent: num(r.spent), cap: num(r.cap), unit: r.unit, detail: r.detail }));
  }

  /** 很久以前的记录删掉。 */
  pruneEvents(before: number): number {
    return Number(this.db.prepare(`DELETE FROM cost_events WHERE at < ?`).run(before).changes);
  }
}
