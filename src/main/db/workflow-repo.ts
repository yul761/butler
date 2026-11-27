import type { Db } from "./database";
import { withTransaction } from "./database";
import { parseWorkflow, scopeKey, type ReviewBot, type Workflow, type WorkflowScope, type WorkflowStepId, isWorkflowStepId } from "../../shared/workflow";

/**
 * 工作流程的存储（BTL-273）：每层一份流程（workflow_layers）、每个 ticket 每一步完成的时间（workflow_progress）、
 * 向 bot 请求 review 的每一轮（workflow_bot_requests）、最后一次「下一步」提醒（workflow_notices）。
 */

export interface StoredLayer {
  scope: WorkflowScope;
  workflow: Workflow;
  updatedAt: number;
}

export interface StepDone {
  step: WorkflowStepId;
  doneAt: number;
  detail: string | null;
  source: string;
}

export type BotRequestStatus = "requesting" | "requested" | "asked_session" | "failed";

export interface BotRequest {
  id: number;
  ticketKey: string;
  prId: number;
  round: number;
  bot: ReviewBot;
  sha: string | null;
  status: BotRequestStatus;
  requestedAt: number;
  reviewedAt: number | null;
  /** 这一轮 bot 留了几条意见（review 正文不算空 + 行内评论）。null = 还没回来。 */
  reviewComments: number | null;
  error: string | null;
}

interface LayerRow {
  scope_kind: string;
  product_id: number | null;
  repo_slug: string | null;
  feature_id: number | null;
  ticket_key: string | null;
  workflow: string;
  updated_at: number;
}

interface BotRow {
  id: number;
  ticket_key: string;
  pr_id: number;
  round: number;
  bot: string;
  sha: string | null;
  status: string;
  requested_at: number;
  reviewed_at: number | null;
  review_comments: number | null;
  error: string | null;
}

const columns = (s: WorkflowScope): [number | null, string | null, number | null, string | null] => [
  s.kind === "product" ? s.productId : null,
  s.kind === "repo" ? s.slug.toLowerCase() : null,
  s.kind === "feature" ? s.featureId : null,
  s.kind === "ticket" ? s.ticketKey : null,
];

const WHERE = `scope_kind = ? AND COALESCE(product_id, 0) = ? AND COALESCE(repo_slug, '') = ? AND COALESCE(feature_id, 0) = ? AND COALESCE(ticket_key, '') = ?`;
const whereArgs = (s: WorkflowScope): (string | number)[] => {
  const [p, r, f, t] = columns(s);
  return [s.kind, p ?? 0, r ?? "", f ?? 0, t ?? ""];
};

function scopeOf(r: LayerRow): WorkflowScope | null {
  switch (r.scope_kind) {
    case "global":
      return { kind: "global" };
    case "product":
      return r.product_id === null ? null : { kind: "product", productId: Number(r.product_id) };
    case "repo":
      return r.repo_slug === null ? null : { kind: "repo", slug: String(r.repo_slug) };
    case "feature":
      return r.feature_id === null ? null : { kind: "feature", featureId: Number(r.feature_id) };
    case "ticket":
      return r.ticket_key === null ? null : { kind: "ticket", ticketKey: String(r.ticket_key) };
    default:
      return null;
  }
}

/** 库里的 JSON 也当不可信输入解析：解析不了的一层当作没设（不让坏数据拦住闸门）。 */
function readWorkflow(raw: string): Workflow | null {
  try {
    const r = parseWorkflow(JSON.parse(raw));
    return r.ok ? r.workflow : null;
  } catch {
    return null;
  }
}

const toBot = (r: BotRow): BotRequest => ({
  id: Number(r.id), ticketKey: String(r.ticket_key), prId: Number(r.pr_id), round: Number(r.round), bot: r.bot === "codex" ? "codex" : "copilot",
  sha: r.sha === null ? null : String(r.sha), status: r.status as BotRequestStatus, requestedAt: Number(r.requested_at),
  reviewedAt: r.reviewed_at === null ? null : Number(r.reviewed_at), reviewComments: r.review_comments === null ? null : Number(r.review_comments),
  error: r.error === null ? null : String(r.error),
});

