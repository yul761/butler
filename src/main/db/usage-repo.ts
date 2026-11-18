import type { UsageTurn } from "../usage/usage-parse";
import { USAGE_WEIGHTS as W } from "../usage/usage-summary";
import { withTransaction, type Db } from "./database";

export type UsageSource = "session" | "subagent" | "headless";

export interface UsageRow extends UsageTurn {
  sessionId: string | null;
  agentId: string | null;
  source: UsageSource;
  job: string | null;
  /** 后台调用的任务 id、要的档位、从哪个模型降下来、CLI 报的金额（模型路由，可省略）。 */
  task?: string | null;
  requestedTier?: string | null;
  fallbackFrom?: string | null;
  costUsd?: number | null;
  /** headless 调用归到哪个 ticket（成本熔断，工作流 L）；session 的行按 session 归，这里为空。 */
  ticketKey?: string | null;
}

/** 一段时间内按模型和任务汇总的用量（算配额用）。 */
export interface SpendRow {
  model: string | null;
  task: string | null;
  rows: number;
  input: number;
  output: number;
  tokens: number;
  costUsd: number;
  /** 没有记录金额的行（要按价格估）的 input / output token。 */
  unpricedInput: number;
  unpricedOutput: number;
  unpricedRows: number;
}

interface UsageDbRow {
  message_id: string;
  session_id: string | null;
  agent_id: string | null;
  source: UsageSource;
  job: string | null;
  at: number;
  model: string | null;
  input: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  output: number;
  context: number;
  task: string | null;
  requested_tier: string | null;
  fallback_from: string | null;
  cost_usd: number | null;
  ticket_key: string | null;
}

const toRow = (r: UsageDbRow): UsageRow => ({
  messageId: r.message_id, sessionId: r.session_id, agentId: r.agent_id, source: r.source, job: r.job, at: r.at, model: r.model,
  input: r.input, cacheWrite5m: r.cache_write_5m, cacheWrite1h: r.cache_write_1h, cacheRead: r.cache_read, output: r.output, context: r.context,
  task: r.task, requestedTier: r.requested_tier, fallbackFrom: r.fallback_from, costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
  ticketKey: r.ticket_key,
});

/** 成本熔断用的汇总行：SpendRow 加上按 USAGE_WEIGHTS 加权的 token 数。 */
export interface CostRow extends SpendRow {
  weighted: number;
}

/** 每轮 token 用量和 transcript 的增量读取位置。 */
export class UsageRepo {
  constructor(private readonly db: Db) {}

