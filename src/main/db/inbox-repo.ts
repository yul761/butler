import type { ReportKind } from "../../shared/control";
import type { InboxStatus } from "../../shared/types";
import type { Db } from "./database";

/** inbox_items 的一行（BTL-190 第 2+3 点）：kind = decision 是 ask_user 的问题，report 是 report 的汇报。 */
export interface InboxItem {
  id: number;
  kind: "decision" | "report";
  /** 提问 / 汇报时的 session id（换新以后沿着 replaced_by 找到现在的 head）。 */
  sessionId: string;
  ticketKey: string | null;
  featureId: number | null;
  epicId: number | null;
  text: string;
  options: string[];
  context: string | null;
  reportKind: ReportKind | null;
  status: InboxStatus;
  answer: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** 新的一条：提问 / 汇报的 session 和它所属的 ticket、feature、epic。 */
export interface InboxOwner {
  sessionId: string;
  ticketKey: string | null;
  featureId: number | null;
  epicId: number | null;
}

interface Row {
  id: number;
  kind: "decision" | "report";
  session_id: string;
  ticket_key: string | null;
  feature_id: number | null;
  epic_id: number | null;
  text: string;
  options: string | null;
  context: string | null;
  report_kind: ReportKind | null;
  status: InboxStatus;
  answer: string | null;
  created_at: number;
  resolved_at: number | null;
}

const toItem = (r: Row): InboxItem => ({
  id: Number(r.id), kind: r.kind, sessionId: r.session_id, ticketKey: r.ticket_key,
  featureId: r.feature_id === null ? null : Number(r.feature_id), epicId: r.epic_id === null ? null : Number(r.epic_id),
  text: r.text, options: r.options ? (JSON.parse(r.options) as string[]) : [], context: r.context, reportKind: r.report_kind,
  status: r.status, answer: r.answer, createdAt: Number(r.created_at), resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
});

/** 收件箱看哪一块：一个 feature、一个 epic（含它下面的 feature 和 ticket），或者全部。 */
export type InboxFilter = { featureId: number } | { epicId: number } | null;

function where(f: InboxFilter): { sql: string; args: number[] } {
  if (f === null) return { sql: "", args: [] };
  if ("featureId" in f) return { sql: " AND feature_id = ?", args: [f.featureId] };
  return { sql: " AND epic_id = ?", args: [f.epicId] };
}

/** 「待你决定」和汇报。 */
export class InboxRepo {
  constructor(private readonly db: Db) {}

  addDecision(o: InboxOwner & { question: string; options: string[]; context: string | null; createdAt: number }): number {
    const r = this.db
      .prepare(
        `INSERT INTO inbox_items (kind, session_id, ticket_key, feature_id, epic_id, text, options, context, status, created_at)
         VALUES ('decision', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(o.sessionId, o.ticketKey, o.featureId, o.epicId, o.question, o.options.length > 0 ? JSON.stringify(o.options) : null, o.context, o.createdAt);
    return Number(r.lastInsertRowid);
  }

  /** status：pending 还要送给总控；dismissed 不用送（这时 resolvedAt 就是 createdAt）。 */
  addReport(o: InboxOwner & { text: string; kind: ReportKind; status: "pending" | "dismissed"; createdAt: number }): number {
    const r = this.db
      .prepare(
        `INSERT INTO inbox_items (kind, session_id, ticket_key, feature_id, epic_id, text, report_kind, status, created_at, resolved_at)
         VALUES ('report', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.sessionId, o.ticketKey, o.featureId, o.epicId, o.text, o.kind, o.status, o.createdAt, o.status === "pending" ? null : o.createdAt);
    return Number(r.lastInsertRowid);
  }

  get(id: number): InboxItem | null {
    const r = this.db.prepare(`SELECT * FROM inbox_items WHERE id = ?`).get(id) as unknown as Row | undefined;
    return r ? toItem(r) : null;
  }

  /** 未决的「待你决定」，从早到晚。 */
  pendingDecisions(filter: InboxFilter = null): InboxItem[] {
    const w = where(filter);
    return (
      this.db
        .prepare(`SELECT * FROM inbox_items WHERE kind = 'decision' AND status = 'pending'${w.sql} ORDER BY created_at, id`)
        .all(...w.args) as unknown as Row[]
    ).map(toItem);
  }

  /** 还要送给总控的汇报，从早到晚。 */
  pendingReports(): InboxItem[] {
    return (this.db.prepare(`SELECT * FROM inbox_items WHERE kind = 'report' AND status = 'pending' ORDER BY created_at, id`).all() as unknown as Row[]).map(toItem);
  }

  /** 最近的汇报，从新到旧，最多 limit 条。 */
  recentReports(filter: InboxFilter, limit: number): InboxItem[] {
    const w = where(filter);
    return (
      this.db
        .prepare(`SELECT * FROM inbox_items WHERE kind = 'report'${w.sql} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...w.args, limit) as unknown as Row[]
    ).map(toItem);
  }

  /** 用户答了、还没送进终端：status 不变，只记下答案。只改还未决的。 */
  setAnswer(id: number, answer: string): boolean {
    return Number(this.db.prepare(`UPDATE inbox_items SET answer = ? WHERE id = ? AND status = 'pending'`).run(answer, id).changes) > 0;
  }

  /** 结束一条（answered / dismissed / superseded）。只改还未决的；返回改没改。 */
  resolve(id: number, status: Exclude<InboxStatus, "pending">, at: number): boolean {
    return Number(this.db.prepare(`UPDATE inbox_items SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`).run(status, at, id).changes) > 0;
  }
}
