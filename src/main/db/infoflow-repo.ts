import type { FlowActionMode, FlowActionState, FlowImportance, FlowKind, FlowMemoryState, FlowSpeaker } from "../../shared/infoflow";
import type { ConvTurn } from "./conv-repo";
import { withTransaction, type Db } from "./database";

/** 信息流转（BTL-272，迁移 62）的表。时间都是毫秒。 */

/** 一轮处理到哪了：retry 是执行出错（不是模型给的东西不对），过一会儿再试，试够次数记 failed。 */
/** capped：今天问模型的次数到上限了，这一轮等着（额度回来再问；等太久老化了记 skipped / capped）。retry、capped 都还没处理完。 */
export type FlowTurnState = "skipped" | "done" | "failed" | "retry" | "capped";

export interface FlowItemRow {
  id: number;
  turnId: number;
  idx: number;
  sessionId: string;
  rootSessionId: string;
  /** 来源 session 所在的 epic。 */
  featureId: number | null;
  /** 目标涉及的 epic（列表按 epic 筛）。 */
  targetFeatures: number[];
  text: string;
  kind: FlowKind;
  speaker: FlowSpeaker;
  quote: string;
  /** 解析好的目标（targetLabel 的写法）。 */
  targets: string[];
  importance: FlowImportance;
  confidence: number;
  scope: string | null;
  memory: FlowMemoryState;
  /** 写进记忆的那一整条（带来源注记）；还没写过为空。 */
  note: string | null;
  dupOf: string | null;
  /** 去重比较的范围（narrowestScope，不论写不写记忆）。 */
  area: string;
  /** false：只记不发（回应别人发来的要点时，免得来回转）。 */
  routable: boolean;
  /** 模型给的状态变化（RawChange 的 JSON）；没有为 null。 */
  changeRaw: string | null;
  /** 记完、发完（或者定了不记不发）的时间；为空的还没做完，重启后接着做。 */
  followedAt: number | null;
  createdAt: number;
}

export interface FlowDeliveryRow {
  itemId: number;
  toSession: string;
  messageId: string;
  /** 信箱里的状态；消息已经删掉为 null。 */
  status: "queued" | "delivered" | "replied" | null;
  deliveredAt: number | null;
}

export interface FlowActionRow {
  id: number;
  itemId: number;
  change: string;
  signature: string;
  mode: FlowActionMode;
  state: FlowActionState;
  undo: string | null;
  error: string | null;
  /** partial 时没处理完的（JSON）。 */
  leftovers: string | null;
  createdAt: number;
  decidedAt: number | null;
  dismissedAt: number | null;
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
function jsonArr<T>(v: unknown, ok: (x: unknown) => x is T): T[] {
  try {
    const a = JSON.parse(String(v)) as unknown;
    return Array.isArray(a) ? a.filter(ok) : [];
  } catch {
    return [];
  }
}
const isNum = (x: unknown): x is number => typeof x === "number";
const isStr = (x: unknown): x is string => typeof x === "string";

const toItem = (r: Raw): FlowItemRow => ({
  id: num(r.id), turnId: num(r.turn_id), idx: num(r.idx), sessionId: String(r.session_id), rootSessionId: String(r.root_session_id),
  featureId: numOrNull(r.feature_id), targetFeatures: jsonArr(r.target_features, isNum), text: String(r.text), kind: r.kind as FlowKind,
  speaker: r.speaker as FlowSpeaker, quote: String(r.quote), targets: jsonArr(r.targets, isStr), importance: r.importance as FlowImportance,
  confidence: Number(r.confidence), scope: strOrNull(r.scope), memory: r.memory as FlowMemoryState, note: strOrNull(r.note), dupOf: strOrNull(r.dup_of), area: String(r.area),
  routable: num(r.routable) === 1, changeRaw: strOrNull(r.change_raw), followedAt: numOrNull(r.followed_at), createdAt: num(r.created_at),
});

const toAction = (r: Raw): FlowActionRow => ({
  id: num(r.id), itemId: num(r.item_id), change: String(r.change), signature: String(r.signature), mode: r.mode as FlowActionMode,
  state: r.state as FlowActionState, undo: strOrNull(r.undo), error: strOrNull(r.error), leftovers: strOrNull(r.leftovers), createdAt: num(r.created_at),
  decidedAt: numOrNull(r.decided_at), dismissedAt: numOrNull(r.dismissed_at),
});

const turnFromRow = (r: Raw): ConvTurn => ({
  id: num(r.id), rootSessionId: String(r.root_session_id), sessionId: String(r.session_id), sourceKey: strOrNull(r.source_key), forkId: numOrNull(r.fork_id),
  kind: r.kind as ConvTurn["kind"], startedAt: num(r.started_at), lastAt: num(r.last_at), endedAt: numOrNull(r.ended_at), asked: num(r.asked) === 1,
  mutated: num(r.mutated) === 1, otherTools: num(r.other_tools) === 1, qa: r.qa as ConvTurn["qa"], qaBy: (r.qa_by ?? null) as ConvTurn["qaBy"],
});

export type NewFlowItem = Omit<FlowItemRow, "id" | "followedAt" | "note">;

export class InfoflowRepo {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  // ---- 轮 ----

