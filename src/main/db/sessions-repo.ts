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
  dismissed_at: number | null;
  created_at: number;
  repo_id: number | null;
  coordinator: number;
  spawned_by: string | null;
  feature_id: number | null;
  fixes_session: string | null;
  epic_id: number | null;
  model: string | null;
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
    featureId: r.feature_id === null ? null : Number(r.feature_id),
    fixesSession: r.fixes_session,
    epicId: r.epic_id === null ? null : Number(r.epic_id),
    model: r.model,
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
  featureId?: number | null;
  fixesSession?: string | null;
  epicId?: number | null;
  model?: string | null;
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
        `INSERT OR IGNORE INTO sessions (id, ticket_key, cwd, origin, git_branch, first_prompt, last_activity_at, created_at, repo_id, coordinator, spawned_by, feature_id, fixes_session, epic_id, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id, s.ticketKey, s.cwd, s.origin, s.gitBranch ?? null, s.firstPrompt ?? null, s.lastActivityAt ?? null, s.createdAt,
        s.repoId ?? null, s.coordinator ? 1 : 0, s.spawnedBy ?? null, s.featureId ?? null, s.fixesSession ?? null, s.epicId ?? null, s.model ?? null,
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

  /** feature 级 session（ticket_key 为空、feature_id 是这个 feature 的）：总控和修复 session。要选总控（汇总、handoff）用 listFeatureCoordinators。 */
  listByFeature(featureId: number): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE feature_id = ? AND ticket_key IS NULL ORDER BY ${RECENCY} DESC, id`)
      .all(featureId) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /** feature 总控 session：不含修复 session。 */
  listFeatureCoordinators(featureId: number): Session[] {
    return this.listByFeature(featureId).filter((s) => s.fixesSession === null);
  }

  /** 记成这个 feature 的总控。 */
  setFeature(id: string, featureId: number): void {
    this.db.prepare(`UPDATE sessions SET feature_id = ?, coordinator = 1 WHERE id = ?`).run(featureId, id);
  }

  /** epic session（ticket_key 和 feature_id 都为空、epic_id 是这个 epic 的）。 */
  listByEpic(epicId: number): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE epic_id = ? AND ticket_key IS NULL AND feature_id IS NULL ORDER BY ${RECENCY} DESC, id`)
      .all(epicId) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /** 记成这个 epic 的 session；null：它不是 epic session（嵌套的 claude）。 */
  setEpic(id: string, epicId: number | null): void {
    this.db.prepare(`UPDATE sessions SET epic_id = ? WHERE id = ?`).run(epicId, id);
  }

  listUnclaimed(sinceMs: number): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE ticket_key IS NULL AND feature_id IS NULL AND epic_id IS NULL AND dismissed = 0 AND replaced_by IS NULL AND ${RECENCY} >= ?
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

  /**
   * /clear、compact 产生的新 session 接替旧的：同一个终端，仓库、总控、开启者、feature 和修复目标也照旧。
   * 修复 session 的新段不是总控：磁盘扫描可能先按目录把它记成了总控，这里清掉。
   * epic session 和 feature 级 session 互斥，同样以旧 session 为准：epic session 的新段不会是 feature 总控，反过来也一样。
   * /resume（source 是 "resume"）接上的是已有的 session，不是新段：总控、feature、修复目标都留它自己的。resume 出来的新 id 由 hook 插入时继承。
   */
  setReplacedBy(id: string, newId: string, source?: string | null): void {
    const old = (column: string) => `(SELECT o.${column} FROM sessions o WHERE o.id = ?1)`;
    const role = `,
      coordinator = CASE WHEN ${old("fixes_session")} IS NULL AND ${old("epic_id")} IS NULL THEN MAX(coordinator, ${old("coordinator")}) ELSE 0 END,
      feature_id = CASE WHEN ${old("epic_id")} IS NULL THEN COALESCE(feature_id, ${old("feature_id")}) END,
      epic_id = CASE WHEN ${old("feature_id")} IS NULL THEN COALESCE(epic_id, ${old("epic_id")}) END,
      fixes_session = COALESCE(fixes_session, ${old("fixes_session")})`;
    withTransaction(this.db, () => {
      this.db.prepare(`UPDATE sessions SET replaced_by = ?2 WHERE id = ?1`).run(id, newId);
      this.db
        .prepare(
          `UPDATE sessions SET
             repo_id = COALESCE(repo_id, ${old("repo_id")}),
             spawned_by = COALESCE(spawned_by, ${old("spawned_by")}),
             model = COALESCE(model, ${old("model")})${source === "resume" ? "" : role}
           WHERE id = ?2 AND ticket_key IS ${old("ticket_key")}`,
        )
        .run(id, newId);
    });
  }

  /** 隐藏；at 是隐藏的时间（隐藏超过 14 天的自动删掉，BTL-190 第 8 点）。已经隐藏着的不改时间。 */
  dismiss(id: string, at: number = Date.now()): void {
    this.db.prepare(`UPDATE sessions SET dismissed = 1, dismissed_at = COALESCE(dismissed_at, ?) WHERE id = ?`).run(at, id);
  }

  undismiss(id: string): void {
    this.db.prepare(`UPDATE sessions SET dismissed = 0, dismissed_at = NULL WHERE id = ?`).run(id);
  }

  /**
   * 隐藏着、隐藏和最后一次活动都早于 before 的 head（没被 /clear 替换的行）：自动删除的候选（BTL-190 第 8 点）。
   * 终端是不是开着由调用方看。
   */
  listHiddenBefore(before: number): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE dismissed = 1 AND replaced_by IS NULL AND COALESCE(dismissed_at, 0) < ?1 AND ${RECENCY} < ?1
         ORDER BY id`,
      )
      .all(before) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /** 这个 head 的整条链：head 自己和所有沿 replaced_by 走到它的旧 id（/clear、compact 之前的段）。 */
  chainOf(headId: string): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION SELECT s.id FROM sessions s JOIN chain c ON s.replaced_by = c.id
         )
         SELECT id FROM chain`,
      )
      .all(headId) as unknown as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * 删掉一整条链（BTL-190 第 8 点）：只删 head 的话，前一段的 replaced_by 被清掉，会作为一个没隐藏的 session 重新出现在列表里。
   * 合并总控里还没通知到这些 id 的等待者一起删掉：session 不在了，没有地方递。返回删掉的 id（不存在的 head 返回 []）。
   * transcript、handoff、用量这些只记着 session id 的历史不动。
   */
  deleteChain(headId: string): string[] {
    const ids = this.chainOf(headId);
    if (ids.length === 0) return [];
    withTransaction(this.db, () => {
      for (const id of ids) {
        this.db.prepare(`DELETE FROM merge_waiters WHERE session_id = ? AND notified_at IS NULL`).run(id);
        this.delete(id);
      }
    });
    return ids;
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
