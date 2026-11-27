import type { BgKind } from "../../shared/background";
import { prepareUncached, withTransaction, type Db } from "./database";

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
  /** 最近一次被取走开跑的时间；没跑过为 null。 */
  startedAt: number | null;
}

interface Row {
  id: number; kind: string; payload: string; state: BgJobState; checkpoint: string | null; priority: number; ticket_key: string | null;
  dedupe_key: string | null; not_before: number | null; attempts: number; error: string | null; enqueued_at: number; started_at: number | null;
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
  error: r.error, enqueuedAt: Number(r.enqueued_at), startedAt: r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
});

/** take 取的顺序：优先级高的在前，同优先级先排的在前。queued() 和「提到最前」都按这个。 */
const TAKE_ORDER = "ORDER BY priority DESC, id";

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

  /** 这一种里排队的，按 take 取的顺序（延后着的也在里面）。 */
  queued(kind: BgKind, limit = 500): BgJob[] {
    const rows = this.db.prepare(`SELECT * FROM background_jobs WHERE kind = ? AND state = 'queued' ${TAKE_ORDER} LIMIT ?`).all(kind, limit) as unknown as Row[];
    return rows.map(toJob);
  }

  /** 这一种里在跑的。 */
  runningOf(kind: BgKind): BgJob[] {
    const rows = this.db.prepare(`SELECT * FROM background_jobs WHERE kind = ? AND state = 'running' ORDER BY started_at, id`).all(kind) as unknown as Row[];
    return rows.map(toJob);
  }

  /**
   * 排队的这一个提到同一种的最前面：优先级改成这一种排队里最高的加一，延后的也提前到现在。
   * within 给了时只提到这些 ticket 的任务最前（epic 总控插队越不过别的 epic）：排在那些任务里第一个前面、其余的顺序不变。
   * 不在排队（在跑、做完、不存在）返回 false。
   */
  moveToFront(id: number, within?: (ticketKey: string | null) => boolean): boolean {
    return withTransaction(this.db, () => {
      const r = this.db.prepare(`SELECT kind, priority FROM background_jobs WHERE id = ? AND state = 'queued'`).get(id) as { kind: string; priority: number } | undefined;
      if (!r) return false;
      if (!within) {
        const top = this.db.prepare(`SELECT MAX(priority) AS p FROM background_jobs WHERE kind = ? AND state = 'queued' AND id != ?`).get(r.kind, id) as { p: number | null };
        const p = top.p === null ? 0 : Number(top.p) + 1;
        this.db.prepare(`UPDATE background_jobs SET priority = MAX(priority, ?), not_before = NULL WHERE id = ?`).run(p, id);
        return true;
      }
      // 按 take 的顺序找范围里第一个（不是自己的）F：F 前面的（都不在范围里）整体加一保持原来的先后，自己放到 F 原来的优先级加一。
      // 这样自己排在 F 前面、F 前面那些的后面。
      const rows = prepareUncached(this.db, `SELECT id, ticket_key, priority FROM background_jobs WHERE kind = ? AND state = 'queued' ${TAKE_ORDER}`)
        .all(r.kind) as { id: number; ticket_key: string | null; priority: number }[];
      const ahead: number[] = [];
      let first: { id: number; priority: number } | null = null;
      for (const x of rows) {
        if (Number(x.id) === id) break;
        if (within(x.ticket_key)) {
          first = { id: Number(x.id), priority: Number(x.priority) };
          break;
        }
        ahead.push(Number(x.id));
      }
      if (!first) {
        // 已经是范围里的第一个：只把延后的提前到现在。
        this.db.prepare(`UPDATE background_jobs SET not_before = NULL WHERE id = ?`).run(id);
        return true;
      }
      const bump = this.db.prepare(`UPDATE background_jobs SET priority = priority + 1 WHERE id = ?`);
      for (const a of ahead) bump.run(a);
      this.db.prepare(`UPDATE background_jobs SET priority = ?, not_before = NULL WHERE id = ?`).run(first.priority + 1, id);
      return true;
    });
  }

  /**
   * 这一种里下一个可以跑的（allowTicket 说这个 ticket 的能不能跑，allowJob 说这一个能不能跑：比如同一个 worktree 已经有一个在跑），
   * 标成 running、次数加一。
   */
  take(kind: BgKind, now: number, allowTicket: (ticketKey: string) => boolean, allowJob?: (job: BgJob) => boolean): BgJob | null {
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
      // 循环里会调 allowTicket（外面的回调）：不用缓存的语句，回调里再查同一条也不会把这里重置（BTL-265）。
      const rows = prepareUncached(
        this.db,
        `SELECT * FROM background_jobs WHERE state = 'queued' AND kind = ? AND (not_before IS NULL OR not_before <= ?)
         ${TAKE_ORDER}`,
      ).iterate(kind, now) as Iterable<Row>;
      for (const x of rows) {
        if ((x.ticket_key === null || allowed(x.ticket_key)) && (!allowJob || allowJob(toJob(x)))) {
          r = x;
          break;
        }
      }
      if (!r) return null;
      this.db.prepare(`UPDATE background_jobs SET state = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?`).run(now, r.id);
      return { ...toJob(r), state: "running", attempts: Number(r.attempts) + 1, startedAt: now };
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

  /** 这一种里延后着的都提前到现在（工作流 N：名额空出来了，不用等到点）。返回改了几条。 */
  wake(kind: BgKind): number {
    return Number(this.db.prepare(`UPDATE background_jobs SET not_before = NULL WHERE kind = ? AND state = 'queued' AND not_before IS NOT NULL`).run(kind).changes);
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