  /**
   * 还没处理过的、已经结束的轮：结束不早于 since（太早的不补），最后一条话不晚于 settledBefore（agent 停下来又接着说的，等它说完），
   * 只要用户轮和后台轮，最早结束的在前。after 是上一页最后一个（ended_at, id）：这一页都跳过了（熔断压着）就往后翻，不让它们挡住别人。
   * skipCapped：已经因为到上限在等着的轮也不要（还在上限时不用每一遍都再看它们）。
   */
  pendingTurns(since: number, settledBefore: number, limit: number, after?: { endedAt: number; id: number }, skipCapped = false): ConvTurn[] {
    const a = after ?? { endedAt: -1, id: -1 };
    const open = skipCapped ? "('retry')" : "('retry', 'capped')";
    const rows = this.db
      .prepare(
        `SELECT t.* FROM conv_turns t WHERE t.ended_at IS NOT NULL AND t.ended_at >= ? AND t.last_at <= ? AND t.kind IN ('user','silent')
           AND (t.ended_at > ? OR (t.ended_at = ? AND t.id > ?))
           AND NOT EXISTS (SELECT 1 FROM infoflow_turns f WHERE f.turn_id = t.id AND f.state NOT IN ${open}) ORDER BY t.ended_at, t.id LIMIT ?`,
      )
      .all(since, settledBefore, a.endedAt, a.endedAt, a.id, limit) as Raw[];
    return rows.map(turnFromRow);
  }

  /** 这些 session 在 [from, to] 里收到过信息流转发的要点（回应它的话不再转发）。 */
  factDelivered(sessionIds: readonly string[], from: number, to: number): boolean {
    if (sessionIds.length === 0) return false;
    return (
      this.db
        .prepare(
          `SELECT 1 FROM session_messages WHERE kind = 'fact' AND to_session IN (${sessionIds.map(() => "?").join(", ")}) AND delivered_at >= ? AND delivered_at <= ? LIMIT 1`,
        )
        .get(...sessionIds, from, to) !== undefined
    );
  }

  turnHandled(turnId: number): boolean {
    return this.db.prepare(`SELECT 1 FROM infoflow_turns WHERE turn_id = ? AND state NOT IN ('retry', 'capped')`).get(turnId) !== undefined;
  }

  /** 这一轮已经因为到上限在等着了。 */
  turnCapped(turnId: number): boolean {
    return this.db.prepare(`SELECT 1 FROM infoflow_turns WHERE turn_id = ? AND state = 'capped'`).get(turnId) !== undefined;
  }

  /** 到上限了，这一轮先等着（还算没处理）。已经处理完的不动；在重试的改成等着（次数留着）。 */
  holdCapped(t: { turnId: number; sessionId: string; at: number }): void {
    this.db
      .prepare(
        `INSERT INTO infoflow_turns (turn_id, session_id, state, reason, items, at) VALUES (?, ?, 'capped', 'capped', 0, ?)
           ON CONFLICT (turn_id) DO UPDATE SET state = 'capped', reason = 'capped' WHERE infoflow_turns.state = 'retry'`,
      )
      .run(t.turnId, t.sessionId, t.at);
  }

  /** 等上限等到老化了（结束早于 endedBefore）的轮：记成 skipped（原因 capped），不再问。返回这次丢了几轮。 */
  expireCapped(endedBefore: number, at: number): number {
    return Number(
      this.db
        .prepare(
          `UPDATE infoflow_turns SET state = 'skipped', reason = 'capped', at = ? WHERE state = 'capped'
             AND turn_id IN (SELECT id FROM conv_turns WHERE ended_at IS NULL OR ended_at < ?)`,
        )
        .run(at, endedBefore).changes,
    );
  }