  /** 已有的 messageId 忽略，返回新写入的行数；一次调用一个事务。 */
  record(rows: UsageRow[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO session_usage (message_id, session_id, agent_id, source, job, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, context,
         task, requested_tier, fallback_from, cost_usd, ticket_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return withTransaction(this.db, () => {
      let n = 0;
      for (const r of rows) {
        n += Number(stmt.run(r.messageId, r.sessionId, r.agentId, r.source, r.job, r.at, r.model, r.input, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output, r.context,
          r.task ?? null, r.requestedTier ?? null, r.fallbackFrom ?? null, r.costUsd ?? null, r.ticketKey ?? null).changes);
      }
      return n;
    });
  }

  cursor(file: string): { offset: number; size: number } | null {
    const r = this.db.prepare(`SELECT offset, size FROM usage_cursors WHERE file = ?`).get(file) as { offset: number; size: number } | undefined;
    return r ? { offset: Number(r.offset), size: Number(r.size) } : null;
  }

  setCursor(file: string, offset: number, size: number): void {
    this.db
      .prepare(`INSERT INTO usage_cursors (file, offset, size) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, size = excluded.size`)
      .run(file, offset, size);
  }

  /** 这个 session 最新一轮（按 at）的 context；只看 source='session'。 */
  latestContext(sessionId: string): number | null {
    const r = this.db
      .prepare(`SELECT context FROM session_usage WHERE session_id = ? AND source = 'session' ORDER BY at DESC LIMIT 1`)
      .get(sessionId) as { context: number } | undefined;
    return r ? Number(r.context) : null;
  }

  /** at >= sinceMs 的所有行。 */
  since(sinceMs: number): UsageRow[] {
    return (this.db.prepare(`SELECT * FROM session_usage WHERE at >= ? ORDER BY at`).all(sinceMs) as unknown as UsageDbRow[]).map(toRow);
  }

  /** 这之后用量里出现过的模型名（模型发现用），用得多的在前。 */
  modelsSince(sinceMs: number, limit = 20): string[] {
    const rows = this.db
      .prepare(`SELECT model, COUNT(*) AS c FROM session_usage WHERE at >= ? AND model IS NOT NULL AND model <> '' GROUP BY model ORDER BY c DESC LIMIT ?`)
      .all(sinceMs, limit) as unknown as { model: string }[];
    return rows.map((r) => r.model);
  }

  /**
   * at >= sinceMs 的用量按模型和任务汇总。input（token 配额用）含缓存写入、不含缓存读取（读取便宜得多，算进去配额会很快用完）；
   * u_in（没记 cost_usd 的行按单价折钱用）按 USAGE_WEIGHTS 把缓存写入 / 读取折成普通输入。
   */
  spendSince(sinceMs: number): SpendRow[] {
    const rows = this.db
      .prepare(
        `SELECT model, task, COUNT(*) AS rows,
           SUM(input + cache_write_5m + cache_write_1h) AS input, SUM(output) AS output,
           SUM(COALESCE(cost_usd, 0)) AS cost,
           SUM(CASE WHEN cost_usd IS NULL THEN input + ${W.cacheWrite5m} * cache_write_5m + ${W.cacheWrite1h} * cache_write_1h + ${W.cacheRead} * cache_read ELSE 0 END) AS u_in,
           SUM(CASE WHEN cost_usd IS NULL THEN output ELSE 0 END) AS u_out,
           SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS u_rows
         FROM session_usage WHERE at >= ? GROUP BY model, task`,
      )
      .all(sinceMs) as unknown as { model: string | null; task: string | null; rows: number; input: number; output: number; cost: number; u_in: number; u_out: number; u_rows: number }[];
    return rows.map((r) => ({
      model: r.model, task: r.task, rows: Number(r.rows), input: Number(r.input), output: Number(r.output), tokens: Number(r.input) + Number(r.output),
      costUsd: Number(r.cost), unpricedInput: Number(r.u_in), unpricedOutput: Number(r.u_out), unpricedRows: Number(r.u_rows),
    }));
  }

  /**
   * 成本熔断（工作流 L）：这些 session（含子代理）加上归到这个 ticket 的 headless 行，按模型汇总，不限时间。
   * 两边都空返回空数组。
   */
  totalsFor(o: { sessionIds?: readonly string[]; ticketKey?: string | null }): CostRow[] {
    const ids = [...new Set(o.sessionIds ?? [])];
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (ids.length > 0) {
      where.push(`session_id IN (${ids.map(() => "?").join(",")})`);
      args.push(...ids);
    }
    if (o.ticketKey) {
      where.push(`ticket_key = ?`);
      args.push(o.ticketKey);
    }
    if (where.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT model, COUNT(*) AS rows,
           SUM(input + cache_write_5m + cache_write_1h) AS input, SUM(output) AS output,
           SUM(COALESCE(cost_usd, 0)) AS cost,
           SUM(CASE WHEN cost_usd IS NULL THEN input + ${W.cacheWrite5m} * cache_write_5m + ${W.cacheWrite1h} * cache_write_1h + ${W.cacheRead} * cache_read ELSE 0 END) AS u_in,
           SUM(CASE WHEN cost_usd IS NULL THEN output ELSE 0 END) AS u_out,
           SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS u_rows,
           SUM(${W.input} * input + ${W.cacheWrite5m} * cache_write_5m + ${W.cacheWrite1h} * cache_write_1h + ${W.cacheRead} * cache_read + ${W.output} * output) AS weighted
         FROM session_usage WHERE ${where.join(" OR ")} GROUP BY model`,
      )
      .all(...args) as unknown as { model: string | null; rows: number; input: number; output: number; cost: number; u_in: number; u_out: number; u_rows: number; weighted: number }[];
    return rows.map((r) => ({
      model: r.model, task: null, rows: Number(r.rows), input: Number(r.input), output: Number(r.output), tokens: Number(r.input) + Number(r.output),
      costUsd: Number(r.cost), unpricedInput: Number(r.u_in), unpricedOutput: Number(r.u_out), unpricedRows: Number(r.u_rows), weighted: Number(r.weighted),
    }));
  }
}
