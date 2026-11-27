import type { MailboxBlockReason, MessageKind, MessageStatus } from "../../shared/types";
import type { Db } from "./database";

/** 信箱里的一条消息（BTL-245）。时间都是毫秒。 */
export interface SessionMessage {
  id: string;
  kind: MessageKind;
  /** 发送方 session 的 head；Shipherd 自己发的（回答、预审、评论）为 null。 */
  fromSession: string | null;
  /** 排队那一刻接收方的 head：送的时候按 head 链找最新的。 */
  toSession: string;
  featureId: number | null;
  body: string;
  interrupt: boolean;
  ref: string | null;
  meta: unknown;
  status: MessageStatus;
  via: "hook" | "input" | null;
  expectsReply: boolean;
  baseReplyId: string | null;
  replyText: string | null;
  queuedAt: number;
  deliveredAt: number | null;
  repliedAt: number | null;
  /** 上一次试着送时挡住它的原因（BTL-269）；没挡过、送到了为 null。 */
  blockedReason: MailboxBlockReason | null;
  /** 这个原因从什么时候开始。 */
  blockedSince: number | null;
  /** 给发件的总控发「还没送到」回执的时间；没发过为 null。 */
  stuckReceiptAt: number | null;
}

export type NewSessionMessage = Pick<SessionMessage, "id" | "kind" | "fromSession" | "toSession" | "featureId" | "body" | "queuedAt"> &
  Partial<Pick<SessionMessage, "interrupt" | "ref" | "meta" | "expectsReply">>;

interface Row {
  id: string;
  kind: MessageKind;
  from_session: string | null;
  to_session: string;
  feature_id: number | bigint | null;
  body: string;
  interrupt: number | bigint;
  ref: string | null;
  meta: string | null;
  status: MessageStatus;
  via: "hook" | "input" | null;
  expects_reply: number | bigint;
  base_reply_id: string | null;
  reply_text: string | null;
  queued_at: number | bigint;
  delivered_at: number | bigint | null;
  replied_at: number | bigint | null;
  blocked_reason: MailboxBlockReason | null;
  blocked_since: number | bigint | null;
  stuck_receipt_at: number | bigint | null;
}

const num = (v: number | bigint | null): number | null => (v === null ? null : Number(v));

