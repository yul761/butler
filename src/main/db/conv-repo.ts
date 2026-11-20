import { CONV_QUERY_MAX, CONV_SEARCH_LIMIT, type ConvListOpts, type ConvMessage } from "../../shared/conversation";
import { withTransaction, type Db } from "./database";

// UI 重做第 4 层（BTL-234）：对话另存的三张表（conv_turns、conv_messages、conv_cursors）和可选的 FTS5 索引。
// 对话原文只留在本机：和 transcript、handoffs.raw_text 同一个信任级别，绝不放进 PrivacyGateway 的投影。

/** 一轮是怎么开的：user 用户说话；silent 斜杠命令 / Butler 通知 / 转达的回答；handoff 写 handoff；fork 分叉讨论；orphan 找不到开头的 agent 话。 */
export type TurnKind = "user" | "silent" | "handoff" | "fork" | "orphan";
export type QaState = "pending" | "yes" | "no";
/** 问答结论是谁定的：rule 规则；judge 模型；fork 分叉讨论；judge_failed 模型失败；old 补读出来的旧轮，不判。 */
export type QaBy = "rule" | "judge" | "fork" | "judge_failed" | "old";

export interface ConvTurn {
  id: number;
  rootSessionId: string;
  sessionId: string;
  sourceKey: string | null;
  forkId: number | null;
  kind: TurnKind;
  startedAt: number;
  lastAt: number;
  endedAt: number | null;
  asked: boolean;
  mutated: boolean;
  otherTools: boolean;
  qa: QaState;
  qaBy: QaBy | null;
}

export interface ConvCursor { sessionId: string; rootSessionId: string; file: string; ino: number; offset: number; openTurnId: number | null; updatedAt: number }

interface TurnRow {
  id: number;
  root_session_id: string;
  session_id: string;
  source_key: string | null;
  fork_id: number | null;
  kind: TurnKind;
  started_at: number;
  last_at: number;
  ended_at: number | null;
  asked: number;
  mutated: number;
  other_tools: number;
  qa: QaState;
  qa_by: QaBy | null;
}

interface MessageRow {
  id: number;
  turn_id: number;
  root_session_id: string;
  session_id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  fork_id: number | null;
  turn_qa: QaState;
}

interface CursorRow { session_id: string; root_session_id: string; file: string; ino: number; byte_offset: number; open_turn_id: number | null; updated_at: number }

const toTurn = (r: TurnRow): ConvTurn => ({
  id: r.id,
  rootSessionId: r.root_session_id,
  sessionId: r.session_id,
  sourceKey: r.source_key,
  forkId: r.fork_id,
  kind: r.kind,
  startedAt: r.started_at,
  lastAt: r.last_at,
  endedAt: r.ended_at,
  asked: r.asked === 1,
  mutated: r.mutated === 1,
  otherTools: r.other_tools === 1,
  qa: r.qa,
  qaBy: r.qa_by,
});

const toMessage = (r: MessageRow): ConvMessage => ({
  id: r.id,
  rootSessionId: r.root_session_id,
  sessionId: r.session_id,
  role: r.role,
  text: r.text,
  at: r.at,
  forkId: r.fork_id,
  qa: r.turn_qa === "yes",
  turnId: r.turn_id,
});

const MESSAGE_COLS = `m.id, m.turn_id, m.root_session_id, m.session_id, m.role, m.text, m.at, m.fork_id, t.qa AS turn_qa`;
const FROM_MESSAGES = `FROM conv_messages m JOIN conv_turns t ON t.id = m.turn_id`;

