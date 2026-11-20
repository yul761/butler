// 「谁该动」的取数（UI 重做第 1 层，计划 Task 9）：把各处已有的状态拼成 BoardInput 交给 buildTurnBoard，
// 再加上首页「发给 agent」一键递送。这里只做数据转换，判断规则全在 shared/turn.ts 和 turn-board.ts。
import { isWorking, type SessionActivity } from "../../shared/activity";
import type { ReportKind } from "../../shared/control";
import type { InterruptCategory } from "../../shared/metrics";
import {
  noticeNeedsYou, prTurn, sessionTurn,
  type CiSendSkip, type TimedTurn, type Turn, type TurnBoard, type TurnFilter, type TurnSendReason,
} from "../../shared/turn";
import type { CiItemRef, CiUndelivered, EpicView, FeatureView, NowNotice, NowTarget, Session, SessionView, TicketView, WatchedPr } from "../../shared/types";
import type { InboxItem } from "../db/inbox-repo";
import type { ReviewRequestRow } from "../db/review-requests-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { CommentLoop } from "../loop/comment-loop";
import { deliveryKey, type Recipient } from "../prwatch/ci-delivery";
import { scopeReviews, type ReviewRequestScope } from "../prwatch/review-requests";
import { buildTurnBoard, type BoardInput, type BoardPr, type BoardTicket, type LooseItem } from "./turn-board";

export type { TurnSendReason } from "../../shared/turn";

export interface TurnServiceDeps {
  /** sessionService.ticketViews()：单独的 ticket。feature 下的从 features() 里取。 */
  tickets(): TicketView[];
  features(): FeatureView[];
  epics(): EpicView[];
  /** 休眠着的 head（ticket 的 session 列表里可能没有）。 */
  hibernatedHeads(): Session[];
  /** feature / epic 总控和 Butler 总控的 head，各带页面 target。 */
  coordinators(): { session: Session; featureId: number | null; epicId: number | null; target: NowTarget; title: string | null }[];
  head(id: string): Session | null;
  /** prWatcher.statusOf */
  prs(ticketKey: string): WatchedPr[];
  /** ticketPrs.get */
  prRow(prId: number): TicketPr | null;
  /** loopRecipient */
  recipient(ticketKey: string, repoId: number, branch: string): Recipient;
  activity(id: string): SessionActivity | null;
  /** activityMonitor.lastReplyOf(id)?.at ?? null */
  lastReplyAt(id: string): number | null;
  needsYou(): { reasons: Map<string, string>; categories: Map<string, InterruptCategory> };
  /** inboxRepo.pendingDecisions() */
  decisions(): InboxItem[];
  lastReport(ticketKey: string): { kind: ReportKind; text: string; at: number; sessionId: string | null } | null;
  /** refresher.stepOf(id) !== null */
  refreshing(id: string): boolean;
  /** gateRepo.waitingSessionIds() 换成 head 后 */
  mergeQueued(id: string): boolean;
  /** AssessRepo.risk，headSha 对得上才算 */
  risk(prId: number, headSha: string | null): "low" | "medium" | "high" | null;
  ciUndelivered(): CiUndelivered[];
  comments: Pick<CommentLoop, "deliveredAt" | "sendable" | "sendAll">;
  /** 现有的 ciResend：ciDelivery.resend + ciStuckChanged */
  ciResend(item: CiItemRef): Promise<"sent" | CiSendSkip>;
  /** 和 nowView 同一份提醒（不含 session_limited）。 */
  notices(): NowNotice[];
  reviews(): ReviewRequestRow[];
  reviewScope(): ReviewRequestScope;
  /** lessonsRepo.repos() 的 slug ∪ ticket_prs 里出现过的 slug */
  registeredSlugs(): string[];
  /** 不带 filter 的 board（首页）被取时调，做 R9 的补查。 */
  /** 切到首页时（turn:home-opened）：补查一次请你 review 的 PR。 */
  homeOpened(): void;
  /** 这个 PR 是 Butler 管的栈里、下面还有没合的层时，最近那层的分支（StackService.stackBelow）。 */
  stackBelow(prUrl: string, branch: string | null): string | null;
  /** 推 turn:changed。 */
  emit(): void;
  now(): number;
}

export const TURN_CHANGED_DEBOUNCE_MS = 200;