function parseMeta(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

const toMessage = (r: Row): SessionMessage => ({
  id: r.id, kind: r.kind, fromSession: r.from_session, toSession: r.to_session, featureId: num(r.feature_id), body: r.body,
  interrupt: Number(r.interrupt) === 1, ref: r.ref, meta: parseMeta(r.meta), status: r.status, via: r.via, expectsReply: Number(r.expects_reply) === 1,
  baseReplyId: r.base_reply_id, replyText: r.reply_text, queuedAt: Number(r.queued_at), deliveredAt: num(r.delivered_at), repliedAt: num(r.replied_at),
  blockedReason: r.blocked_reason, blockedSince: num(r.blocked_since), stuckReceiptAt: num(r.stuck_receipt_at),
});

/** 界面上的范围：Shipherd 总控发出或收到的（给它的 session id 们），或者一个 feature 的。 */
export type MessageFilter = { sessions: string[] } | { featureId: number };

export class SessionMessagesRepo {
  constructor(private readonly db: Db) {}

  /**
   * 排一条。带 ref、同一个 ref 已经有一条在排队时不新加：换成新的正文、meta 和 interrupt（回答改了、评论又多了一条），返回那一条的 id。
   */
  enqueue(m: NewSessionMessage): { id: string; replaced: boolean } {
    if (m.ref) {
      const old = this.db.prepare(`SELECT id FROM session_messages WHERE ref = ? AND status = 'queued'`).get(m.ref) as { id: string } | undefined;
      if (old) {
        this.db
          .prepare(`UPDATE session_messages SET body = ?, meta = ?, interrupt = ?, to_session = ? WHERE id = ?`)
          .run(m.body, m.meta === undefined ? null : JSON.stringify(m.meta), m.interrupt ? 1 : 0, m.toSession, old.id);
        return { id: old.id, replaced: true };
      }
    }
    this.db
      .prepare(
        `INSERT INTO session_messages (id, kind, from_session, to_session, feature_id, body, interrupt, ref, meta, expects_reply, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id, m.kind, m.fromSession, m.toSession, m.featureId, m.body, m.interrupt ? 1 : 0, m.ref ?? null,
        m.meta === undefined ? null : JSON.stringify(m.meta), m.expectsReply ? 1 : 0, m.queuedAt,
      );
    return { id: m.id, replaced: false };
  }

  get(id: string): SessionMessage | null {
    const r = this.db.prepare(`SELECT * FROM session_messages WHERE id = ?`).get(id) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  /** 这个 ref 正在排队的那一条；没有为 null。 */
  queuedByRef(ref: string): SessionMessage | null {
    const r = this.db.prepare(`SELECT * FROM session_messages WHERE ref = ? AND status = 'queued'`).get(ref) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  /** 撤回还在排队的那一条（来源那边已经没什么可送的了）；返回撤回的 id，没有为 null。 */
  withdraw(ref: string): string | null {
    const r = this.db.prepare(`DELETE FROM session_messages WHERE ref = ? AND status = 'queued' RETURNING id`).get(ref) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** 全部在排队的，先排的在前。 */
  queued(): SessionMessage[] {
    return (this.db.prepare(`SELECT * FROM session_messages WHERE status = 'queued' ORDER BY queued_at, rowid`).all() as unknown as Row[]).map(toMessage);
  }

  /** 送到了，记下怎么送的和送到时目标最后一条回复的 id。只从 queued 改；改了返回 true。 */
  delivered(id: string, o: { at: number; via: "hook" | "input"; toSession: string; baseReplyId: string | null }): boolean {
    const r = this.db
      .prepare(`UPDATE session_messages SET status = 'delivered', delivered_at = ?, via = ?, to_session = ?, base_reply_id = ? WHERE id = ? AND status = 'queued'`)
      .run(o.at, o.via, o.toSession, o.baseReplyId, id);
    return Number(r.changes) > 0;
  }

  /**
   * 记下挡住这几条（还在排队的）的原因：原因没变的不动（blocked_since 留着原因开始的时间），变了换成新原因和 at；reason 为 null 清掉。
   * 返回原因真的变了的那几条的 id。
   */
  setBlocked(ids: string[], reason: MailboxBlockReason | null, at: number): string[] {
    const changed: string[] = [];
    const stmt = this.db.prepare(
      `UPDATE session_messages SET blocked_reason = ?, blocked_since = ? WHERE id = ? AND status = 'queued' AND blocked_reason IS NOT ? RETURNING id`,
    );
    for (const id of ids) {
      const r = stmt.get(reason, reason === null ? null : at, id, reason) as { id: string } | undefined;
      if (r) changed.push(r.id);
    }
    return changed;
  }

  /** 记下已经给这几条发过「还没送到」的回执。 */
  setStuckReceipt(ids: string[], at: number): void {
    const stmt = this.db.prepare(`UPDATE session_messages SET stuck_receipt_at = ? WHERE id = ? AND stuck_receipt_at IS NULL`);
    for (const id of ids) stmt.run(at, id);
  }

  /** 送到了、还在等回复的（送到不早于 since）。 */
  awaitingReply(since: number): SessionMessage[] {
    return (
      this.db
        .prepare(`SELECT * FROM session_messages WHERE status = 'delivered' AND expects_reply = 1 AND delivered_at >= ? ORDER BY delivered_at, id`)
        .all(since) as unknown as Row[]
    ).map(toMessage);
  }

  /** 拿到回复。只从 delivered 改；改了返回 true。 */
  replied(id: string, reply: { text: string; at: number }): boolean {
    const r = this.db.prepare(`UPDATE session_messages SET status = 'replied', reply_text = ?, replied_at = ? WHERE id = ? AND status = 'delivered'`).run(reply.text, reply.at, id);
    return Number(r.changes) > 0;
  }

  /** 排队早于 before 的都删掉（还在排队的也删：目标一个月都没再打开）。返回删了几行。 */
  prune(before: number): number {
    return Number(this.db.prepare(`DELETE FROM session_messages WHERE queued_at < ?`).run(before).changes);
  }

  /** 最近的几条，新的在前。 */
  recent(filter: MessageFilter, limit: number): SessionMessage[] {
    if ("featureId" in filter) {
      return (
        this.db.prepare(`SELECT * FROM session_messages WHERE feature_id = ? ORDER BY queued_at DESC, id DESC LIMIT ?`).all(filter.featureId, limit) as unknown as Row[]
      ).map(toMessage);
    }
    if (filter.sessions.length === 0) return [];
    const marks = filter.sessions.map(() => "?").join(", ");
    return (
      this.db
        .prepare(`SELECT * FROM session_messages WHERE from_session IN (${marks}) OR to_session IN (${marks}) ORDER BY queued_at DESC, id DESC LIMIT ?`)
        .all(...filter.sessions, ...filter.sessions, limit) as unknown as Row[]
    ).map(toMessage);
  }
}
