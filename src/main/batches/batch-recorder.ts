import { withTransaction, type Db } from "../db/database";
import type { BatchDetail, BatchItemView, BatchOrigin, BatchOutcome, BatchView } from "../../shared/batches";

/** 一行在某一刻的完整样子（JSON 能存）。null = 这一行不存在。 */
export type Snapshot = Record<string, unknown>;

/**
 * 一种实体（规矩、产品、准入策略……）怎么拍快照、怎么恢复。
 * restore(id, null) 删掉这一行；restore(id, s) 把它改回 s，行不在了就用原 id 插回去。
 */
export interface EntityAdapter {
  readonly entity: string;
  snapshot(id: number): Snapshot | null;
  restore(id: number, to: Snapshot | null): void;
  /** 比较「变没变」时忽略的字段（如 updated_at）。 */
  readonly volatile?: readonly string[];
  /** 记下「最近一次改动它的批次」。 */
  stamp?(id: number, batchId: number): void;
  /** 页面上的一行：文字和状态。 */
  describe(s: Snapshot): { label: string; state: string };
}

export interface BatchMeta {
  kind: string;
  origin: BatchOrigin;
  entity: string;
  scope?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  policySnapshot?: unknown;
  now: number;
}

export interface BatchContext {
  /** 改之前调用：记下这一行现在的样子（同一行只记第一次）。 */
  track(entity: string, id: number): void;
  /** 这一批新建的行：之前不存在。 */
  created(entity: string, id: number): void;
  /** 命中了但不用改（本来就是目标状态）。 */
  skip(n?: number): void;
}

export type UndoResult =
  | { ok: true; outcome: BatchOutcome; restored: { entity: string; id: number; before: Snapshot | null; after: Snapshot | null }[]; original: BatchView }
  | { ok: false; reason: "not_found" | "not_undoable" };

interface BatchRow {
  id: number; created_at: number; kind: string; origin: BatchOrigin; entity: string; scope: string; summary: string;
  affected: number; undone_at: number | null; undo_of: number | null;
}
interface ItemRow { entity: string; entity_id: number; before: string | null; after: string | null }

/** 键排好序再序列化：同样的内容得到同样的字符串。 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

const parseObj = (raw: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const parseSnap = (raw: string | null): Snapshot | null => (raw === null ? null : parseObj(raw));

const toView = (r: BatchRow): BatchView => ({
  id: Number(r.id), createdAt: Number(r.created_at), kind: r.kind, origin: r.origin, entity: r.entity,
  scope: parseObj(r.scope), summary: parseObj(r.summary), affected: Number(r.affected),
  undoneAt: r.undone_at === null ? null : Number(r.undone_at), undoOf: r.undo_of === null ? null : Number(r.undo_of),
  undoable: r.kind !== "undo" && r.undone_at === null,
});

/**
 * 批次记录器（契约 4.4）：一个事务里拍改前快照、改、拍改后快照，只把真变了的行记进批次；
 * 撤销只恢复「现在还是这一批改完的样子」的行，之后被别的改动碰过的跳过并计数，绝不覆盖。
 */
export class BatchRecorder {
  private readonly adapters = new Map<string, EntityAdapter>();

  constructor(private readonly db: Db, adapters: EntityAdapter[] = []) {
    for (const a of adapters) this.register(a);
  }

  register(a: EntityAdapter): void {
    this.adapters.set(a.entity, a);
  }

  private adapter(entity: string): EntityAdapter {
    const a = this.adapters.get(entity);
    if (!a) throw new Error(`no batch adapter for ${entity}`);
    return a;
  }

  private same(a: EntityAdapter, x: Snapshot | null, y: Snapshot | null): boolean {
    if (x === null || y === null) return x === y;
    const strip = (s: Snapshot) => {
      if (!a.volatile?.length) return s;
      const c = { ...s };
      for (const k of a.volatile) delete c[k];
      return c;
    };
    return canonical(strip(x)) === canonical(strip(y));
  }

