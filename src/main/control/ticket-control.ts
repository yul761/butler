import type { ControlResult, TicketStatusControlOp } from "../../shared/control";
import { prUrlKey } from "../../shared/pr-url";
import { effectiveStatus, type Followup, type ManualTicketStatus, type Ticket, type TicketCloseSource } from "../../shared/types";
import type { FollowupsRepo } from "../db/followups-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { M } from "../strings";
import type { CloseOptions, CloseResult, ReopenResult, SetStatusResult } from "../tickets/ticket-close";

const ok = (value: unknown): ControlResult => ({ v: 1, ok: true, value });
const fail = (error: string): ControlResult => ({ v: 1, ok: false, error });

/** 哪一级总控：epic 总控只管这个 epic 的 ticket，Shipherd 总控管所有没归档的。 */
export type TicketControlScope = { kind: "feature"; featureId: number } | { kind: "shipherd" };

export interface TicketControlDeps {
  tickets: Pick<TicketsRepo, "get" | "listByFeature">;
  followups: Pick<FollowupsRepo, "get" | "listByTicket" | "listOpen" | "resolve">;
  /** closeTicket / reopenTicket（tickets/ticket-close.ts），依赖在 index.ts 里接好。 */
  close(key: string, o: CloseOptions): Promise<CloseResult>;
  reopen(key: string, source: TicketCloseSource): ReopenResult;
  /** setTicketStatus（tickets/ticket-close.ts）：closed 以外的手动状态，null 回到自动；关着的先撤销关闭。 */
  setStatus(key: string, status: Exclude<ManualTicketStatus, "closed"> | null, source: TicketCloseSource): SetStatusResult;
  /** 后续事项变了以后重算自动状态（rederiveTicketStatus）。 */
  rederive(key: string): void;
  notify(): void;
  now(): number;
  log?: (msg: string) => void;
}

export interface TicketControlCall {
  /** 发请求的 session（/clear 之前的 id 也行）：close_ticket 结束 session 时不结束它自己。 */
  from: string | null;
  /** from 是不是这一级开着的总控：改东西的请求只认它。 */
  canWrite: boolean;
}

const followupRow = (f: Followup) => ({
  id: f.id, kind: f.kind, description: f.description, trigger: f.trigger, status: f.status, dueDate: f.dueDate, snoozedUntil: f.snoozedUntil,
  createdAt: f.createdAt, ...(f.resolvedReason && { resolvedReason: f.resolvedReason, resolvedBy: f.resolvedSource }),
});

const unfinished = (f: Followup) => f.status === "open" || f.status === "snoozed";

/**
 * 总控的 close_ticket、reopen_ticket、set_ticket_status、list_followups、resolve_followup（BTL-270）。两级总控共用：
 * 作用域决定能看到哪些 ticket；改东西的要 canWrite（调用方核对 from 是这一级开着的总控）。
 */
export class TicketControl {
  constructor(private readonly d: TicketControlDeps) {}

  private scoped(scope: TicketControlScope): Ticket[] | null {
    return scope.kind === "feature" ? this.d.tickets.listByFeature(scope.featureId) : null;
  }

  private ticket(scope: TicketControlScope, ref: string): Ticket | null {
    const key = ref.trim().toUpperCase();
    const own = this.scoped(scope);
    if (own) return own.find((t) => t.key === key) ?? null;
    const t = this.d.tickets.get(key);
    return t && t.archivedAt === null ? t : null;
  }

  private inScope(scope: TicketControlScope, key: string): boolean {
    return this.ticket(scope, key) !== null;
  }

  private status(key: string): string | null {
    const t = this.d.tickets.get(key);
    return t ? effectiveStatus(t) : null;
  }

