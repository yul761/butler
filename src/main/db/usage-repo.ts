import type { UsageTurn } from "../usage/usage-parse";
import { withTransaction, type Db } from "./database";

export type UsageSource = "session" | "subagent" | "headless";

export interface UsageRow extends UsageTurn {
  sessionId: string | null;
  agentId: string | null;
  source: UsageSource;
  job: string | null;
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
}

const toRow = (r: UsageDbRow): UsageRow => ({
  messageId: r.message_id, sessionId: r.session_id, agentId: r.agent_id, source: r.source, job: r.job, at: r.at, model: r.model,
  input: r.input, cacheWrite5m: r.cache_write_5m, cacheWrite1h: r.cache_write_1h, cacheRead: r.cache_read, output: r.output, context: r.context,
});

/** 每轮 token 用量和 transcript 的增量读取位置。 */
export class UsageRepo {
  constructor(private readonly db: Db) {}

  /** 已有的 messageId 忽略，返回新写入的行数；一次调用一个事务。 */
  record(rows: UsageRow[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO session_usage (message_id, session_id, agent_id, source, job, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return withTransaction(this.db, () => {
      let n = 0;
      for (const r of rows) {
        n += Number(stmt.run(r.messageId, r.sessionId, r.agentId, r.source, r.job, r.at, r.model, r.input, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output, r.context).changes);
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
}