/** trigram 至少要 3 个字符；更短的词走 LIKE。 */
const FTS_MIN_CHARS = 3;

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class ConvRepo {
  readonly searchMode: "fts" | "like";

  constructor(private readonly db: Db, opts?: { fts?: boolean }) {
    this.searchMode = opts?.fts === false ? this.disableFts() : this.ensureFts();
  }

  /**
   * FTS 不进迁移：fts5 模块缺失时迁移整条失败，app 就打不开了。这里幂等地建；建不了就删掉触发器（删触发器不需要模块），退回 LIKE。
   */
  private ensureFts(): "fts" | "like" {
    let created: boolean;
    try {
      created = !this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'conv_fts'`).get();
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS conv_fts USING fts5(text, content='conv_messages', content_rowid='id', tokenize='trigram')`);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS conv_fts_ai AFTER INSERT ON conv_messages BEGIN
          INSERT INTO conv_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS conv_fts_ad AFTER DELETE ON conv_messages BEGIN
          INSERT INTO conv_fts(conv_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS conv_fts_au AFTER UPDATE OF text ON conv_messages BEGIN
          INSERT INTO conv_fts(conv_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO conv_fts(rowid, text) VALUES (new.id, new.text);
        END;`);
    } catch {
      return this.disableFts();
    }
    // 上一次是 LIKE 模式（触发器没装）写进来的行：重建一次索引。
    const stale = created || this.ftsWasOff();
    if (stale && this.db.prepare(`SELECT 1 FROM conv_messages LIMIT 1`).get()) this.db.exec(`INSERT INTO conv_fts(conv_fts) VALUES('rebuild')`);
    this.db.exec(`DELETE FROM settings WHERE key = 'convFtsOff'`);
    return "fts";
  }

  private disableFts(): "like" {
    this.db.exec(`DROP TRIGGER IF EXISTS conv_fts_ai; DROP TRIGGER IF EXISTS conv_fts_ad; DROP TRIGGER IF EXISTS conv_fts_au;`);
    // 记下「关着 FTS 写过」：下次能建的时候要重建索引，不然这段时间写的行搜不到。
    this.db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('convFtsOff', '1')`).run();
    return "like";
  }

  private ftsWasOff(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM settings WHERE key = 'convFtsOff'`).get();
  }

  /** 在一个事务里跑 fn（可重入：外面已有事务时用 savepoint）。 */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  // ---- 轮 ----

  /** INSERT OR IGNORE：同一链根下 sourceKey 已有时返回已有那一轮的 id，不改它。 */
  openTurn(t: { rootSessionId: string; sessionId: string; sourceKey: string | null; forkId: number | null; kind: TurnKind; at: number; asked: boolean }): number {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO conv_turns (root_session_id, session_id, source_key, fork_id, kind, started_at, last_at, asked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.rootSessionId, t.sessionId, t.sourceKey, t.forkId, t.kind, t.at, t.at, t.asked ? 1 : 0);
    if (r.changes > 0) return Number(r.lastInsertRowid);
    const row = this.db.prepare(`SELECT id FROM conv_turns WHERE root_session_id = ? AND source_key = ?`).get(t.rootSessionId, t.sourceKey) as { id: number };
    return row.id;
  }

  turn(id: number): ConvTurn | null {
    const r = this.db.prepare(`SELECT * FROM conv_turns WHERE id = ?`).get(id) as TurnRow | undefined;
    return r ? toTurn(r) : null;
  }

  /** 标志只会从 0 变 1（重读同一段不会把 mutated 清掉）；lastAt 取较大值；endedAt 只在还是 NULL 时写。 */
  touchTurn(id: number, p: { at: number; mutated?: boolean; otherTools?: boolean; endedAt?: number }): void {
    this.db
      .prepare(
        `UPDATE conv_turns SET last_at = MAX(last_at, ?), mutated = MAX(mutated, ?), other_tools = MAX(other_tools, ?),
           ended_at = COALESCE(ended_at, ?) WHERE id = ?`,
      )
      .run(p.at, p.mutated ? 1 : 0, p.otherTools ? 1 : 0, p.endedAt ?? null, id);
  }

  /** 返回是否真的改了（已经是这个值就返回 false）。 */
  setQa(id: number, qa: QaState, by: QaBy): boolean {
    return this.db.prepare(`UPDATE conv_turns SET qa = ?, qa_by = ? WHERE id = ? AND (qa <> ? OR qa_by IS NOT ?)`).run(qa, by, id, qa, by).changes > 0;
  }

  /** kind='user'、qa='pending'、已结束的轮，最早结束的在前。 */
  pendingEnded(limit: number): ConvTurn[] {
    const rows = this.db
      .prepare(`SELECT * FROM conv_turns WHERE qa = 'pending' AND kind = 'user' AND ended_at IS NOT NULL ORDER BY ended_at, id LIMIT ?`)
      .all(limit) as unknown as TurnRow[];
    return rows.map(toTurn);
  }

  /** 一直没结束、lastAt 早于 before 的轮写上 endedAt = lastAt；返回条数。 */
  endStale(before: number): number {
    return Number(this.db.prepare(`UPDATE conv_turns SET ended_at = last_at WHERE ended_at IS NULL AND last_at < ?`).run(before).changes);
  }

  // ---- 消息 ----

  /** 同一链根下 sourceKey 重复时返回 null（什么都不写）。 */
  addMessage(m: { turnId: number; rootSessionId: string; sessionId: string; role: "user" | "assistant"; text: string; at: number; forkId: number | null; sourceKey: string | null }): ConvMessage | null {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO conv_messages (turn_id, root_session_id, session_id, role, text, at, fork_id, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.turnId, m.rootSessionId, m.sessionId, m.role, m.text, m.at, m.forkId, m.sourceKey);
    if (r.changes === 0) return null;
    return this.message(Number(r.lastInsertRowid));
  }

  private message(id: number): ConvMessage | null {
    const r = this.db.prepare(`SELECT ${MESSAGE_COLS} ${FROM_MESSAGES} WHERE m.id = ?`).get(id) as MessageRow | undefined;
    return r ? toMessage(r) : null;
  }

  turnMessages(turnId: number): ConvMessage[] {
    const rows = this.db.prepare(`SELECT ${MESSAGE_COLS} ${FROM_MESSAGES} WHERE m.turn_id = ? ORDER BY m.at, m.id`).all(turnId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** 一页：before（消息 id）之前最新的 limit 条，按时间升序。qaOnly：问答轮的消息和分叉讨论的消息。 */
  page(rootSessionId: string, opts: ConvListOpts): { messages: ConvMessage[]; hasMore: boolean } {
    const where = [`m.root_session_id = ?`];
    const args: (string | number)[] = [rootSessionId];
    if (opts.before !== undefined) {
      const b = this.db.prepare(`SELECT at, id FROM conv_messages WHERE id = ?`).get(opts.before) as { at: number; id: number } | undefined;
      if (b) {
        where.push(`(m.at < ? OR (m.at = ? AND m.id < ?))`);
        args.push(b.at, b.at, b.id);
      }
    }
    if (opts.qaOnly) where.push(`(t.qa = 'yes' OR m.fork_id IS NOT NULL)`);
    const rows = this.db
      .prepare(`SELECT ${MESSAGE_COLS} ${FROM_MESSAGES} WHERE ${where.join(" AND ")} ORDER BY m.at DESC, m.id DESC LIMIT ?`)
      .all(...args, opts.limit + 1) as unknown as MessageRow[];
    const hasMore = rows.length > opts.limit;
    return { messages: rows.slice(0, opts.limit).reverse().map(toMessage), hasMore };
  }

  /** 按空白切词，各词 AND；3 个字符以上的走 FTS（如果有），其余 LIKE。最新的在前。 */
  search(rootSessionId: string | null, query: string, limit = CONV_SEARCH_LIMIT): ConvMessage[] {
    const terms = [...query].slice(0, CONV_QUERY_MAX).join("").split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const where: string[] = [];
    const args: (string | number)[] = [];
    const fts = this.searchMode === "fts" ? terms.filter((w) => [...w].length >= FTS_MIN_CHARS) : [];
    if (fts.length > 0) {
      where.push(`m.id IN (SELECT rowid FROM conv_fts WHERE conv_fts MATCH ?)`);
      args.push(fts.map((w) => `"${w.replace(/"/g, '""')}"`).join(" AND "));
    }
    for (const w of terms) {
      if (fts.includes(w)) continue;
      where.push(`m.text LIKE ? ESCAPE '\\'`);
      args.push(`%${likeEscape(w)}%`);
    }
    if (rootSessionId !== null) {
      where.push(`m.root_session_id = ?`);
      args.push(rootSessionId);
    }
    const rows = this.db
      .prepare(`SELECT ${MESSAGE_COLS} ${FROM_MESSAGES} WHERE ${where.join(" AND ")} ORDER BY m.at DESC, m.id DESC LIMIT ?`)
      .all(...args, limit) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** qa='yes' 且不是分叉的轮，最新的在前，每次最多 limit 轮（recentQa 往前取够字数为止）。 */
  qaTurns(rootSessionId: string, o: { beforeStartedAt?: number; limit: number }): ConvTurn[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conv_turns WHERE root_session_id = ? AND qa = 'yes' AND fork_id IS NULL AND started_at < ?
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(rootSessionId, o.beforeStartedAt ?? Number.MAX_SAFE_INTEGER, o.limit) as unknown as TurnRow[];
    return rows.map(toTurn);
  }

  /** 这个链根下这个分叉最新的一轮（append 写 assistant 时挂在它上面）。 */
  latestForkTurn(rootSessionId: string, forkId: number): ConvTurn | null {
    const r = this.db
      .prepare(`SELECT * FROM conv_turns WHERE root_session_id = ? AND fork_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`)
      .get(rootSessionId, forkId) as TurnRow | undefined;
    return r ? toTurn(r) : null;
  }

  /** 这个分叉的全部消息，按 (at, id) 升序。 */
  forkMessages(forkId: number): ConvMessage[] {
    const rows = this.db.prepare(`SELECT ${MESSAGE_COLS} ${FROM_MESSAGES} WHERE m.fork_id = ? ORDER BY m.at, m.id`).all(forkId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  // ---- 游标 ----

  cursor(sessionId: string): ConvCursor | null {
    const r = this.db.prepare(`SELECT * FROM conv_cursors WHERE session_id = ?`).get(sessionId) as CursorRow | undefined;
    return r
      ? { sessionId: r.session_id, rootSessionId: r.root_session_id, file: r.file, ino: r.ino, offset: r.byte_offset, openTurnId: r.open_turn_id, updatedAt: r.updated_at }
      : null;
  }

  saveCursor(c: ConvCursor): void {
    this.db
      .prepare(
        `INSERT INTO conv_cursors (session_id, root_session_id, file, ino, byte_offset, open_turn_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET root_session_id = excluded.root_session_id, file = excluded.file, ino = excluded.ino,
           byte_offset = excluded.byte_offset, open_turn_id = excluded.open_turn_id, updated_at = excluded.updated_at`,
      )
      .run(c.sessionId, c.rootSessionId, c.file, c.ino, c.offset, c.openTurnId, c.updatedAt);
  }

  /** 把这个 session 的轮、消息、游标搬到新链根；新链根下已有同一个 sourceKey 的，丢掉旧链根下的那份。 */
  reroot(sessionId: string, newRoot: string): void {
    withTransaction(this.db, () => {
      this.db.prepare(`UPDATE OR IGNORE conv_turns SET root_session_id = ? WHERE session_id = ?`).run(newRoot, sessionId);
      // 撞上唯一索引没搬走的轮：消息改挂到新链根下同 source_key 的那一轮，再删掉它。
      const stuck = this.db
        .prepare(
          `SELECT o.id AS old_id, n.id AS new_id FROM conv_turns o
             JOIN conv_turns n ON n.root_session_id = ? AND n.source_key = o.source_key
            WHERE o.session_id = ? AND o.root_session_id <> ?`,
        )
        .all(newRoot, sessionId, newRoot) as { old_id: number; new_id: number }[];
      for (const s of stuck) {
        this.db.prepare(`UPDATE conv_messages SET turn_id = ? WHERE turn_id = ?`).run(s.new_id, s.old_id);
        this.db.prepare(`DELETE FROM conv_turns WHERE id = ?`).run(s.old_id);
      }
      this.db.prepare(`UPDATE OR IGNORE conv_messages SET root_session_id = ? WHERE session_id = ?`).run(newRoot, sessionId);
      this.db.prepare(`DELETE FROM conv_messages WHERE session_id = ? AND root_session_id <> ?`).run(sessionId, newRoot);
      // 游标里的 open_turn_id 可能指向刚删掉的那一轮。
      for (const s of stuck) this.db.prepare(`UPDATE conv_cursors SET open_turn_id = ? WHERE session_id = ? AND open_turn_id = ?`).run(s.new_id, sessionId, s.old_id);
      this.db.prepare(`UPDATE conv_cursors SET root_session_id = ? WHERE session_id = ?`).run(newRoot, sessionId);
    });
  }
}
