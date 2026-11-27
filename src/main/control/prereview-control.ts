// 总控的预审工具（BTL-271）：pre_review_status、pre_review_run、pre_review_queue，和 list_tickets / list_sessions 的 preReview 字段。
// epic 总控和 Shipherd 总控共用这一份；epic 总控只能看、只能动自己 epic 里的 ticket 和 PR。
import type { ControlResult, PreReviewControlOp } from "../../shared/control";
import type { PreReviewBadge, PreReviewQueueActResult, PreReviewQueueItem, PreReviewView } from "../../shared/prereview";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { PreReviewStatusService } from "../prereview/status";
import { M } from "../strings";

export interface PreReviewOps {
  status: Pick<PreReviewStatusService, "forTickets" | "forSessions" | "forPrs" | "history" | "queue" | "placeOf">;
  /** 一次预审的完整视图（违规、证据缺口）；找不到为 null。 */
  view(preReviewId: number): PreReviewView | null;
  /** ticket_prs 的 id 或 PR 链接（同一个链接可能挂在几个 ticket 上）。 */
  findPrs(ref: string): TicketPr[];
  /** ticket 的 PR（所有仓库）。 */
  prsOf(ticketKey: string): TicketPr[];
  /** 和 ticket 页的「重新预审」同一个入口（PreReviewService.manual）；没有 head 为 null。 */
  manual(pr: TicketPr): number | null;
  /** 还没有 PR 的代码：对着这一次预审的同一份代码再排一次（PreReviewService.rerun）。 */
  rerun(preReviewId: number): number | null;
  cancel(preReviewId: number): PreReviewQueueActResult;
  moveToFront(preReviewId: number): PreReviewQueueActResult;
  /** 一次预审属于哪个 ticket；没有这次预审为 undefined。 */
  ticketOf(preReviewId: number): string | null | undefined;
}

/** 谁在问：epic 总控（只看自己 epic 的 ticket）或 Shipherd 总控（不限）。canAct：能不能重跑、取消、插队（发请求的是这个作用域开着的总控自己）。 */
export interface PreReviewScope {
  /** 这个 ticket 归不归这个作用域。 */
  owns(ticketKey: string | null): boolean;
  /** 这个作用域认得的 ticket（找不到时列给总控看）；Shipherd 总控是所有的。 */
  known(ticketKey: string): boolean;
  canAct: boolean;
}

const ok = (value: unknown): ControlResult => ({ v: 1, ok: true, value });
const fail = (error: string): ControlResult => ({ v: 1, ok: false, error });
const iso = (t: number | null | undefined): string | null => (t ? new Date(t).toISOString() : null);

/** list_tickets、list_sessions、pre_review_* 里的一条预审状态（短的）。 */
export function preReviewField(b: PreReviewBadge) {
  return {
    state: b.state, id: b.id, repo: b.repoSlug, branch: b.branch, headSha: b.headSha ? b.headSha.slice(0, 12) : null, prId: b.prId, trigger: b.trigger,
    position: b.position, reason: b.reason, waiting: b.waiting, until: iso(b.until),
    enqueuedAt: iso(b.enqueuedAt), startedAt: iso(b.startedAt), finishedAt: iso(b.finishedAt), violations: b.violations, detail: b.detail,
    last: b.last ? { state: b.last.state, id: b.last.id, violations: b.last.violations, headSha: b.last.headSha.slice(0, 12), finishedAt: iso(b.last.finishedAt) } : null,
  };
}

/** 一个 ticket 的 preReview 字段：最要紧的那条；多个仓库、分支时 items 列出全部（一个都不丢）。 */
export function ticketPreReviewField(s: { overall: PreReviewBadge; items: PreReviewBadge[] }) {
  return { ...preReviewField(s.overall), ...(s.items.length > 1 && { items: s.items.map(preReviewField) }) };
}

