import type { Session, SessionOrigin } from "../../shared/types";
import { withTransaction, type Db } from "./database";

interface SessionRow {
  id: string;
  ticket_key: string | null;
  cwd: string;
  origin: string;
  git_branch: string | null;
  first_prompt: string | null;
  last_activity_at: number | null;
  waiting_for_input: number;
  replaced_by: string | null;
  dismissed: number;
  created_at: number;
  repo_id: number | null;
  coordinator: number;
  spawned_by: string | null;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    ticketKey: r.ticket_key,
    cwd: r.cwd,
    origin: r.origin as SessionOrigin,
    gitBranch: r.git_branch,
    firstPrompt: r.first_prompt,
    lastActivityAt: r.last_activity_at,
    waitingForInput: r.waiting_for_input === 1,
    replacedBy: r.replaced_by,
    dismissed: r.dismissed === 1,
    createdAt: r.created_at,
    repoId: r.repo_id === null ? null : Number(r.repo_id),
    coordinator: r.coordinator === 1,
    spawnedBy: r.spawned_by,
  };
}

export interface NewSession {
  id: string;
  ticketKey: string | null;
  cwd: string;
  origin: SessionOrigin;
  gitBranch?: string | null;
  firstPrompt?: string | null;
  lastActivityAt?: number | null;
  createdAt: number;
  repoId?: number | null;
  coordinator?: boolean;
  spawnedBy?: string | null;
}

export interface SessionDetails {
  cwd?: string | null;
  gitBranch?: string | null;
  firstPrompt?: string | null;
  lastActivityAt?: number | null;
}

const RECENCY = "COALESCE(last_activity_at, created_at)";

/** 记住最近被 delete 的 id 的上限；只用来拦住迟到的 hook 事件，不必永久保存。 */
const FORGOTTEN_LIMIT = 500;

export class SessionsRepo {
  /** 最近被删除的 session id（按删除顺序，超出上限丢弃最旧的）。 */
  private readonly forgotten = new Set<string>();

  constructor(private readonly db: Db) {}

