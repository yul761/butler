import type { Db } from "./database";

/**
 * Butler 总控 send_message 的一条消息和它的回复（设计文档 2026-11-17 ws-b 第 2 节）。
 * sending：在等 deliver 的结果；waiting：送到了，等回复；replied：拿到回复，等送回总控；delivered：送回去了。
 * failed：没送进目标终端；expired：一直没回复，或者回复一直没能送回去。
 */
export const BUTLER_MESSAGE_STATUSES = ["sending", "waiting", "replied", "delivered", "failed", "expired"] as const;
export type ButlerMessageStatus = (typeof BUTLER_MESSAGE_STATUSES)[number];

export interface ButlerMessage {
  id: string;
  fromSession: string;
  /** 送到的那个 session；打开终端的情况下拿到新 head 之前为 null。 */
  targetSession: string | null;
  featureId: number | null;
  epicId: number | null;
  text: string;
  /** 送之前目标最后一条回复的 id：回复要和它不同才算。 */
  baseReplyId: string | null;
  status: ButlerMessageStatus;
  error: string | null;
  queuedAt: number;
  replyId: string | null;
  replyText: string | null;
  repliedAt: number | null;
  deliveredAt: number | null;
}

interface Row {
  id: string;
  from_session: string;
  target_session: string | null;
  feature_id: number | null;
  epic_id: number | null;
  text: string;
  base_reply_id: string | null;
  status: ButlerMessageStatus;
  error: string | null;
  queued_at: number;
  reply_id: string | null;
  reply_text: string | null;
  replied_at: number | null;
  delivered_at: number | null;
}

const num = (v: number | bigint | null): number | null => (v === null ? null : Number(v));

const toMessage = (r: Row): ButlerMessage => ({
  id: r.id, fromSession: r.from_session, targetSession: r.target_session, featureId: num(r.feature_id), epicId: num(r.epic_id), text: r.text,
  baseReplyId: r.base_reply_id, status: r.status, error: r.error, queuedAt: Number(r.queued_at), replyId: r.reply_id, replyText: r.reply_text,
  repliedAt: num(r.replied_at), deliveredAt: num(r.delivered_at),
});

export type NewButlerMessage = Pick<ButlerMessage, "id" | "fromSession" | "targetSession" | "featureId" | "epicId" | "text" | "baseReplyId" | "queuedAt">;

export class ButlerMessagesRepo {
  constructor(private readonly db: Db) {}

  insert(m: NewButlerMessage): void {
    this.db
      .prepare(
        `INSERT INTO butler_messages (id, from_session, target_session, feature_id, epic_id, text, base_reply_id, status, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', ?)`,
      )
      .run(m.id, m.fromSession, m.targetSession, m.featureId, m.epicId, m.text, m.baseReplyId, m.queuedAt);
  }

  get(id: string): ButlerMessage | null {
    const r = this.db.prepare(`SELECT * FROM butler_messages WHERE id = ?`).get(id) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  /** 送到了：记下送到的 session，开始等回复。只从 sending 改。 */
  sent(id: string, targetSession: string): void {
    this.db.prepare(`UPDATE butler_messages SET status = 'waiting', target_session = ? WHERE id = ? AND status = 'sending'`).run(targetSession, id);
  }

  /** 没送进去。只从 sending 改。 */
  failed(id: string, error: string): void {
    this.db.prepare(`UPDATE butler_messages SET status = 'failed', error = ? WHERE id = ? AND status = 'sending'`).run(error, id);
  }

  withStatus(status: ButlerMessageStatus): ButlerMessage[] {
    return (this.db.prepare(`SELECT * FROM butler_messages WHERE status = ? ORDER BY queued_at, id`).all(status) as unknown as Row[]).map(toMessage);
  }

  /** 拿到回复。只从 waiting 改。 */
  replied(id: string, reply: { id: string; text: string; at: number }): void {
    this.db
      .prepare(`UPDATE butler_messages SET status = 'replied', reply_id = ?, reply_text = ?, replied_at = ? WHERE id = ? AND status = 'waiting'`)
      .run(reply.id, reply.text, reply.at, id);
  }

  /** 回复送回了总控。只从 replied 改。 */
  delivered(ids: string[], at: number): void {
    const stmt = this.db.prepare(`UPDATE butler_messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'replied'`);
    for (const id of ids) stmt.run(at, id);
  }

  /** waiting 超过 waitMs 没回复、replied 超过 deliverMs 没送回的，记成 expired；返回改了几行。 */
  expire(now: number, waitMs: number, deliverMs: number): number {
    const a = this.db
      .prepare(`UPDATE butler_messages SET status = 'expired', error = 'no_reply' WHERE status IN ('waiting', 'sending') AND queued_at < ?`)
      .run(now - waitMs);
    const b = this.db
      .prepare(`UPDATE butler_messages SET status = 'expired', error = 'not_delivered' WHERE status = 'replied' AND replied_at < ?`)
      .run(now - deliverMs);
    return Number(a.changes) + Number(b.changes);
  }

  /** 最近的几条，新的在前。 */
  recent(limit: number): ButlerMessage[] {
    return (this.db.prepare(`SELECT * FROM butler_messages ORDER BY queued_at DESC, id DESC LIMIT ?`).all(limit) as unknown as Row[]).map(toMessage);
  }
}
