import type { BgKind } from "../../shared/background";
import { withTransaction, type Db } from "./database";

export type BgJobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface BgJob {
  id: number;
  kind: BgKind;
  payload: unknown;
  state: BgJobState;
  checkpoint: unknown;
  priority: number;
  ticketKey: string | null;
  dedupeKey: string | null;
  notBefore: number | null;
  attempts: number;
  error: string | null;
  enqueuedAt: number;
}

interface Row {
  id: number; kind: string; payload: string; state: BgJobState; checkpoint: string | null; priority: number; ticket_key: string | null;
  dedupe_key: string | null; not_before: number | null; attempts: number; error: string | null; enqueued_at: number;
}

const parse = (t: string | null): unknown => {
  if (t === null) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
};

const toJob = (r: Row): BgJob => ({
  id: Number(r.id), kind: r.kind as BgKind, payload: parse(r.payload), state: r.state, checkpoint: parse(r.checkpoint), priority: Number(r.priority),
  ticketKey: r.ticket_key, dedupeKey: r.dedupe_key, notBefore: r.not_before === null ? null : Number(r.not_before), attempts: Number(r.attempts),
  error: r.error, enqueuedAt: Number(r.enqueued_at),
});

/** 通用后台队列（工作流 L）：在库里，退出重开后接着跑；检查点跟着行走。 */
export class BackgroundRepo {
  constructor(private readonly db: Db) {}

  /** 排一个；同一种里 dedupeKey 相同、还在排队或在跑的已经有了就返回那一个的 id。 */
  enqueue(o: { kind: BgKind; payload?: unknown; ticketKey?: string | null; dedupeKey?: string | null; notBefore?: number | null; priority?: number; now: number }): number {
    return withTransaction(this.db, () => {
      if (o.dedupeKey) {
        const ex = this.db
          .prepare(`SELECT id FROM background_jobs WHERE kind = ? AND dedupe_key = ? AND state IN ('queued','running')`)
          .get(o.kind, o.dedupeKey) as { id: number } | undefined;
        if (ex) return Number(ex.id);
      }
      const r = this.db
        .prepare(`INSERT INTO background_jobs (kind, payload, ticket_key, dedupe_key, not_before, priority, enqueued_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(o.kind, JSON.stringify(o.payload ?? {}), o.ticketKey ?? null, o.dedupeKey ?? null, o.notBefore ?? null, o.priority ?? 0, o.now);
      return Number(r.lastInsertRowid);
    });
  }

  /** 这一种里还在排队或在跑的（页面显示「正在回测」用）。 */
  active(kind: BgKind, limit = 200): BgJob[] {
    const rows = this.db.prepare(`SELECT * FROM background_jobs WHERE kind = ? AND state IN ('queued','running') ORDER BY id LIMIT ?`).all(kind, limit) as unknown as Row[];
    return rows.map(toJob);
  }

  get(id: number): BgJob | null {
    const r = this.db.prepare(`SELECT * FROM background_jobs WHERE id = ?`).get(id) as unknown as Row | undefined;
    return r ? toJob(r) : null;
  }

  /** 这一种里下一个可以跑的（allowTicket 说这个 ticket 的能不能跑），标成 running、次数加一。 */
  take(kind: BgKind, now: number, allowTicket: (ticketKey: string) => boolean): BgJob | null {
    return withTransaction(this.db, () => {
      // 一行一行看，找到第一个能跑的就停：不截前 N 行，不然前面一大串被熔断停住的 ticket 会把后面能跑的饿死。
      // 每个 ticket 只问一次。
      const asked = new Map<string, boolean>();
      const allowed = (key: string) => {
        let v = asked.get(key);
        if (v === undefined) asked.set(key, (v = allowTicket(key)));
        return v;
      };
      let r: Row | undefined;
      const rows = this.db
        .prepare(
          `SELECT * FROM background_jobs WHERE state = 'queued' AND kind = ? AND (not_before IS NULL OR not_before <= ?)
           ORDER BY priority DESC, id`,
        )
        .iterate(kind, now) as Iterable<Row>;
      for (const x of rows) {
        if (x.ticket_key === null || allowed(x.ticket_key)) {
          r = x;
          break;
        }
      }
      if (!r) return null;
      this.db.prepare(`UPDATE background_jobs SET state = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?`).run(now, r.id);
      return { ...toJob(r), state: "running", attempts: Number(r.attempts) + 1 };
    });
  }

  saveCheckpoint(id: number, checkpoint: unknown): void {
    this.db.prepare(`UPDATE background_jobs SET checkpoint = ? WHERE id = ?`).run(JSON.stringify(checkpoint ?? null), id);
  }

  finish(id: number, state: "done" | "failed" | "cancelled", now: number, error?: string | null): void {
    this.db.prepare(`UPDATE background_jobs SET state = ?, error = ?, finished_at = ? WHERE id = ?`).run(state, error ?? null, now, id);
  }

  /** 放回队列（让路、延后、退出时中断），检查点留着。 */
  requeue(id: number, notBefore: number | null, error?: string | null): void {
    this.db.prepare(`UPDATE background_jobs SET state = 'queued', not_before = ?, error = COALESCE(?, error) WHERE id = ?`).run(notBefore, error ?? null, id);
  }

  cancel(id: number, now: number): boolean {
    return Number(this.db.prepare(`UPDATE background_jobs SET state = 'cancelled', finished_at = ? WHERE id = ? AND state = 'queued'`).run(now, id).changes) > 0;
  }

  /** 删掉 before 之前就结束了的（done、failed、cancelled）；排队和在跑的不动。返回删了几条。 */
  pruneFinished(before: number): number {
    return Number(this.db.prepare(`DELETE FROM background_jobs WHERE state IN ('done','failed','cancelled') AND finished_at < ?`).run(before).changes);
  }

  /** 启动时：上次在跑的回到 queued（检查点留着）。 */
  resetRunning(): number {
    return Number(this.db.prepare(`UPDATE background_jobs SET state = 'queued' WHERE state = 'running'`).run().changes);
  }

  /** 排队里最早的 not_before（在 now 之后的）；没有为 null。 */
  nextNotBefore(now: number): number | null {
    const r = this.db.prepare(`SELECT MIN(not_before) AS t FROM background_jobs WHERE state = 'queued' AND not_before > ?`).get(now) as { t: number | null };
    return r.t === null ? null : Number(r.t);
  }

  counts(): Partial<Record<BgKind, { queued: number; running: number }>> {
    const rows = this.db
      .prepare(`SELECT kind, SUM(state = 'queued') AS q, SUM(state = 'running') AS r FROM background_jobs WHERE state IN ('queued','running') GROUP BY kind`)
      .all() as unknown as { kind: BgKind; q: number; r: number }[];
    const out: Partial<Record<BgKind, { queued: number; running: number }>> = {};
    for (const r of rows) out[r.kind] = { queued: Number(r.q), running: Number(r.r) };
    return out;
  }

  /** 做完、失败、取消了很久的删掉。 */
  prune(before: number): number {
    return Number(this.db.prepare(`DELETE FROM background_jobs WHERE state IN ('done','failed','cancelled') AND finished_at < ?`).run(before).changes);
  }
}