export class WorkflowRepo {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- 分层

  layer(scope: WorkflowScope): StoredLayer | null {
    const r = this.db.prepare(`SELECT * FROM workflow_layers WHERE ${WHERE}`).get(...whereArgs(scope)) as LayerRow | undefined;
    if (!r) return null;
    const workflow = readWorkflow(r.workflow);
    return workflow ? { scope, workflow, updatedAt: Number(r.updated_at) } : null;
  }

  /** 设一层（workflow 已经校验过）；null 清掉这一层。返回有没有变化。 */
  setLayer(scope: WorkflowScope, workflow: Workflow | null, at: number): boolean {
    return withTransaction(this.db, () => {
      const ex = this.db.prepare(`SELECT id, workflow FROM workflow_layers WHERE ${WHERE}`).get(...whereArgs(scope)) as { id: number; workflow: string } | undefined;
      if (workflow === null) {
        if (!ex) return false;
        this.db.prepare(`DELETE FROM workflow_layers WHERE id = ?`).run(ex.id);
        return true;
      }
      const json = JSON.stringify(workflow);
      if (ex) {
        if (ex.workflow === json) return false;
        this.db.prepare(`UPDATE workflow_layers SET workflow = ?, updated_at = ? WHERE id = ?`).run(json, at, ex.id);
        return true;
      }
      this.db
        .prepare(`INSERT INTO workflow_layers (scope_kind, product_id, repo_slug, feature_id, ticket_key, workflow, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.kind, ...columns(scope), json, at);
      return true;
    });
  }

  /** 有没有设过任何一层（热路径用：只查一行，不解析）。读坏的行也算，之后 effective 照样当没有。 */
  hasLayers(): boolean {
    return this.db.prepare(`SELECT 1 FROM workflow_layers LIMIT 1`).get() !== undefined;
  }

  layers(): StoredLayer[] {
    const rows = this.db.prepare(`SELECT * FROM workflow_layers ORDER BY id`).all() as unknown as LayerRow[];
    const out: StoredLayer[] = [];
    for (const r of rows) {
      const scope = scopeOf(r);
      const workflow = readWorkflow(r.workflow);
      if (scope && workflow) out.push({ scope, workflow, updatedAt: Number(r.updated_at) });
    }
    return out.sort((a, b) => (scopeKey(a.scope) < scopeKey(b.scope) ? -1 : 1));
  }

  // ---------------------------------------------------------------- 进度

  done(ticketKey: string): StepDone[] {
    const rows = this.db.prepare(`SELECT step, done_at, detail, source FROM workflow_progress WHERE ticket_key = ? ORDER BY done_at, step`).all(ticketKey) as {
      step: string; done_at: number; detail: string | null; source: string;
    }[];
    return rows.filter((r) => isWorkflowStepId(r.step)).map((r) => ({ step: r.step as WorkflowStepId, doneAt: Number(r.done_at), detail: r.detail, source: String(r.source) }));
  }

  /** 记一步完成；已经记过不改（第一次完成的时间留着）。返回是不是新记的。 */
  markDone(ticketKey: string, step: WorkflowStepId, at: number, source: string, detail: string | null): boolean {
    const r = this.db
      .prepare(`INSERT INTO workflow_progress (ticket_key, step, done_at, detail, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT (ticket_key, step) DO NOTHING`)
      .run(ticketKey, step, at, detail, source);
    return Number(r.changes) > 0;
  }

  /** 撤掉一步（新 push 让预审失效、PR 又被关掉之类）。返回有没有删。 */
  unmark(ticketKey: string, step: WorkflowStepId): boolean {
    return Number(this.db.prepare(`DELETE FROM workflow_progress WHERE ticket_key = ? AND step = ?`).run(ticketKey, step).changes) > 0;
  }

  /** 有进度记录的 ticket（启动时重建派生状态用）。 */
  ticketsWithProgress(): string[] {
    return (this.db.prepare(`SELECT DISTINCT ticket_key FROM workflow_progress ORDER BY ticket_key`).all() as { ticket_key: string }[]).map((r) => String(r.ticket_key));
  }

  // ---------------------------------------------------------------- bot review

  botRequests(ticketKey: string): BotRequest[] {
    return (this.db.prepare(`SELECT * FROM workflow_bot_requests WHERE ticket_key = ? ORDER BY pr_id, round`).all(ticketKey) as unknown as BotRow[]).map(toBot);
  }

  /**
   * 先占一轮再去调 gh：同一个 (ticket, PR, round) 只有一个调用方占得到（UNIQUE），返回占到的行；已经有了返回 null。
   */
  claimBotRequest(ticketKey: string, prId: number, round: number, bot: ReviewBot, sha: string | null, at: number): BotRequest | null {
    const r = this.db
      .prepare(`INSERT INTO workflow_bot_requests (ticket_key, pr_id, round, bot, sha, status, requested_at) VALUES (?, ?, ?, ?, ?, 'requesting', ?) ON CONFLICT (ticket_key, pr_id, round) DO NOTHING`)
      .run(ticketKey, prId, round, bot, sha, at);
    if (Number(r.changes) === 0) return null;
    return toBot(this.db.prepare(`SELECT * FROM workflow_bot_requests WHERE id = ?`).get(Number(r.lastInsertRowid)) as unknown as BotRow);
  }

  /** gh 调完写回结果：在事务里重读，只改仍是 requesting 的那行（别的路径已经写过就不覆盖）。 */
  finishBotRequest(id: number, status: Exclude<BotRequestStatus, "requesting">, error: string | null, at: number): boolean {
    return withTransaction(this.db, () => {
      const cur = this.db.prepare(`SELECT status FROM workflow_bot_requests WHERE id = ?`).get(id) as { status: string } | undefined;
      if (!cur || cur.status !== "requesting") return false;
      this.db.prepare(`UPDATE workflow_bot_requests SET status = ?, error = ?, requested_at = ? WHERE id = ?`).run(status, error, at, id);
      return true;
    });
  }

  /** bot 的 review 回来了：只填还空着的。 */
  markBotReviewed(id: number, at: number, comments: number): boolean {
    return Number(this.db.prepare(`UPDATE workflow_bot_requests SET reviewed_at = ?, review_comments = ? WHERE id = ? AND reviewed_at IS NULL`).run(at, comments, id).changes) > 0;
  }

  /** 已经定了的一轮，后来又看到更多行内评论（晚到的）：条数只往上改。 */
  raiseBotComments(id: number, comments: number): boolean {
    return Number(this.db.prepare(`UPDATE workflow_bot_requests SET review_comments = ? WHERE id = ? AND reviewed_at IS NOT NULL AND review_comments < ?`).run(comments, id, comments).changes) > 0;
  }

  /** 启动时：上次退出时还在 requesting 的行（gh 调到一半）删掉，返回删了几行。 */
  dropInterruptedBotRequests(): number {
    return Number(this.db.prepare(`DELETE FROM workflow_bot_requests WHERE status = 'requesting'`).run().changes);
  }

  /** 失败的一轮删掉，下次可以重新请（重试按钮、session 说已经请过）。 */
  dropBotRequest(id: number): void {
    this.db.prepare(`DELETE FROM workflow_bot_requests WHERE id = ?`).run(id);
  }

  // ---------------------------------------------------------------- 提醒

  notice(ticketKey: string): { notice: string; sentAt: number } | null {
    const r = this.db.prepare(`SELECT notice, sent_at FROM workflow_notices WHERE ticket_key = ?`).get(ticketKey) as { notice: string; sent_at: number } | undefined;
    return r ? { notice: String(r.notice), sentAt: Number(r.sent_at) } : null;
  }

  setNotice(ticketKey: string, notice: string | null, at: number): void {
    if (notice === null) this.db.prepare(`DELETE FROM workflow_notices WHERE ticket_key = ?`).run(ticketKey);
    else this.db.prepare(`INSERT INTO workflow_notices (ticket_key, notice, sent_at) VALUES (?, ?, ?) ON CONFLICT (ticket_key) DO UPDATE SET notice = excluded.notice, sent_at = excluded.sent_at`).run(ticketKey, notice, at);
  }
}