  /** 跑一批；mutate 抛错整批回滚。没有一行真变了就不写批次（batchId = null）。 */
  run<T>(meta: BatchMeta, mutate: (ctx: BatchContext) => T, opts: { stamp?: boolean; undoOf?: number } = {}): { outcome: BatchOutcome; result: T } {
    return withTransaction(this.db, () => {
      const order: { entity: string; id: number }[] = [];
      const before = new Map<string, Snapshot | null>();
      const key = (entity: string, id: number) => `${entity}:${id}`;
      let skipped = 0;
      const ctx: BatchContext = {
        track: (entity, id) => {
          const k = key(entity, id);
          if (before.has(k)) return;
          before.set(k, this.adapter(entity).snapshot(id));
          order.push({ entity, id });
        },
        created: (entity, id) => {
          const k = key(entity, id);
          if (before.has(k)) return;
          this.adapter(entity);
          before.set(k, null);
          order.push({ entity, id });
        },
        skip: (n = 1) => {
          skipped += n;
        },
      };
      const result = mutate(ctx);
      const changed = order.filter(({ entity, id }) => !this.same(this.adapter(entity), before.get(key(entity, id)) ?? null, this.adapter(entity).snapshot(id)));
      if (changed.length === 0) return { outcome: { batchId: null, affected: 0, skipped }, result };
      const batchId = Number(
        this.db
          .prepare(`INSERT INTO admission_batches (created_at, kind, origin, entity, scope, policy_snapshot, summary, affected, undo_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            meta.now, meta.kind, meta.origin, meta.entity, JSON.stringify(meta.scope ?? {}),
            meta.policySnapshot === undefined ? null : JSON.stringify(meta.policySnapshot), JSON.stringify(meta.summary ?? {}),
            changed.length, opts.undoOf ?? null,
          ).lastInsertRowid,
      );
      const ins = this.db.prepare(`INSERT INTO admission_batch_items (batch_id, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?)`);
      for (const { entity, id } of changed) {
        const a = this.adapter(entity);
        if (opts.stamp !== false && a.stamp && a.snapshot(id) !== null) a.stamp(id, batchId);
        const b = before.get(key(entity, id)) ?? null;
        const after = a.snapshot(id);
        ins.run(batchId, entity, id, b === null ? null : JSON.stringify(b), after === null ? null : JSON.stringify(after));
      }
      return { outcome: { batchId, affected: changed.length, skipped }, result };
    });
  }

  /** 撤销一批：倒着恢复（先删后建的依赖顺序反过来）；自己也记成一个 undo 批次（不能再撤销）。 */
  undo(batchId: number, now: number): UndoResult {
    return withTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT * FROM admission_batches WHERE id = ?`).get(batchId) as BatchRow | undefined;
      if (!row) return { ok: false as const, reason: "not_found" as const };
      const original = toView(row);
      if (!original.undoable) return { ok: false as const, reason: "not_undoable" as const };
      const items = this.db.prepare(`SELECT entity, entity_id, before, after FROM admission_batch_items WHERE batch_id = ? ORDER BY rowid DESC`).all(batchId) as unknown as ItemRow[];
      const restored: { entity: string; id: number; before: Snapshot | null; after: Snapshot | null }[] = [];
      let conflicts = 0;
      const { outcome } = this.run(
        { kind: "undo", origin: "manual", entity: row.entity, scope: { batchId }, summary: { undoOf: batchId, kind: row.kind }, now },
        (ctx) => {
          for (const it of items) {
            const a = this.adapters.get(it.entity);
            if (!a) {
              conflicts++;
              continue;
            }
            const id = Number(it.entity_id);
            const before = parseSnap(it.before);
            const after = parseSnap(it.after);
            if (!this.same(a, a.snapshot(id), after)) {
              conflicts++;
              continue;
            }
            ctx.track(it.entity, id);
            try {
              withTransaction(this.db, () => a.restore(id, before));
              restored.push({ entity: it.entity, id, before: after, after: before });
            } catch {
              conflicts++;
            }
          }
        },
        { stamp: false, undoOf: batchId },
      );
      this.db.prepare(`UPDATE admission_batches SET undone_at = ? WHERE id = ?`).run(now, batchId);
      return { ok: true as const, outcome: { ...outcome, skipped: conflicts }, restored, original };
    });
  }

  list(opts: { limit?: number; beforeId?: number; entity?: string } = {}): BatchView[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.beforeId !== undefined) {
      where.push("id < ?");
      args.push(opts.beforeId);
    }
    if (opts.entity !== undefined) {
      where.push("entity = ?");
      args.push(opts.entity);
    }
    const sql = `SELECT * FROM admission_batches ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, Math.min(Math.max(opts.limit ?? 100, 1), 500)) as unknown as BatchRow[]).map(toView);
  }

  get(batchId: number): BatchDetail | null {
    const row = this.db.prepare(`SELECT * FROM admission_batches WHERE id = ?`).get(batchId) as BatchRow | undefined;
    if (!row) return null;
    const items = this.db.prepare(`SELECT entity, entity_id, before, after FROM admission_batch_items WHERE batch_id = ? ORDER BY rowid`).all(batchId) as unknown as ItemRow[];
    return { ...toView(row), items: items.map((it) => this.itemView(it)) };
  }

  /** 这一批改过的行 id（导出一批、页面按批次筛选用）。 */
  itemIds(batchId: number, entity: string): number[] {
    return (this.db.prepare(`SELECT entity_id FROM admission_batch_items WHERE batch_id = ? AND entity = ? ORDER BY rowid`).all(batchId, entity) as { entity_id: number }[]).map((r) => Number(r.entity_id));
  }

  private itemView(it: ItemRow): BatchItemView {
    const a = this.adapters.get(it.entity);
    const before = parseSnap(it.before);
    const after = parseSnap(it.after);
    const b = before && a ? a.describe(before) : null;
    const f = after && a ? a.describe(after) : null;
    return { entity: it.entity, entityId: Number(it.entity_id), label: f?.label ?? b?.label ?? `#${it.entity_id}`, before: b?.state ?? null, after: f?.state ?? null };
  }
}
