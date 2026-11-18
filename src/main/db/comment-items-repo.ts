import type { Db } from "./database";
import type { CommentCategory, CommentItemView, CommentKind, CommentSource, CommentState, CommentVerified, CommentWho } from "../../shared/loop";

/** pr_comment_items 的一行（工作流 I，设计补充第 2.2 节）。 */
export interface CommentItem extends CommentItemView {
  threadId: string | null;
  databaseId: number | null;
  commentedAt: number | null;
  seenSha: string | null;
  queuedAt: number | null;
  deliveredSha: string | null;
  unchanged: number;
  checkedSha: string | null;
  addressedSha: string | null;
  updatedAt: number;
}

export interface SeenComment {
  prId: number;
  key: string;
  kind: CommentKind;
  threadId: string | null;
  databaseId: number | null;
  author: string;
  who: CommentWho;
  path: string | null;
  line: number | null;
  body: string;
  url: string | null;
  commentedAt: number | null;
  seenSha: string | null;
}

export type CommentPatch = Partial<{
  category: CommentCategory | null; source: CommentSource | null; reason: string | null; state: CommentState;
  queuedAt: number | null; deliveredAt: number | null; deliveredSha: string | null; deliveredSession: string | null;
  unchanged: number; checkedSha: string | null; addressedAt: number | null; addressedSha: string | null; verified: CommentVerified | null;
  repliedAt: number | null; resolvedAt: number | null; replyError: string | null; threadId: string | null;
}>;

const COLUMNS: Record<keyof CommentPatch, string> = {
  category: "category", source: "source", reason: "reason", state: "state", queuedAt: "queued_at", deliveredAt: "delivered_at", deliveredSha: "delivered_sha",
  deliveredSession: "delivered_session", unchanged: "unchanged", checkedSha: "checked_sha", addressedAt: "addressed_at", addressedSha: "addressed_sha",
  verified: "verified", repliedAt: "replied_at", resolvedAt: "resolved_at", replyError: "reply_error", threadId: "thread_id",
};

/** 原文最多存这么长（只在本机库里，不进导出和度量）。 */
export const COMMENT_BODY_MAX = 20_000;

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toItem(r: Row): CommentItem {
  return {
    id: Number(r.id), prId: Number(r.pr_id), key: String(r.comment_key), kind: r.kind as CommentKind, threadId: s(r.thread_id), databaseId: n(r.database_id),
    author: String(r.author), who: r.who as CommentWho, path: s(r.path), line: n(r.line), body: String(r.body), url: s(r.url), commentedAt: n(r.commented_at),
    seenSha: s(r.seen_sha), firstSeen: Number(r.first_seen), category: (r.category as CommentCategory | null) ?? null, source: (r.source as CommentSource | null) ?? null,
    reason: s(r.reason), state: r.state as CommentState, queuedAt: n(r.queued_at), deliveredAt: n(r.delivered_at), deliveredSha: s(r.delivered_sha),
    deliveredSession: s(r.delivered_session), unchanged: Number(r.unchanged ?? 0), checkedSha: s(r.checked_sha), addressedAt: n(r.addressed_at),
    addressedSha: s(r.addressed_sha), verified: (r.verified as CommentVerified | null) ?? null, repliedAt: n(r.replied_at), resolvedAt: n(r.resolved_at),
    replyError: s(r.reply_error), updatedAt: Number(r.updated_at),
  };
}

/** 界面上用的字段（去掉内部的 sha、计数）。 */
export function commentView(i: CommentItem): CommentItemView {
  return {
    id: i.id, prId: i.prId, key: i.key, kind: i.kind, author: i.author, who: i.who, path: i.path, line: i.line, body: i.body, url: i.url, category: i.category,
    source: i.source, reason: i.reason, state: i.state, firstSeen: i.firstSeen, deliveredAt: i.deliveredAt, deliveredSession: i.deliveredSession,
    addressedAt: i.addressedAt, verified: i.verified, repliedAt: i.repliedAt, resolvedAt: i.resolvedAt, replyError: i.replyError,
  };
}

export class CommentItemsRepo {
  constructor(private readonly db: Db) {}