  /** since 以后因为到上限、等太久丢掉的轮有几轮。 */
  cappedDropped(since: number): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM infoflow_turns WHERE state = 'skipped' AND reason = 'capped' AND at >= ?`).get(since) as { n: number | bigint };
    return Number(r.n);
  }

  /** 问了一次模型（每天的上限按它数）。 */
  recordAsk(at: number): void {
    this.db.prepare(`INSERT INTO infoflow_asks (at) VALUES (?)`).run(at);
  }

  /**
   * since 以后（不含 since 那一刻）问了几次模型，最早的一次是什么时候（没有为 null）。不含左端点：at 那次问的，
   * 到 at + 24 小时那一刻就不算在「最近 24 小时」里了，和 resumesAt 说的时间对得上。
   */
  asksSince(since: number): { count: number; oldest: number | null } {
    const r = this.db.prepare(`SELECT COUNT(*) AS n, MIN(at) AS oldest FROM infoflow_asks WHERE at > ?`).get(since) as { n: number | bigint; oldest: number | bigint | null };
    return { count: Number(r.n), oldest: r.oldest === null ? null : Number(r.oldest) };
  }

  /** since 以后（不含 since，和 asksSince 一样）第 n 早（从 1 数）的那次问模型的时间；没有那么多次为 null。 */
  nthAskSince(since: number, n: number): number | null {
    if (n < 1) return null;
    const r = this.db.prepare(`SELECT at FROM infoflow_asks WHERE at > ? ORDER BY at, id LIMIT 1 OFFSET ?`).get(since, n - 1) as { at: number | bigint } | undefined;
    return r ? Number(r.at) : null;
  }

  /** 执行出错，记一次（还没处理完，下一遍再试）。返回一共试了几次；已经处理完的轮不动，返回 null。 */
  retryTurn(t: { turnId: number; sessionId: string; reason: string; at: number }): number | null {
    const r = this.db
      .prepare(
        `INSERT INTO infoflow_turns (turn_id, session_id, state, reason, items, attempts, at) VALUES (?, ?, 'retry', ?, 0, 1, ?)
           ON CONFLICT (turn_id) DO UPDATE SET state = 'retry', attempts = attempts + 1, reason = excluded.reason, at = excluded.at
             WHERE infoflow_turns.state IN ('retry', 'capped')
           RETURNING attempts`,
      )
      .get(t.turnId, t.sessionId, t.reason, t.at) as { attempts: number | bigint } | undefined;
    return r ? Number(r.attempts) : null;
  }

  /** 记下这一轮处理过了；已经记过就不改（返回 false）。只有 retry（还在重试）、capped（等上限）的能改成别的结果。 */
  markTurn(t: { turnId: number; sessionId: string; state: FlowTurnState; reason: string | null; items: number; at: number }): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO infoflow_turns (turn_id, session_id, state, reason, items, at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (turn_id) DO UPDATE SET state = excluded.state, reason = excluded.reason, items = excluded.items, at = excluded.at
             WHERE infoflow_turns.state IN ('retry', 'capped')`,
        )
        .run(t.turnId, t.sessionId, t.state, t.reason, t.items, t.at).changes > 0
    );
  }

  // ---- 要点 ----

  /** 插一条；同一轮同一个序号已经有了返回 null。 */
  addItem(i: NewFlowItem): number | null {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO infoflow_items (turn_id, idx, session_id, root_session_id, feature_id, target_features, text, kind, speaker, quote, targets,
           importance, confidence, scope, memory, dup_of, area, routable, change_raw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.turnId, i.idx, i.sessionId, i.rootSessionId, i.featureId, JSON.stringify(i.targetFeatures), i.text, i.kind, i.speaker, i.quote, JSON.stringify(i.targets),
        i.importance, i.confidence, i.scope, i.memory, i.dupOf, i.area, i.routable ? 1 : 0, i.changeRaw, i.createdAt,
      );
    return r.changes > 0 ? Number(r.lastInsertRowid) : null;
  }

  /** 记下要写进记忆的那一整条（写之前记：写到一半退出了，撤销时也认得出是哪一条）。 */
  setNote(id: number, note: string): void {
    this.db.prepare(`UPDATE infoflow_items SET note = ? WHERE id = ?`).run(note, id);
  }

  setMemory(id: number, memory: FlowMemoryState): void {
    this.db.prepare(`UPDATE infoflow_items SET memory = ? WHERE id = ?`).run(memory, id);
  }

  /** 只在现在还是 from 里的某一个时才改（写记忆的结果回来时，这条要点可能已经被撤销、作废）。返回改没改。 */
  setMemoryFrom(id: number, from: readonly FlowMemoryState[], memory: FlowMemoryState): boolean {
    return (
      this.db
        .prepare(`UPDATE infoflow_items SET memory = ? WHERE id = ? AND memory IN (${from.map(() => "?").join(", ")})`)
        .run(memory, id, ...from).changes > 0
    );
  }

  /** 记完、发完了（或者定了不记不发）。只记第一次。 */
  setFollowed(id: number, at: number): void {
    this.db.prepare(`UPDATE infoflow_items SET followed_at = ? WHERE id = ? AND followed_at IS NULL`).run(at, id);
  }

  /**
   * 还没跟进完的，先抽出来的在前：重启后接着记、接着发。等你确认的不算（确认、拒绝、作废时再接着做）；
   * 但确认了、或者自动执行到一半退出的都算（按状态的现状判断，不按 memory 推断）：确认模式下点了「照做」、执行到一半退出的
   * 还是 pending，靠已经存下的撤销（undo 不为空）认出来。
   */
  unfollowed(limit: number): FlowItemRow[] {
    return (
      this.db
        .prepare(
          `SELECT i.* FROM infoflow_items i WHERE i.followed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM infoflow_actions a WHERE a.item_id = i.id AND ((a.state = 'pending' AND a.mode = 'confirm' AND a.undo IS NULL) OR a.state = 'partial'))
             ORDER BY i.created_at, i.id LIMIT ?`,
        )
        .all(limit) as Raw[]
    ).map(toItem);
  }

  item(id: number): FlowItemRow | null {
    const r = this.db.prepare(`SELECT * FROM infoflow_items WHERE id = ?`).get(id) as Raw | undefined;
    return r ? toItem(r) : null;
  }

  /**
   * 最近抽出来、真的记下或发出去了的要点的原文（去重用），新的在前。只看这几个范围（自己这一级和盖住它的）：别的 epic 说过的不算。
   * 重复的、没写进去的、还没做完的、等确认的、没用上的都不算。
   */
  recentTexts(since: number, areas: readonly string[], limit: number): string[] {
    if (areas.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT text FROM infoflow_items WHERE created_at >= ? AND memory IN ('written','skipped','full','disabled') AND area IN (${areas.map(() => "?").join(", ")})
             ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(since, ...areas, limit) as Raw[]
    ).map((r) => String(r.text));
  }

  /** 列表：全部，或者来源在这个 epic、目标涉及这个 epic 的。新的在前。 */
  items(scope: { all: true } | { featureId: number }, limit: number): FlowItemRow[] {
    const rows = (
      "all" in scope
        ? this.db.prepare(`SELECT * FROM infoflow_items ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit)
        : this.db
            .prepare(
              `SELECT * FROM infoflow_items WHERE feature_id = ? OR EXISTS (SELECT 1 FROM json_each(target_features) j WHERE j.value = ?)
                 ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(scope.featureId, scope.featureId, limit)
    ) as Raw[];
    return rows.map(toItem);
  }

  // ---- 发送 ----

  /** 记一次发送；这条已经发给过这个 session 返回 false（同一条不发两次）。 */
  addDelivery(itemId: number, toSession: string, messageId: string, at: number): boolean {
    return (
      this.db.prepare(`INSERT OR IGNORE INTO infoflow_deliveries (item_id, to_session, message_id, created_at) VALUES (?, ?, ?, ?)`).run(itemId, toSession, messageId, at)
        .changes > 0
    );
  }

  delivered(itemId: number, toSession: string): boolean {
    return this.db.prepare(`SELECT 1 FROM infoflow_deliveries WHERE item_id = ? AND to_session = ?`).get(itemId, toSession) !== undefined;
  }

  deliveries(itemIds: readonly number[]): FlowDeliveryRow[] {
    if (itemIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT d.item_id, d.to_session, d.message_id, m.status, m.delivered_at FROM infoflow_deliveries d LEFT JOIN session_messages m ON m.id = d.message_id
           WHERE d.item_id IN (${itemIds.map(() => "?").join(", ")}) ORDER BY d.created_at, d.rowid`,
      )
      .all(...itemIds) as Raw[];
    return rows.map((r) => ({
      itemId: num(r.item_id), toSession: String(r.to_session), messageId: String(r.message_id),
      status: (r.status ?? null) as FlowDeliveryRow["status"], deliveredAt: numOrNull(r.delivered_at),
    }));
  }

  // ---- 状态变化 ----

  addAction(a: { itemId: number; change: string; signature: string; mode: FlowActionMode; state: FlowActionState; createdAt: number }): number | null {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO infoflow_actions (item_id, change, signature, mode, state, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(a.itemId, a.change, a.signature, a.mode, a.state, a.createdAt);
    return r.changes > 0 ? Number(r.lastInsertRowid) : null;
  }

  action(id: number): FlowActionRow | null {
    const r = this.db.prepare(`SELECT * FROM infoflow_actions WHERE id = ?`).get(id) as Raw | undefined;
    return r ? toAction(r) : null;
  }

  /** 执行到一半退出的（还是 pending，却已经存了撤销用的旧状态），先存的在前：下一遍不管开没开「自动抽要点」都先把它们了结。 */
  interruptedActions(limit: number): FlowActionRow[] {
    return (
      this.db.prepare(`SELECT * FROM infoflow_actions WHERE state = 'pending' AND undo IS NOT NULL ORDER BY id LIMIT ?`).all(limit) as Raw[]
    ).map(toAction);
  }

  actionsFor(itemIds: readonly number[]): FlowActionRow[] {
    if (itemIds.length === 0) return [];
    return (this.db.prepare(`SELECT * FROM infoflow_actions WHERE item_id IN (${itemIds.map(() => "?").join(", ")})`).all(...itemIds) as Raw[]).map(toAction);
  }

  /**
   * 同一个变化最近已经有一条在等确认、执行了或者本来就是这样：不再提一次。declined：用户不要、撤销了的也算（不是用户自己又说一遍的，
   * 比如总控转述，不能把用户刚拒掉的又提出来）。
   */
  liveBySignature(signature: string, since: number, declined = false): FlowActionRow | null {
    const states = declined ? "'pending','applied','partial','already','rejected','undone'" : "'pending','applied','partial','already'";
    const r = this.db
      .prepare(`SELECT * FROM infoflow_actions WHERE signature = ? AND created_at >= ? AND state IN (${states}) ORDER BY id DESC LIMIT 1`)
      .get(signature, since) as Raw | undefined;
    return r ? toAction(r) : null;
  }

  actionForItem(itemId: number): FlowActionRow | null {
    const r = this.db.prepare(`SELECT * FROM infoflow_actions WHERE item_id = ?`).get(itemId) as Raw | undefined;
    return r ? toAction(r) : null;
  }

  /** 执行前先存下撤销用的旧状态（还在 pending 才存）。返回存没存：不是 pending 了就别执行。 */
  setUndo(id: number, undo: string): boolean {
    return this.db.prepare(`UPDATE infoflow_actions SET undo = ? WHERE id = ? AND state = 'pending'`).run(undo, id).changes > 0;
  }

  /**
   * 改状态，只在现在是 from 里的某一个时才改（两个窗口同时点、确认和作废同时发生时只算一次）。返回改没改。
   */
  transition(
    id: number, from: readonly FlowActionState[], to: FlowActionState, p: { at: number; undo?: string | null; error?: string | null; leftovers?: string | null },
  ): boolean {
    const sets = ["state = ?", "decided_at = ?", "leftovers = ?"];
    // 离开 partial（或者进 partial 没给）就清掉：只有 partial 有没处理完的。
    const args: (string | number | null)[] = [to, p.at, to === "partial" ? (p.leftovers ?? null) : null];
    if (p.undo !== undefined) {
      sets.push("undo = ?");
      args.push(p.undo);
    }
    if (p.error !== undefined) {
      sets.push("error = ?");
      args.push(p.error);
    }
    return (
      this.db
        .prepare(`UPDATE infoflow_actions SET ${sets.join(", ")} WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`)
        .run(...args, id, ...from).changes > 0
    );
  }

  /**
   * 还在等确认的，换上新的变化内容（要关的 PR 变了，按新的那份再问一次），error 写为什么又问。返回改没改。
   * 撤销用的旧状态一起清掉：这一次什么都没做，留着它会被当成「确认了、执行到一半」自动接着执行。
   */
  repropose(id: number, change: string, error: string | null): boolean {
    return this.db.prepare(`UPDATE infoflow_actions SET change = ?, error = ?, undo = NULL WHERE id = ? AND state = 'pending'`).run(change, error, id).changes > 0;
  }

  dismiss(id: number, at: number): boolean {
    return this.db.prepare(`UPDATE infoflow_actions SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`).run(at, id).changes > 0;
  }

  /** 等确认的（轮到你）。 */
  pending(): FlowActionRow[] {
    return (this.db.prepare(`SELECT * FROM infoflow_actions WHERE state = 'pending' ORDER BY created_at, id`).all() as Raw[]).map(toAction);
  }

  /** 关了但还有没处理完的（轮到你：重试、就这样、撤销）。 */
  partial(): FlowActionRow[] {
    return (this.db.prepare(`SELECT * FROM infoflow_actions WHERE state = 'partial' ORDER BY decided_at, id`).all() as Raw[]).map(toAction);
  }

  /**
   * 后台要核对结果还在不在的（被手动改回去了就撤回还在排队的消息、记 stale）：since 以后执行了的（applied）；
   * partial（ticket 关了、PR 还没关上：「轮到你」里一直挂着）；还有消息在排队的 applied、already
   * （wake=false 的要点一直排到对方下次打开）。后两种看得久一些，到 keepSince 为止（信箱和这些记录都只留这么久）。
   */
  toRecheck(since: number, keepSince: number): FlowActionRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM infoflow_actions a WHERE (a.state = 'applied' AND a.decided_at >= ?)
             OR (COALESCE(a.decided_at, a.created_at) >= ? AND (a.state = 'partial' OR (a.state IN ('applied', 'already') AND EXISTS (
               SELECT 1 FROM infoflow_deliveries d JOIN session_messages m ON m.id = d.message_id WHERE d.item_id = a.item_id AND m.status = 'queued'))))
           ORDER BY a.decided_at, a.id`,
        )
        .all(since, keepSince) as Raw[]
    ).map(toAction);
  }

  /** 还在排队的要点消息（ref 是 flow:…；「已撤销」那种 flowundo:… 不算：那是更正已经送到的话）。 */
  queuedFlowRefs(): string[] {
    return (this.db.prepare(`SELECT ref FROM session_messages WHERE status = 'queued' AND ref LIKE 'flow:%' ORDER BY queued_at, id`).all() as { ref: string }[]).map((r) => r.ref);
  }

  /**
   * 删掉旧记录：before 以前的轮、要点（连同它的递送、状态变化），asksBefore 以前问模型的记录。
   * 还在等你的（等确认、关了一半）和还有消息在排队的要点留着。返回删了几行。
   */
  prune(before: number, asksBefore: number): number {
    return withTransaction(this.db, () => {
      const old = `SELECT i.id FROM infoflow_items i WHERE i.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM infoflow_actions a WHERE a.item_id = i.id AND a.state IN ('pending', 'partial'))
        AND NOT EXISTS (SELECT 1 FROM infoflow_deliveries d JOIN session_messages m ON m.id = d.message_id WHERE d.item_id = i.id AND m.status = 'queued')`;
      let n = 0;
      // 不靠外键级联：先删子表，再删要点。
      n += Number(this.db.prepare(`DELETE FROM infoflow_deliveries WHERE item_id IN (${old})`).run(before).changes);
      n += Number(this.db.prepare(`DELETE FROM infoflow_actions WHERE item_id IN (${old})`).run(before).changes);
      n += Number(this.db.prepare(`DELETE FROM infoflow_items WHERE id IN (${old})`).run(before).changes);
      n += Number(this.db.prepare(`DELETE FROM infoflow_turns WHERE at < ?`).run(before).changes);
      n += Number(this.db.prepare(`DELETE FROM infoflow_asks WHERE at < ?`).run(asksBefore).changes);
      return n;
    });
  }

  /** 自动执行了、还没被收起的（「已替你同步」）。since 之前的不再显示。 */
  synced(since: number): FlowActionRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM infoflow_actions WHERE mode = 'auto' AND state = 'applied' AND dismissed_at IS NULL AND decided_at >= ? ORDER BY decided_at, id`)
        .all(since) as Raw[]
    ).map(toAction);
  }
}