  async handle(scope: TicketControlScope, req: TicketStatusControlOp, call: TicketControlCall): Promise<ControlResult> {
    if (req.op === "list_followups") return this.list(scope, req);
    if (!call.canWrite) return fail(M().ctlTicketWriteNotYours);
    if (req.op === "resolve_followup") {
      const f = this.d.followups.get(req.followup.trim());
      if (!f || !this.inScope(scope, f.ticketKey)) return fail(M().ctlNoSuchFollowup(req.followup));
      this.d.followups.resolve(f.id, req.status, this.d.now(), req.reason.replace(/\s+/g, " ").trim(), "coordinator");
      this.d.rederive(f.ticketKey);
      this.d.notify();
      this.d.log?.(`resolve_followup ${f.id} of ${f.ticketKey} -> ${req.status} by ${call.from ?? "?"}`);
      return ok({ followup: f.id, ticket: f.ticketKey, status: req.status, ticketStatus: this.status(f.ticketKey) });
    }
    const t = this.ticket(scope, req.ticket);
    if (!t) return fail(M().ctlNoTicket(req.ticket));
    if (req.op === "close_ticket" || (req.op === "set_ticket_status" && req.status === "closed")) {
      const reason = req.reason ?? "";
      const o: CloseOptions = {
        reason, source: "coordinator", except: call.from,
        ...(req.op === "close_ticket" && {
          closePrs: req.close_prs === true, endSessions: req.end_sessions === true, ...(req.pr_urls !== undefined && { prUrls: req.pr_urls }),
        }),
      };
      const r = await this.d.close(t.key, o);
      // 要关 PR 却没点名（BTL-270 审查）：什么都没做，回能关的清单，让它带 pr_urls 再来。
      if (!r.ok && r.error === "pick_prs") {
        return ok({
          ticket: r.ticket, status: this.status(r.ticket), closed: false, closablePrs: r.closable, prErrors: r.prErrors,
          note: M().ctlClosePickPrs(r.closable.length, r.prErrors.length),
        });
      }
      // 原因由 parseControlRequest 保证不空：失败是已经关着（第一次的原因留着），或者 ticket 刚被删掉。
      if (!r.ok) return fail(r.error === "already_closed" ? M().ctlTicketAlreadyClosed(t.key) : M().ctlNoTicket(req.ticket));
      // 点名了、却不是这个 ticket 开着的 PR（关掉了的、别的 ticket 的、写错了的）：没碰，单独列出来。
      const seen = new Set([...r.closedPrs, ...r.prErrors.map((e) => e.url)].map(prUrlKey));
      const notOpen = r.reopenedMeanwhile ? [] : (req.op === "close_ticket" ? req.pr_urls ?? [] : []).filter((u) => !seen.has(prUrlKey(u)));
      const notes = [
        notOpen.length > 0 && M().ctlCloseNotOpenPrs(notOpen.length),
        r.reopenedMeanwhile && M().ctlCloseReopenedMeanwhile,
        r.prErrors.length > 0 && M().ctlClosePrErrors(r.prErrors),
        r.sessionErrors.length > 0 && M().ctlCloseSessionErrors(r.sessionErrors.length),
      ].filter((x): x is string => typeof x === "string");
      return ok({
        ticket: r.ticket, status: r.reopenedMeanwhile ? this.status(r.ticket) : "closed", ignoredFollowups: r.ignoredFollowups,
        closedPrs: r.closedPrs, prErrors: r.prErrors, endedSessions: r.endedSessions, sessionErrors: r.sessionErrors,
        ...(notOpen.length > 0 && { notOpenPrs: notOpen }),
        ...(notes.length > 0 && { note: notes.join(" ") }),
      });
    }
    if (req.op === "reopen_ticket") {
      const r = this.d.reopen(t.key, "coordinator");
      if (!r.ok) return fail(r.error === "not_closed" ? M().ctlTicketNotClosed(t.key) : M().ctlNoTicket(req.ticket));
      return ok({ ticket: r.ticket, restoredFollowups: r.restoredFollowups, status: r.status, note: M().ctlReopenNote });
    }
    // set_ticket_status 的其余状态（和界面的下拉框同一个函数）：关着的先撤销关闭，auto 回到自动。
    const r = this.d.setStatus(t.key, req.status === "auto" || req.status === "closed" ? null : req.status, "coordinator");
    if (!r.ok) return fail(M().ctlNoTicket(req.ticket));
    this.d.log?.(`set_ticket_status ${t.key} -> ${req.status} by ${call.from ?? "?"}`);
    return ok({ ticket: t.key, status: r.status, manual: req.status !== "auto", ...(r.reopened && { reopened: true }) });
  }

  /** 一个 ticket 的后续事项（all：连处理过的），或者作用域里所有 ticket 没处理完的，按 ticket 分组。 */
  private list(scope: TicketControlScope, req: Extract<TicketStatusControlOp, { op: "list_followups" }>): ControlResult {
    if (req.ticket !== undefined) {
      const t = this.ticket(scope, req.ticket);
      if (!t) return fail(M().ctlNoTicket(req.ticket));
      const fs = this.d.followups.listByTicket(t.key).filter((f) => req.all === true || unfinished(f));
      return ok([{ ticket: t.key, title: t.title, status: effectiveStatus(t), followups: fs.map(followupRow) }]);
    }
    // 全部 ticket 连处理过的一起列太多了：all 只配 ticket 用，不悄悄忽略。
    if (req.all === true) return fail(M().ctlFollowupsAllNeedsTicket);
    const own = this.scoped(scope);
    const known = new Map<string, Ticket | null>(own?.map((t) => [t.key, t]));
    const ticketOf = (key: string): Ticket | null => {
      if (own || known.has(key)) return known.get(key) ?? null;
      const t = this.d.tickets.get(key);
      known.set(key, t && t.archivedAt === null ? t : null);
      return known.get(key) ?? null;
    };
    const groups = new Map<string, { t: Ticket; fs: Followup[] }>();
    for (const f of this.d.followups.listOpen()) {
      const t = ticketOf(f.ticketKey);
      if (!t) continue;
      const g = groups.get(t.key) ?? { t, fs: [] };
      g.fs.push(f);
      groups.set(t.key, g);
    }
    return ok([...groups.values()].map(({ t, fs }) => ({ ticket: t.key, title: t.title, status: effectiveStatus(t), followups: fs.map(followupRow) })));
  }
}