/** 本地今天 0 点。 */
export function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 和「现在」页一样：开着终端、休眠着或唤醒失败的 Butler session 才算（彻底关掉的不算有人在推进，也不算要你接着说）。 */
const live = (s: Session & { termId?: string | null }): boolean =>
  (!!s.termId || !!s.hibernatedAt || !!s.wakeError) && s.origin === "butler" && s.replacedBy === null;


/** 一次 board / sendToAgent 里取齐的快照：needsYou、decisions、notices、ciUndelivered 只调一次接口。 */
interface Snap {
  now: number;
  reasons: Map<string, string>;
  categories: Map<string, InterruptCategory>;
  undeliveredPrs: Set<number>;
}

/** 一个 ticket 的 head session：t.sessions 里活着的，加上休眠着、列表里没有的。 */
function ticketHeads(t: TicketView, hibernated: Session[]): (Session | SessionView)[] {
  const out: (Session | SessionView)[] = t.sessions.filter(live);
  const seen = new Set(out.map((s) => s.id));
  for (const h of hibernated) {
    if (h.ticketKey !== t.key || seen.has(h.id) || !live(h)) continue;
    out.push(h);
    seen.add(h.id);
  }
  return out;
}

export class TurnService {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: TurnServiceDeps) {}

  /** 只算看板，不触发任何查询：第 2 层每次收到 turn:changed 都会重取。 */
  board(filter: TurnFilter | null): TurnBoard {
    return buildTurnBoard(this.input(), filter);
  }

  /**
   * 每个没关闭的 PR 的 turn，按 PR 链接查（不分大小写）；查不到为 null。
   * 同一个 PR 挂在几个 ticket 上时 turn 跟 ticket 走（推的人按 ticket 找）：给了 ticketKey 就查那个 ticket 的，
   * 没给或那个 ticket 不认识这个 PR 时落回第一个 ticket 的。
   * 总控的 list_prs、progress_overview 和 feature 汇总都用它，和看板是同一套算法，不再有第二套「卡在谁手上」。
   */
  prTurns(): (url: string, ticketKey?: string) => Turn | null {
    const byUrl = new Map<string, Turn>();
    const byTicket = new Map<string, Turn>();
    for (const t of this.input().tickets) {
      for (const p of t.prs) {
        const u = p.url.toLowerCase();
        if (!byUrl.has(u)) byUrl.set(u, p.turn);
        byTicket.set(`${t.key}\n${u}`, p.turn);
      }
    }
    return (url, ticketKey) => {
      const u = url.toLowerCase();
      return (ticketKey !== undefined ? byTicket.get(`${ticketKey}\n${u}`) : undefined) ?? byUrl.get(u) ?? null;
    };
  }

  /** 切到首页（turn:home-opened）：补查请你 review 的 PR（离开时、一分钟内查过时由 poller 跳过）。 */
  homeOpened(): void {
    this.d.homeOpened();
  }

  /** 首页「发给 agent」：重新算这个 PR 的 turn，只有 you/unattended 且 canSend 时才走现有的递送路径。 */
  async sendToAgent(item: { ticketKey: string; pr: { repo: string; number: number } }): Promise<{ ok: boolean; reason?: TurnSendReason }> {
    const t = this.allTickets().find((x) => x.key === item.ticketKey);
    if (!t) return { ok: false, reason: "not_found" };
    const snap = this.snap();
    const heads = ticketHeads(t, this.d.hibernatedHeads()).map((s) => s.id);
    const repo = item.pr.repo.toLowerCase();
    let found: { prId: number; turn: Turn } | null = null;
    for (const w of this.d.prs(t.key)) {
      if (w.prId === null) continue;
      const r = this.d.prRow(w.prId);
      if (!r || r.slug.toLowerCase() !== repo || r.number !== item.pr.number) continue;
      const p = this.prInput(t.key, w, r, heads, snap);
      found = { prId: w.prId, turn: p?.turn ?? { owner: "idle", kind: "not_started" } };
      break;
    }
    if (!found) return { ok: false, reason: "not_found" };
    const turn = found.turn;
    if (turn.owner !== "you" || turn.kind !== "unattended" || !turn.canSend) return { ok: false, reason: "not_sendable" };
    try {
      if (turn.why === "ci_failing" || turn.why === "ci_undelivered") {
        const r = await this.d.ciResend({ kind: "pr", id: found.prId });
        return r === "sent" ? { ok: true } : { ok: false, reason: r };
      }
      if (turn.why === "changes_requested") {
        return (await this.d.comments.sendAll(found.prId)) > 0 ? { ok: true } : { ok: false, reason: "no_comments" };
      }
      return { ok: false, reason: "not_sendable" };
    } finally {
      this.changed();
    }
  }

  /** 防抖 TURN_CHANGED_DEBOUNCE_MS 后 emit。 */
  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.d.emit();
    }, TURN_CHANGED_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------- 拼 BoardInput ----------

  private snap(): Snap {
    const ny = this.d.needsYou();
    const undeliveredPrs = new Set<number>();
    for (const c of this.d.ciUndelivered()) if (c.item.kind === "pr") undeliveredPrs.add(c.item.id);
    return { now: this.d.now(), reasons: ny.reasons, categories: ny.categories, undeliveredPrs };
  }

  /** 单独的 ticket 加 feature 下的 ticket，去重、去掉归档的。 */
  private allTickets(): TicketView[] {
    const out = new Map<string, TicketView>();
    for (const t of [...this.d.tickets(), ...this.d.features().flatMap((f) => f.tickets)]) {
      if (t.archivedAt === null && !out.has(t.key)) out.set(t.key, t);
    }
    return [...out.values()];
  }

  private headId(id: string): string {
    return this.d.head(id)?.id ?? id;
  }

  /** 一个 PR 的 BoardPr（R1、R2、R7）。关掉的、没有 PR 行的为 null。 */
  private prInput(ticketKey: string, w: WatchedPr, row: TicketPr, heads: string[], s: Snap): BoardPr | null {
    if (w.prId === null || w.state === null || w.state === "closed") return null;
    const det = w.detail;
    let pusher: { sessionId: string; working: boolean; stoppedAt: number | null } | null = null;
    if (w.repoId !== null) {
      const rec = this.d.recipient(ticketKey, w.repoId, w.branch || row.headBranch || "");
      if (rec.ok) {
        const id = this.headId(rec.sessionId);
        const head = this.d.head(id);
        // 休眠了、唤醒失败的 pusher 不在干任何事；休眠后最后一次回话的记录被删了，不能当成「递了还没停」。
        pusher = head?.hibernatedAt || head?.wakeError
          ? { sessionId: id, working: false, stoppedAt: s.now }
          : { sessionId: id, working: isWorking(this.d.activity(id)), stoppedAt: this.d.lastReplyAt(id) };
      }
    }
    // R2：当前 head 的 CI 结论递给了 pusher（旧行 delivered_to 为 null 时不比）
    const ciDeliveredAt =
      pusher && row.deliveredAt !== null && row.deliveredKey === deliveryKey(row) && (row.deliveredTo === null || this.headId(row.deliveredTo) === pusher.sessionId)
        ? row.deliveredAt
        : null;
    const turn = prTurn({
      state: w.state,
      isDraft: det?.isDraft ?? row.isDraft,
      ci: w.ci,
      review: w.review,
      reviewers: det?.reviewers ?? row.reviewers,
      reviewRequests: det?.reviewRequests ?? row.reviewRequests,
      mergeable: det?.mergeable ?? row.mergeable,
      mergeState: det?.mergeState ?? row.mergeState,
      mergeQueued: [...heads, ...(pusher ? [pusher.sessionId] : [])].some((id) => this.d.mergeQueued(id)),
      risk: this.d.risk(w.prId, w.headSha),
      pusher,
      ciDeliveredAt,
      commentsDeliveredAt: pusher ? this.d.comments.deliveredAt(w.prId, pusher.sessionId) : null,
      ciUndelivered: s.undeliveredPrs.has(w.prId),
      // 这次结论已经递过（标记相同）时 ciResend 只会回 delivered：没有能再发的东西。
      canResendCi: w.ci === "failing" && pusher !== null && row.deliveredKey !== deliveryKey(row),
      canSendComments: pusher !== null && this.d.comments.sendable(w.prId),
      stackBelow: this.d.stackBelow(w.url ?? row.url, w.branch || row.headBranch || null),
    });
    if (turn === null) return null;
    const since = turn.owner === "done" ? (row.mergedAt ?? w.checkedAt) : (det?.statusChangedAt ?? row.statusChangedAt ?? row.openedAt ?? w.checkedAt);
    return {
      repo: row.slug, number: row.number, title: det?.title ?? row.title ?? `#${row.number}`, url: w.url ?? row.url,
      turn, since, mergedAt: row.mergedAt,
    };
  }

  private sessionInput(
    s: Session, target: NowTarget, title: string | null, ask: InboxItem | null, report: { kind: ReportKind; text: string; at: number } | null, snap: Snap,
  ): TimedTurn {
    const reason = snap.reasons.get(s.id);
    return sessionTurn({
      sessionId: s.id, target, title,
      activity: this.d.activity(s.id),
      ask: ask ? { id: ask.id, question: ask.text, options: ask.options, at: ask.createdAt } : null,
      needsYou: reason === undefined ? null : { reason, category: snap.categories.get(s.id) ?? "question" },
      lastReport: report,
      refreshing: this.d.refreshing(s.id),
      stoppedAt: this.d.lastReplyAt(s.id),
      now: snap.now,
    });
  }

  private input(): BoardInput {
    const snap = this.snap();
    const now = snap.now;
    const hibernated = this.d.hibernatedHeads();
    const features = this.d.features().filter((f) => f.archivedAt === null);
    const featureIds = new Set(features.map((f) => f.id));
    const tickets = this.allTickets();
    const loose: LooseItem[] = [];

    // R6：ask_user 按提问 session 的 head 分组（pendingDecisions 已经按时间排好）
    const asks = new Map<string, InboxItem[]>();
    for (const a of this.d.decisions()) {
      const h = this.headId(a.sessionId);
      asks.set(h, [...(asks.get(h) ?? []), a]);
    }
    const askTurn = (a: InboxItem, sessionId: string): TimedTurn => ({
      turn: { owner: "you", kind: "answer", question: a.text, options: a.options, askId: a.id, sessionId }, since: a.createdAt,
    });

    // 各 ticket 的 head；认得的 head 才把第一条 ask 当 sessionTurn 的输入
    const headsOf = new Map(tickets.map((t) => [t.key, ticketHeads(t, hibernated)]));
    const coords = this.d.coordinators();
    const known = new Set<string>([...[...headsOf.values()].flat().map((s) => s.id), ...coords.map((c) => c.session.id)]);
    const board = new Map<string, BoardTicket>();
    for (const t of tickets) {
      board.set(t.key, { key: t.key, name: t.title ?? t.key, featureId: t.featureId !== null && featureIds.has(t.featureId) ? t.featureId : null, prs: [], others: [], moreAsks: [] });
    }
    const orphanAsk = (a: InboxItem, sessionId: string) => {
      const bt = a.ticketKey !== null ? board.get(a.ticketKey) : undefined;
      if (bt) bt.moreAsks.push(askTurn(a, sessionId));
      else loose.push({ ...askTurn(a, sessionId), featureId: a.featureId, epicId: a.epicId });
    };
    for (const [h, list] of asks) if (!known.has(h)) for (const a of list) orphanAsk(a, h);

    // R5：要你动手的提醒挂到 ticket 上，或者进 loose。评论等着的提醒等 PR 算完再挂（见下）。
    const placeNotice = (n: NowNotice, tt: TimedTurn, key: string | null, target: NowTarget | null) => {
      const bt = key !== null ? board.get(key) : undefined;
      if (bt) bt.others.push(tt);
      else loose.push({ ...tt, featureId: target?.page === "feature" ? target.id : null, epicId: target?.page === "epic" ? target.id : null });
    };
    const prNotices: { n: NowNotice; tt: TimedTurn; key: string | null; target: NowTarget | null }[] = [];
    for (const n of this.d.notices()) {
      if (!noticeNeedsYou(n) || n.kind === "session_limited") continue;
      const since = n.kind === "ci_undelivered" ? n.ci.since : n.kind === "comments_waiting" ? n.waiting.since : now;
      const tt: TimedTurn = { turn: { owner: "you", kind: "butler", notice: n }, since };
      const target = "target" in n ? n.target : null;
      const key = n.kind === "ci_undelivered" ? n.ci.ticketKey
        : n.kind === "comments_waiting" ? n.waiting.ticketKey
        : n.kind === "stack" ? (n.stack.ticketKey ?? null)
        : target?.page === "ticket" ? target.key : null;
      if (n.kind === "comments_waiting" || (n.kind === "ci_undelivered" && n.ci.item.kind === "pr")) prNotices.push({ n, tt, key, target });
      else placeNotice(n, tt, key, target);
    }

    // PR 行能接住的提醒等 PR 算完再挂（按 prId 认，多仓库里 PR 号会重）：
    // 「要求修改、没人在改」且能一键发的 PR，吞掉它的评论等着；CI 失败的 PR，行上已经显示没递出去，吞掉它的 ci_undelivered
    //（CI 通过的结论也会递，递不出去时 PR 行不显示，提醒要留着）。
    const sendableReview = new Set<number>();
    const failingCi = new Set<number>();
    for (const t of tickets) {
      const bt = board.get(t.key)!;
      const heads = headsOf.get(t.key) ?? [];
      const headIds = heads.map((s) => s.id);
      for (const w of this.d.prs(t.key)) {
        const row = w.prId !== null ? this.d.prRow(w.prId) : null;
        const p = row ? this.prInput(t.key, w, row, headIds, snap) : null;
        if (!p || w.prId === null) continue;
        bt.prs.push(p);
        if (p.turn.owner === "you" && p.turn.kind === "unattended" && p.turn.why === "changes_requested" && p.turn.canSend) sendableReview.add(w.prId);
        if (w.ci === "failing") failingCi.add(w.prId);
      }
      const report = heads.length > 0 ? this.d.lastReport(t.key) : null;
      // 最近一条 report 只算在交它的那条链上：多仓库 ticket 里别的 session 不跟着「报告做不下去」。
      const reportHead = report && report.sessionId !== null ? this.headId(report.sessionId) : null;
      for (const s of heads) {
        const [first, ...rest] = asks.get(s.id) ?? [];
        const own = report !== null && (reportHead === null ? heads.length === 1 : reportHead === s.id) ? report : null;
        bt.others.push(this.sessionInput(s, { page: "ticket", key: t.key, sessionId: s.id }, t.title, first ?? null, own, snap));
        for (const a of rest) bt.moreAsks.push(askTurn(a, s.id));
      }
      // R4：ticket 级的
      if (t.effectiveStatus === "blocked") {
        const first = heads[0];
        bt.others.push({ turn: { owner: "you", kind: "stuck", source: "ticket_blocked", detail: null, sessionId: first?.id ?? null }, since: (first && this.d.lastReplyAt(first.id)) ?? now });
      }
      if (bt.prs.length === 0 && (t.effectiveStatus === "done" || t.effectiveStatus === "merged_pending_followup")) {
        bt.others.push({ turn: { owner: "done", kind: "merged" }, since: now });
      }
    }

    for (const { n, tt, key, target } of prNotices) {
      if (n.kind === "comments_waiting" && sendableReview.has(n.waiting.prId)) continue;
      if (n.kind === "ci_undelivered" && n.ci.item.kind === "pr" && failingCi.has(n.ci.item.id)) continue;
      placeNotice(n, tt, key, target);
    }

    // R6：总控 session 要你的才进 loose
    for (const c of coords) {
      const [first, ...rest] = asks.get(c.session.id) ?? [];
      const tt = this.sessionInput(c.session, c.target, c.title, first ?? null, null, snap);
      // 总控停在提示符等输入是常态，不算要你动手：只有问你、卡住和 Butler 提醒进 loose。
      if (tt.turn.owner === "you" && tt.turn.kind !== "unattended") loose.push({ ...tt, featureId: c.featureId, epicId: c.epicId });
      for (const a of rest) loose.push({ ...askTurn(a, c.session.id), featureId: c.featureId, epicId: c.epicId });
    }

    const registered = new Set(this.d.registeredSlugs().map((x) => x.toLowerCase()));
    const reviews = scopeReviews(this.d.reviews(), this.d.reviewScope(), registered).map((r) => ({
      repo: r.slug, number: r.number, title: r.title, url: r.url, author: r.author, since: r.firstSeenAt,
    }));

    return {
      epics: this.d.epics().filter((e) => e.archivedAt === null).map((e) => ({ id: e.id, name: e.name })),
      features: features.map((f) => ({ id: f.id, name: f.name, epicId: f.epicId })),
      tickets: [...board.values()],
      loose,
      reviews,
      dayStart: localDayStart(now),
      now,
    };
  }
}