/** 最近一次结论的要点：违规、没过的检查、证据缺口。 */
function verdictSummary(v: PreReviewView) {
  return {
    id: v.id, verdict: v.verdict, status: v.status, headSha: v.target.headSha.slice(0, 12), repo: v.target.repoSlug, branch: v.target.branch, summary: v.summary, detail: v.detail,
    finishedAt: iso(v.finishedAt),
    violations: v.violations.map((x) => ({ severity: x.severity, file: x.file, line: x.line, what: x.what, fix: x.fix || null })),
    failingChecks: (v.checks?.failing ?? []).map((c) => ({ check: c.checkKey, name: c.name, severity: c.severity, mode: c.mode, files: c.files.slice(0, 10), count: c.count })),
    failedReruns: (v.checks?.rerun ?? []).filter((r) => !r.ok && !r.skipped).map((r) => ({ category: r.category, command: r.command })),
    missingEvidence: v.missingEvidence.map((g) => g.detail),
  };
}

const queueItem = (x: PreReviewQueueItem) => ({ ...preReviewField(x), ticket: x.ticketKey, pr: x.prNumber, prUrl: x.prUrl });

/** 已经在排队、在跑的（同一份代码再排一次只会多花额度、或者跟在跑的那次撞上）。 */
const inFlight = (b: PreReviewBadge | undefined): b is PreReviewBadge & { id: number } =>
  b !== undefined && b.id !== null && (b.state === "running" || b.state === "queued" || b.state === "paused");

