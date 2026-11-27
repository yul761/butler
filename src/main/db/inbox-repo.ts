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
  text: string;
  options: string[];
  context: string | null;
  reportKind: ReportKind | null;
  status: InboxStatus;
  answer: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** 新的一条：提问 / 汇报的 session 和它所属的 ticket、feature。 */
export interface InboxOwner {
  sessionId: string;
  ticketKey: string | null;
  featureId: number | null;
}

interface Row {
  id: number;
  kind: "decision" | "report";
  session_id: string;
  ticket_key: string | null;
  feature_id: number | null;
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
  featureId: r.feature_id === null ? null : Number(r.feature_id),
  text: r.text, options: r.options ? (JSON.parse(r.options) as string[]) : [], context: r.context, reportKind: r.report_kind,
  status: r.status, answer: r.answer, createdAt: Number(r.created_at), resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
});

/** 收件箱看哪一块：一个 feature（含它下面的 ticket），或者全部。 */
export type InboxFilter = { featureId: number } | null;

/** 归档的是哪一块：一个 ticket 或一个 feature（含下面 ticket 的条目）。 */
export type InboxArchiveScope = { ticketKey: string } | { featureId: number };

function where(f: InboxFilter): { sql: string; args: number[] } {
  if (f === null) return { sql: "", args: [] };
  return { sql: " AND feature_id = ?", args: [f.featureId] };
}

/** 「待你决定」和汇报。 */
export class InboxRepo {
  constructor(private readonly db: Db) {}

  addDecision(o: InboxOwner & { question: string; options: string[]; context: string | null; createdAt: number }): number {
    const r = this.db
      .prepare(
        `INSERT INTO inbox_items (kind, session_id, ticket_key, feature_id, text, options, context, status, created_at)
         VALUES ('decision', ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(o.sessionId, o.ticketKey, o.featureId, o.question, o.options.length > 0 ? JSON.stringify(o.options) : null, o.context, o.createdAt);
    return Number(r.lastInsertRowid);
  }

  /** status：pending 还要送给总控；dismissed 不用送（这时 resolvedAt 就是 createdAt）。 */
  addReport(o: InboxOwner & { text: string; kind: Exclude<ReportKind, "choice">; status: "pending" | "dismissed"; createdAt: number }): number {
    const r = this.db
      .prepare(
        `INSERT INTO inbox_items (kind, session_id, ticket_key, feature_id, text, report_kind, status, created_at, resolved_at)
         VALUES ('report', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.sessionId, o.ticketKey, o.featureId, o.text, o.kind, o.status, o.createdAt, o.status === "pending" ? null : o.createdAt);
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

  /** 这个 ticket 的 report，从早到晚；repoId、branch 是发 report 的 session 的仓库和 git 分支（总控、查不到 session 的为 null）。 */
  reportsForTicket(ticketKey: string): { at: number; text: string; repoId: number | null; branch: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT i.created_at AS at, i.text AS text, s.repo_id AS repo_id, s.git_branch AS branch
         FROM inbox_items i LEFT JOIN sessions s ON s.id = i.session_id
         WHERE i.kind = 'report' AND i.ticket_key = ?
         ORDER BY i.created_at, i.id`,
      )
      .all(ticketKey) as unknown as { at: number; text: string; repo_id: number | null; branch: string | null }[];
    return rows.map((r) => ({ at: Number(r.at), text: r.text, repoId: r.repo_id === null ? null : Number(r.repo_id), branch: r.branch }));
  }

  /** 这个 ticket 最近的一条 report；没有为 null（UI 重做第 1 层：停在 blocked 汇报上算「卡住了」）。 */
  lastReport(ticketKey: string): { kind: ReportKind; text: string; at: number; sessionId: string } | null {
    const r = this.db
      .prepare(`SELECT * FROM inbox_items WHERE kind = 'report' AND ticket_key = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(ticketKey) as unknown as Row | undefined;
    if (!r) return null;
    const i = toItem(r);
    return i.reportKind === null ? null : { kind: i.reportKind, text: i.text, at: i.createdAt, sessionId: i.sessionId };
  }

  /** 还要送给总控的汇报，从早到晚。 */
  pendingReports(): InboxItem[] {
    return (this.db.prepare(`SELECT * FROM inbox_items WHERE kind = 'report' AND status = 'pending' ORDER BY created_at, id`).all() as unknown as Row[]).map(toItem);
  }

  /**
   * 最近的汇报，从新到旧（created_at, id），最多 limit 条。before 是上一页最早一条汇报的 id（总控对话区往前翻页，UI 重做第 5 层）：
   * 只要排在它后面的，同一时间的按 id 接着排，翻页不漏。不认识的 id、不是汇报、不在这个范围里的都当没给（和 conv:list 一样）。
   */
  recentReports(filter: InboxFilter, limit: number, before?: number): InboxItem[] {
    const w = where(filter);
    const c =
      before === undefined
        ? undefined
        : (this.db.prepare(`SELECT created_at AS at, id FROM inbox_items WHERE id = ? AND kind = 'report'${w.sql}`).get(before, ...w.args) as
            | { at: number; id: number }
            | undefined);
    const b = c ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
    return (
      this.db
        .prepare(`SELECT * FROM inbox_items WHERE kind = 'report'${w.sql}${b} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...w.args, ...(c ? [c.at, c.at, c.id] : []), limit) as unknown as Row[]
    ).map(toItem);
  }

  /** 用户答了、还没送进终端：status 不变，只记下答案。只改还未决的。 */
  setAnswer(id: number, answer: string): boolean {
    return Number(this.db.prepare(`UPDATE inbox_items SET answer = ? WHERE id = ? AND status = 'pending'`).run(answer, id).changes) > 0;
  }

  /**
   * 结束一条（answered / dismissed / superseded）。只改还未决的；返回改没改。
   * 给了 answer（送进去的那份回答）时，只有答案还是它才结束：投递途中用户在卡片上改了答案，新答案留着下次送。
   */
  resolve(id: number, status: Exclude<InboxStatus, "pending">, at: number, answer?: string): boolean {
    if (answer !== undefined) {
      return Number(this.db.prepare(`UPDATE inbox_items SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending' AND answer = ?`).run(status, at, id, answer).changes) > 0;
    }
    return Number(this.db.prepare(`UPDATE inbox_items SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`).run(status, at, id).changes) > 0;
  }

  /** 别人替用户答了（总控代答，BTL-269 A）：还未决、卡片上也没答过的这一条记成 answered，答案写 label。返回改没改。 */
  answerOnBehalf(id: number, label: string, at: number): boolean {
    return Number(this.db.prepare(`UPDATE inbox_items SET status = 'answered', answer = ?, resolved_at = ? WHERE id = ? AND status = 'pending' AND answer IS NULL`).run(label, at, id).changes) > 0;
  }

  /** ticket、feature 归档时：这个范围里还未决的「待你决定」和汇报都记成 dismissed。返回结束了几条。 */
  dismissPending(scope: InboxArchiveScope, at: number): number {
    const w = "ticketKey" in scope ? { sql: "ticket_key = ?", arg: scope.ticketKey as string | number } : { sql: "feature_id = ?", arg: scope.featureId };
    return Number(this.db.prepare(`UPDATE inbox_items SET status = 'dismissed', resolved_at = ? WHERE status = 'pending' AND ${w.sql}`).run(at, w.arg).changes);
  }
}