  insertIfAbsent(s: NewSession): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, ticket_key, cwd, origin, git_branch, first_prompt, last_activity_at, created_at, repo_id, coordinator, spawned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id, s.ticketKey, s.cwd, s.origin, s.gitBranch ?? null, s.firstPrompt ?? null, s.lastActivityAt ?? null, s.createdAt,
        s.repoId ?? null, s.coordinator ? 1 : 0, s.spawnedBy ?? null,
      );
    if (Number(r.changes) > 0) {
      this.forgotten.delete(s.id);
      return true;
    }
    return false;
  }

  /** 这个 id 是否刚被 delete 过（迟到的 hook 事件不应把它再插回来）。 */
  wasForgotten(id: string): boolean {
    return this.forgotten.has(id);
  }

  /** 只填补空字段；lastActivityAt 只会往后移。 */
  fillDetails(id: string, d: SessionDetails): void {
    const at = d.lastActivityAt ?? null;
    this.db
      .prepare(
        `UPDATE sessions SET
           cwd = CASE WHEN cwd = '' THEN COALESCE(?, '') ELSE cwd END,
           git_branch = COALESCE(git_branch, ?),
           first_prompt = COALESCE(first_prompt, ?),
           last_activity_at = CASE WHEN ? IS NULL THEN last_activity_at ELSE MAX(COALESCE(last_activity_at, 0), ?) END
         WHERE id = ?`,
      )
      .run(d.cwd ?? null, d.gitBranch ?? null, d.firstPrompt ?? null, at, at, id);
  }

  get(id: string): Session | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  listByTicket(ticketKey: string): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE ticket_key = ? ORDER BY ${RECENCY} DESC, id`)
      .all(ticketKey) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  listUnclaimed(sinceMs: number): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE ticket_key IS NULL AND dismissed = 0 AND replaced_by IS NULL AND ${RECENCY} >= ?
         ORDER BY ${RECENCY} DESC, id`,
      )
      .all(sinceMs) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /** Butler 新建、还没有第一句话、也没被 /clear 替换的 session：handleExit 和启动时清理空 session 的候选。 */
  listEmptyButler(): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE origin = 'butler' AND (first_prompt IS NULL OR first_prompt = '') AND replaced_by IS NULL ORDER BY id`)
      .all() as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /** 换 ticket 时仓库归属一起换（null 表示不属于任何仓库）。 */
  setTicket(id: string, ticketKey: string | null, repoId: number | null = null): void {
    this.db.prepare(`UPDATE sessions SET ticket_key = ?, repo_id = ? WHERE id = ?`).run(ticketKey, ticketKey ? repoId : null, id);
  }

  setWaiting(id: string, waiting: boolean, at: number): void {
    this.db
      .prepare(`UPDATE sessions SET waiting_for_input = ?, last_activity_at = MAX(COALESCE(last_activity_at, 0), ?) WHERE id = ?`)
      .run(waiting ? 1 : 0, at, id);
  }

  /** /clear、compact 产生的新 session 接替旧的：同一个终端，仓库、总控和开启者也照旧。 */
  setReplacedBy(id: string, newId: string): void {
    withTransaction(this.db, () => {
      this.db.prepare(`UPDATE sessions SET replaced_by = ? WHERE id = ?`).run(newId, id);
      this.db
        .prepare(
          `UPDATE sessions SET
             repo_id = COALESCE(repo_id, (SELECT o.repo_id FROM sessions o WHERE o.id = ?)),
             coordinator = MAX(coordinator, (SELECT o.coordinator FROM sessions o WHERE o.id = ?)),
             spawned_by = COALESCE(spawned_by, (SELECT o.spawned_by FROM sessions o WHERE o.id = ?))
           WHERE id = ? AND ticket_key IS (SELECT o.ticket_key FROM sessions o WHERE o.id = ?)`,
        )
        .run(id, id, id, newId, id);
    });
  }

  dismiss(id: string): void {
    this.db.prepare(`UPDATE sessions SET dismissed = 1 WHERE id = ?`).run(id);
  }

  undismiss(id: string): void {
    this.db.prepare(`UPDATE sessions SET dismissed = 0 WHERE id = ?`).run(id);
  }

  setOrigin(id: string, origin: SessionOrigin): void {
    this.db.prepare(`UPDATE sessions SET origin = ? WHERE id = ?`).run(origin, id);
  }

  /** 删除一行；指向它的 replaced_by 一并清掉，免得前一个 session 被当成“已替换”而从列表里消失。 */
  delete(id: string): void {
    withTransaction(this.db, () => {
      this.db.prepare(`UPDATE sessions SET replaced_by = NULL WHERE replaced_by = ?`).run(id);
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    });
    this.forgotten.add(id);
    if (this.forgotten.size > FORGOTTEN_LIMIT) this.forgotten.delete(this.forgotten.values().next().value as string);
  }

  /** Butler 自己的 headless 运行产生的 session：记成已忽略，磁盘扫描永远不会把它列进“未认领”。 */
  recordHeadless(id: string, cwd: string, at: number): void {
    // 只有这次调用新插入的行才忽略；已有的行（真实 session）绝不动。
    if (this.insertIfAbsent({ id, ticketKey: null, cwd, origin: "discovered", lastActivityAt: at, createdAt: at })) this.dismiss(id);
  }

  /** 沿 replaced_by 链走到最新的 session（/clear、compact 会产生新 id）。 */
  head(id: string): Session | null {
    let cur = this.get(id);
    const seen = new Set<string>();
    while (cur?.replacedBy && !seen.has(cur.id)) {
      seen.add(cur.id);
      const next = this.get(cur.replacedBy);
      if (!next) break;
      cur = next;
    }
    return cur;
  }
}