  /** 新看到的评论建一行（状态 pending）；已有的只更新正文、链接、thread id（作者可能改了评论）。返回这一行和是不是新建的。 */
  seen(c: SeenComment, now: number): { item: CommentItem; created: boolean } {
    const body = c.body.slice(0, COMMENT_BODY_MAX);
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO pr_comment_items (pr_id, comment_key, kind, thread_id, database_id, author, who, path, line, body, url, commented_at, seen_sha, first_seen, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(c.prId, c.key, c.kind, c.threadId, c.databaseId, c.author, c.who, c.path, c.line, body, c.url, c.commentedAt, c.seenSha, now, now);
    const created = Number(r.changes) > 0;
    if (!created) {
      this.db
        .prepare(`UPDATE pr_comment_items SET body = ?, url = COALESCE(?, url), thread_id = COALESCE(?, thread_id), updated_at = ? WHERE pr_id = ? AND comment_key = ? AND body <> ?`)
        .run(body, c.url, c.threadId, now, c.prId, c.key, body);
    }
    return { item: this.byKey(c.prId, c.key) as CommentItem, created };
  }

  get(id: number): CommentItem | null {
    const r = this.db.prepare(`SELECT * FROM pr_comment_items WHERE id = ?`).get(id) as Row | undefined;
    return r ? toItem(r) : null;
  }

  byKey(prId: number, key: string): CommentItem | null {
    const r = this.db.prepare(`SELECT * FROM pr_comment_items WHERE pr_id = ? AND comment_key = ?`).get(prId, key) as Row | undefined;
    return r ? toItem(r) : null;
  }

  byPr(prId: number): CommentItem[] {
    return (this.db.prepare(`SELECT * FROM pr_comment_items WHERE pr_id = ? ORDER BY first_seen, id`).all(prId) as Row[]).map(toItem);
  }

  withState(states: readonly CommentState[]): CommentItem[] {
    if (states.length === 0) return [];
    return (this.db.prepare(`SELECT * FROM pr_comment_items WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY first_seen, id`).all(...states) as Row[]).map(toItem);
  }

  update(id: number, patch: CommentPatch, now: number): void {
    const keys = Object.keys(patch) as (keyof CommentPatch)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${COLUMNS[k]} = ?`).join(", ");
    this.db.prepare(`UPDATE pr_comment_items SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (patch[k] ?? null) as string | number | null), now, id);
  }

  /** PR 关了、合并了：还没处理完的不再处理。 */
  closePr(prId: number, now: number): number {
    return Number(
      this.db.prepare(`UPDATE pr_comment_items SET state = 'closed', updated_at = ? WHERE pr_id = ? AND state IN ('pending', 'review', 'queued', 'delivered')`).run(now, prId).changes,
    );
  }

  /** 统计（效果页）：时间窗口内各种状态变化的数目。 */
  stats(since: number, until: number): { addressed: number; addressedCopilot: number; addressedHuman: number; delivered: number; replied: number; resolved: number; waiting: number } {
    const one = (sql: string, ...args: (number | string)[]): number => Number((this.db.prepare(sql).get(...args) as { c: number }).c);
    const range = `BETWEEN ? AND ?`;
    return {
      addressed: one(`SELECT COUNT(*) c FROM pr_comment_items WHERE addressed_at ${range}`, since, until),
      addressedCopilot: one(`SELECT COUNT(*) c FROM pr_comment_items WHERE addressed_at ${range} AND who = 'copilot'`, since, until),
      addressedHuman: one(`SELECT COUNT(*) c FROM pr_comment_items WHERE addressed_at ${range} AND who = 'human'`, since, until),
      delivered: one(`SELECT COUNT(*) c FROM pr_comment_items WHERE delivered_at ${range}`, since, until),
      replied: one(`SELECT COUNT(*) c FROM pr_comment_items WHERE replied_at ${range}`, since, until),
      resolved: one(`SELECT COUNT(*) c FROM pr_comment_items WHERE resolved_at ${range}`, since, until),
      waiting: one(`SELECT COUNT(*) c FROM pr_comment_items WHERE state = 'review'`),
    };
  }
}