export function preReviewControl(o: PreReviewOps | undefined, scope: PreReviewScope, req: PreReviewControlOp): ControlResult {
  if (!o) return fail(M().ctlPreReviewUnavailable);
  const m = M();
  /** ticket 或 PR → 这次要看、要跑的对象；不归这个作用域的当作找不到（epic 总控看不到别人的）。 */
  const resolve = (r: { ticket?: string; pr?: string }): { ticket: string } | { pr: TicketPr } | { error: string } => {
    if (r.ticket !== undefined) {
      const key = r.ticket.trim().toUpperCase();
      if (!scope.known(key)) return { error: m.ctlPreReviewNoTicket(r.ticket) };
      if (!scope.owns(key)) return { error: m.ctlPreReviewNotInEpic(r.ticket) };
      return { ticket: key };
    }
    const all = o.findPrs(r.pr ?? "");
    if (all.length === 0) return { error: m.ctlNoSuchPr(r.pr ?? "") };
    const mine = all.find((p) => scope.owns(p.ticketKey));
    return mine ? { pr: mine } : { error: m.ctlPreReviewNotInEpic(r.pr ?? "") };
  };
  const latestOf = (b: PreReviewBadge | undefined): ReturnType<typeof verdictSummary> | null => {
    const id = b ? (b.state === "clean" || b.state === "violations" || b.state === "error" ? b.id : (b.last?.id ?? null)) : null;
    const v = id !== null ? o.view(id) : null;
    return v ? verdictSummary(v) : null;
  };
  const history = (by: { ticketKey: string } | { prId: number }) =>
    o.status.history(by).map((h) => ({ ...preReviewField(h), last: undefined }));
  const placed = (id: number) => {
    const p = o.status.placeOf(id);
    return { id, position: p?.position ?? null, ahead: p?.ahead ?? null, reason: p?.reason ?? null, waiting: p?.waiting ?? null };
  };

  switch (req.op) {
    case "pre_review_status": {
      const t = resolve(req);
      if ("error" in t) return fail(t.error);
      if ("ticket" in t) {
        const s = o.status.forTickets([t.ticket]).get(t.ticket);
        return ok({
          ticket: t.ticket, preReview: s ? ticketPreReviewField(s) : null,
          latest: latestOf(s?.overall), history: history({ ticketKey: t.ticket }),
        });
      }
      const b = o.status.forPrs([t.pr.id]).get(t.pr.id);
      return ok({
        ticket: t.pr.ticketKey, pr: { prId: t.pr.id, number: t.pr.number, url: t.pr.url, repo: t.pr.slug },
        preReview: b ? preReviewField(b) : null, latest: latestOf(b), history: history({ prId: t.pr.id }),
      });
    }
    case "pre_review_run": {
      if (!scope.canAct) return fail(m.ctlPreReviewNotCoordinator);
      const t = resolve(req);
      if ("error" in t) return fail(t.error);
      if ("pr" in t) {
        if (t.pr.state !== "open") return fail(m.ctlPreReviewPrClosed(t.pr.url));
        const cur = o.status.forPrs([t.pr.id]).get(t.pr.id);
        if (inFlight(cur) && cur.headSha === t.pr.headSha) return ok({ queued: [{ ...placed(cur.id), pr: t.pr.url, already: true }], note: m.ctlPreReviewAlreadyNote });
        const id = o.manual(t.pr);
        return id === null ? fail(m.ctlPreReviewNoHead(t.pr.url)) : ok({ queued: [{ ...placed(id), pr: t.pr.url }], note: m.ctlPreReviewQueuedNote });
      }
      // ticket：每个开着的 PR 各排一次；还没有 PR 的仓库、分支按最近一次预审的那份代码再排。
      // 有过 PR 的分支（合了、关了）不再重跑：那是旧代码。已经在排、在跑的同一份代码不再排第二次，照实报上来。
      const prs = o.prsOf(t.ticket);
      const open = prs.filter((p) => p.state === "open" && p.headSha && p.headBranch);
      const queued: object[] = [];
      const prBadges = o.status.forPrs(open.map((p) => p.id));
      for (const pr of open) {
        const cur = prBadges.get(pr.id);
        if (inFlight(cur) && cur.headSha === pr.headSha) {
          queued.push({ ...placed(cur.id), pr: pr.url, already: true });
          continue;
        }
        const id = o.manual(pr);
        if (id !== null) queued.push({ ...placed(id), pr: pr.url });
      }
      const covered = new Set(prs.filter((p) => p.headBranch).map((p) => `${p.slug}\0${p.headBranch}`));
      const s = o.status.forTickets([t.ticket]).get(t.ticket);
      for (const it of s?.items ?? []) {
        if (it.id === null || !it.repoSlug || !it.branch || covered.has(`${it.repoSlug}\0${it.branch}`)) continue;
        covered.add(`${it.repoSlug}\0${it.branch}`);
        if (inFlight(it)) {
          queued.push({ ...placed(it.id), repo: it.repoSlug, branch: it.branch, already: true });
          continue;
        }
        const id = o.rerun(it.id);
        if (id !== null) queued.push({ ...placed(id), repo: it.repoSlug, branch: it.branch });
      }
      return queued.length > 0 ? ok({ queued, note: m.ctlPreReviewQueuedNote }) : fail(m.ctlPreReviewNothing(t.ticket));
    }
    case "pre_review_queue": {
      const id = req.cancel ?? req.front;
      if (id !== undefined) {
        if (!scope.canAct) return fail(m.ctlPreReviewNotCoordinator);
        const key = o.ticketOf(id);
        if (key === undefined || !scope.owns(key)) return fail(m.ctlPreReviewNoSuch(id));
        const r = req.cancel !== undefined ? o.cancel(id) : o.moveToFront(id);
        if (!r.ok) return fail(m.ctlPreReviewActFailed(r.reason));
      }
      // epic 总控只看到自己 epic 的条目；position 还是整条队列里的第几，另给全队的条数（别的 epic 排在前面也看得出）。
      const q = o.status.queue();
      const mine = (x: PreReviewQueueItem) => scope.owns(x.ticketKey);
      return ok({
        ...(id !== undefined && { done: req.cancel !== undefined ? "cancelled" : "moved_to_front", id }),
        concurrency: q.concurrency, stopped: q.stopped ? { reason: q.stopped.reason, until: iso(q.stopped.until) } : null,
        total: { running: q.running.length, queued: q.queued.length },
        running: q.running.filter(mine).map(queueItem), queued: q.queued.filter(mine).map(queueItem),
      });
    }
  }
}
