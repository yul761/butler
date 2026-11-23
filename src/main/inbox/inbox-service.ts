import type { ReportKind } from "../../shared/control";
import type { InboxItemView, InboxRole, InboxScope, InboxView, NowTarget, Session, Ticket } from "../../shared/types";
import type { InboxArchiveScope, InboxFilter, InboxItem, InboxOwner, InboxRepo } from "../db/inbox-repo";
import type { ChoiceService } from "../interrupts/choices";
import type { RecordEvent } from "../metrics/events";
import { MAILBOX_BODY_LIMIT, type Mailbox } from "../mailbox/mailbox";
import { M } from "../strings";

/** feature 页上最多显示这么多条最近的汇报。 */
export const RECENT_REPORTS_LIMIT = 30;
/** 汇报这么久还找不到总控（一个总控 session 都没有）就不送了：过时的「做完了」只会误导总控。排进了信箱的不受这个限制。 */
export const REPORT_DELIVERY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/**
 * Shipherd 往一个 session 里直接输入信箱消息、送到（deliver 返回 sent）以后这么久之内，这个 session 的下一次 UserPromptSubmit
 * 算是这次输入引起的（只认一次）：deliver 没等到 hook 就返回时（hook 不通、等满了），迟到的那一次不能把它别的未决条目当成用户在终端里答了。
 */
export const ANSWERING_TTL_MS = 30_000;

export interface InboxServiceDeps {
  repo: InboxRepo;
  /** 链上最新的 session（换新过的话是新的那个）；没有为 null。 */
  head(sessionId: string): Session | null;
  /** Shipherd 正在给这个 session（链上任何一个 id）换新：/handoff 和接着做的话引起的 UserPromptSubmit 不是用户在回答。 */
  refreshing(sessionId: string): boolean;
  ticket(key: string): Ticket | null;
  /** 跑着这个 session（链上任何一个 id）的终端；没有为 null。 */
  termOf(sessionId: string): string | null;
  /** 开着终端的 Shipherd session 的 head。 */
  openHeads(): Session[];
  /** 信箱（BTL-245）：回答和汇报都排进去，送达后在 on("answer") / on("report") 里结束条目。 */
  mailbox: Pick<Mailbox, "send" | "on" | "queuedByRef" | "withdraw" | "queuedRefs">;
  /** 终端关着时汇报送给谁：这个 epic（内部是 feature）最近的那个总控（没隐藏的 head）。没有为 null。不给时只送给开着的总控。 */
  latestCoordinator?(where: { feature: number }): string | null;
  notify(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
  /** 度量（ws-h）：卡片上回答记一条 needs_you_answer。 */
  recordEvent?: RecordEvent;
  /** 度量（ws-h）：记下一条「待你决定」之后调（打断原因的分类）。按默认答案自动答了的不调（不算打断，也不通知）。 */
  onAsked?(q: AskedQuestion): void;
  /** 默认答案答掉的问题顶掉了旧条目（ws-j）：不算打断，但旧条目的等待要结束。 */
  onSuperseded?(ids: number[]): void;
  /** 选择（ws-j）：report kind choice 存进「替你做的选择」；ask_user 先看有没有匹配的默认答案。 */
  choices?: Pick<ChoiceService, "recordRule" | "match" | "recordDefault">;
}

/** 刚记下的一条 ask_user。 */
export interface AskedQuestion {
  id: number;
  sessionId: string;
  ticketKey: string | null;
  question: string;
  options: string[];
  context: string | null;
  /** 被这条顶掉的、同一个问题的旧条目（又问了一遍，不算新的打断）。 */
  supersedes: number[];
}

/** 提问 / 汇报的是哪种 session。 */
export function roleOf(s: Pick<Session, "ticketKey" | "coordinator" | "featureId" | "fixesSession">): InboxRole {
  if (s.ticketKey !== null) return "ticket";
  if (s.featureId !== null) return s.fixesSession !== null ? "fix" : "feature_coordinator";
  // Shipherd 总控（BTL-190 第 5 点）：ticket、feature 都是空的。以前的 epic session（BTL-246 去掉了）留下的条目也归到这里。
  return "shipherd";
}

/**
 * 上面可能有管它的总控（汇报才有地方送）：ticket session、修复 session 要属于 feature；feature 总控和 Shipherd 总控上面都没有。
 */
function mayHaveCoordinator(role: InboxRole, o: Pick<InboxOwner, "featureId">): boolean {
  return (role === "ticket" || role === "fix") && o.featureId !== null;
}

const repoName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * 「待你决定」和汇报（BTL-190 第 2+3 点）。
 * - ask_user 记一条 pending 的 decision；用户在卡片上答了以后先记下答案（status 还是 pending），等提问的 session 停下来再送进去，送到才算 answered。
 * - 用户直接在终端里回答（提问的 session 收到 UserPromptSubmit）：它还没答的条目都算 answered（卡片上答好、还没送的留着，下次照常送）。
 *   Shipherd 自己递回答、换新时输入的 /handoff 和接着做的话引起的那次不算。
 * - report 存下；done / blocked 等管它的总控停下来时送进去（progress 只存不送；上面不可能有总控的也只存）。
 */
export class InboxService {
  /** Shipherd 刚往里直接输入过信箱消息的 session（head id）→ 到什么时候为止：这次输入引起的 UserPromptSubmit 不结束别的条目（见 ANSWERING_TTL_MS）。 */
  private readonly answering = new Map<string, number>();

  constructor(private readonly d: InboxServiceDeps) {
    // 回答送到了：结束这一条，记下送出去的那份答案（投递途中用户又改了，新答案会替换还在排队的那条）。
    d.mailbox.on("answer", (m) => {
      const id = Number(m.ref?.slice("answer:".length));
      const answer = (m.meta as { answer?: unknown } | null)?.answer;
      if (this.d.repo.resolve(id, "answered", this.d.now(), typeof answer === "string" ? answer : undefined)) this.d.notify();
    });
    // 汇报送到了总控。
    d.mailbox.on("report", (m) => {
      if (this.d.repo.resolve(Number(m.ref?.slice("report:".length)), "answered", this.d.now())) this.d.notify();
    });
  }

  /**
   * 信箱往这个 session 里直接输入（Mailbox 的 typing）：输入的途中（不限时）和送到以后 ANSWERING_TTL_MS 之内，
   * 这个 session 的下一次 UserPromptSubmit 算这次输入引起的。没送到就不留。
   */
  shipherdTyping(headId: string, phase: "start" | "sent" | "failed"): void {
    const head = this.headId(headId);
    if (phase === "start") this.answering.set(head, Infinity);
    // 送到了、UserPromptSubmit 还没来（deliver 没等到 hook 就返回）：再等它一会儿。来过了（已经删掉）就不留。
    else if (phase === "sent" && this.answering.has(head)) this.answering.set(head, this.d.now() + ANSWERING_TTL_MS);
    else this.answering.delete(head);
  }

  /** 这个 session 拥有的 ticket、feature：ticket 的 session 从 ticket 往上找。 */
  private owner(s: Session): InboxOwner {
    if (s.ticketKey !== null) return { sessionId: s.id, ticketKey: s.ticketKey, featureId: this.d.ticket(s.ticketKey)?.featureId ?? null };
    return { sessionId: s.id, ticketKey: null, featureId: s.featureId };
  }

  private headId(sessionId: string): string {
    return this.d.head(sessionId)?.id ?? sessionId;
  }

  /** ask_user：记一条「待你决定」。同一个 session 还没决的同一个问题被这条顶掉（superseded）。s 是提问的 session 的 head。 */
  ask(s: Session, q: { question: string; options?: string[]; context?: string; recommended?: number }): number {
    const now = this.d.now();
    const supersedes: number[] = [];
    for (const old of this.d.repo.pendingDecisions()) {
      if (old.text === q.question && this.headId(old.sessionId) === s.id && this.d.repo.resolve(old.id, "superseded", now)) supersedes.push(old.id);
    }
    const id = this.d.repo.addDecision({ ...this.owner(s), question: q.question, options: q.options ?? [], context: q.context ?? null, createdAt: now });
    // 默认答案（ws-j）：匹配上就马上记下答案、等 session 停下来送进去；不算打断、不通知，记进「替你做的选择」。
    const auto = this.d.choices?.match({ question: q.question, options: q.options ?? [], recommended: q.recommended }) ?? null;
    if (auto && this.d.repo.setAnswer(id, M().interrupts.autoAnswered(auto.answer))) {
      this.d.choices?.recordDefault({ sessionId: s.id, ticketKey: s.ticketKey }, id, auto.defaultId, q.question, auto.answer);
      this.d.notify();
      this.queueAnswer(id);
      if (supersedes.length > 0) this.d.onSuperseded?.(supersedes);
      this.withdrawSettled();
      return id;
    }
    this.d.notify();
    if (supersedes.length > 0) this.withdrawSettled();
    this.d.onAsked?.({ id, sessionId: s.id, ticketKey: s.ticketKey, question: q.question, options: q.options ?? [], context: q.context ?? null, supersedes });
    return id;
  }

  /**
   * report：存下来。queued：会送给总控（done / blocked，而且这个 session 上面可能有总控）。
   * noCoordinator：done / blocked，但上面不可能有总控（没有 feature 的 ticket、feature 总控、Shipherd 总控自己），只存。
   */
  report(s: Session, text: string, kind: ReportKind): { id: number; queued: boolean; noCoordinator: boolean } {
    // choice（ws-j）：不进汇报、不送总控，存进「替你做的选择」。没接选择服务时当 progress 存。
    if (kind === "choice" && this.d.choices) return { id: this.d.choices.recordRule({ sessionId: s.id, ticketKey: s.ticketKey }, text), queued: false, noCoordinator: false };
    if (kind === "choice") kind = "progress";
    const owner = this.owner(s);
    const noCoordinator = kind !== "progress" && !mayHaveCoordinator(roleOf(s), owner);
    const queued = kind !== "progress" && !noCoordinator;
    const id = this.d.repo.addReport({ ...owner, text, kind, status: queued ? "pending" : "dismissed", createdAt: this.d.now() });
    this.d.notify();
    if (queued) this.queueReport(id);
    return { id, queued, noCoordinator };
  }

  /** ticket、feature 归档了：这个范围里还未决的「待你决定」和汇报都记成 dismissed（不再显示、不再送）。 */
  dismissScope(scope: InboxArchiveScope): void {
    if (this.d.repo.dismissPending(scope, this.d.now()) > 0) this.d.notify();
    this.withdrawSettled();
  }

  /** 已经不用送的（被顶掉的提问、归档时 dismissed 的、在终端里答过的）：还在信箱里排队的撤回。 */
  private withdrawSettled(): void {
    for (const prefix of ["answer", "report"]) {
      for (const ref of this.d.mailbox.queuedRefs(prefix)) {
        const item = this.d.repo.get(Number(ref.slice(prefix.length + 1)));
        if (!item || item.status !== "pending") this.d.mailbox.withdraw(ref);
      }
    }
  }

  /** 用户在卡片上回答（选项或者打的字）：记下答案，能送就马上送。条目已经不是未决的返回 false。 */
  answer(id: number, text: string): boolean {
    const answer = text.trim();
    const item = this.d.repo.get(id);
    if (!answer || !item || item.kind !== "decision" || !this.d.repo.setAnswer(id, answer)) return false;
    this.recordAnswer(item, "card");
    this.d.notify();
    this.queueAnswer(id);
    return true;
  }

  /** 人介入（ws-h）：卡片上回答（提问只能回答，没有「不用了」）。同一条只记一次（改答案不算又一次）。 */
  private recordAnswer(item: InboxItem, via: "card"): void {
    this.d.recordEvent?.("needs_you_answer", {
      sessionId: this.headId(item.sessionId), ticketKey: item.ticketKey, dedupeKey: `answer:${item.id}`,
      data: { via, options: item.options.length },
    });
  }

  /**
   * 这个 session 收到 UserPromptSubmit：用户在终端里回答了，它还没答的条目都算 answered。卡片上答好、还没送进去的不动：
   * 下次停下来照常送（不然答案永远送不进去）。
   * Shipherd 刚往里直接输入过信箱消息（只认一次，最多 ANSWERING_TTL_MS），或者正在换新（/handoff、接着做的话）时不算：
   * 信箱送到的回答自己结束那几条。
   */
  promptSubmitted(sessionId: string): void {
    const head = this.headId(sessionId);
    const until = this.answering.get(head);
    if (until !== undefined) {
      this.answering.delete(head);
      if (this.d.now() <= until) return;
    }
    if (this.d.refreshing(head)) return;
    const now = this.d.now();
    let changed = false;
    for (const item of this.d.repo.pendingDecisions()) {
      if (item.answer === null && this.headId(item.sessionId) === head && this.d.repo.resolve(item.id, "answered", now)) changed = true;
    }
    if (changed) this.d.notify();
  }

  /** 这个 session（链上任何一个 id）有未决的 ask_user：不自动输入（除了回答本身）、不闲置关闭、不自动换新。 */
  hasPendingDecision(sessionId: string): boolean {
    const head = this.headId(sessionId);
    return this.d.repo.pendingDecisions().some((item) => this.headId(item.sessionId) === head);
  }

  /** 还没回答的 ask_user 条目 id，按 session（head）分好，旧的在前（度量的等人时间用；一次 sync 查一次库）。 */
  unansweredAsksByHead(): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const item of this.d.repo.pendingDecisions()) {
      if (item.answer !== null) continue;
      const head = this.headId(item.sessionId);
      const list = out.get(head);
      if (list) list.push(item.id);
      else out.set(head, [item.id]);
    }
    for (const list of out.values()) list.sort((a, b) => a - b);
    return out;
  }

  /**
   * 补排：已经答了、还没排进信箱的回答，还没找到总控的汇报（那时一个总控都没有）。太旧的、找不到作者的汇报不再送。
   * 每个 tick 调。永不 reject。
   */
  async flush(): Promise<void> {
    try {
      this.withdrawSettled();
      for (const x of this.d.repo.pendingDecisions()) if (x.answer !== null && !this.d.mailbox.queuedByRef(`answer:${x.id}`)) this.queueAnswer(x.id);
      const now = this.d.now();
      for (const item of this.d.repo.pendingReports()) {
        if (this.d.mailbox.queuedByRef(`report:${item.id}`)) continue;
        if (!this.queueReport(item.id) && now - item.createdAt > REPORT_DELIVERY_MAX_AGE_MS) this.d.repo.resolve(item.id, "dismissed", now);
      }
    } catch (e) {
      this.d.log("inbox: flush failed", e);
    }
    return Promise.resolve();
  }

  /** 这一条的回答排进提问的 session 的信箱（同一条改了答案就替换还在排队的那份）。 */
  private queueAnswer(id: number): void {
    const x = this.d.repo.get(id);
    if (!x || x.kind !== "decision" || x.answer === null) return;
    const m = M();
    let body = m.inboxAnswer(x.text, x.answer);
    // 太长：截掉回答，注明截掉了（不然送进去的会在半路断掉）。
    if (body.length > MAILBOX_BODY_LIMIT) {
      const keep = Math.max(0, MAILBOX_BODY_LIMIT - m.inboxAnswer(x.text, "").length - m.inboxAnswerCut.length);
      body = m.inboxAnswer(x.text, Array.from(x.answer).slice(0, keep).join("") + m.inboxAnswerCut);
    }
    try {
      this.d.mailbox.send({ kind: "answer", from: null, to: this.headId(x.sessionId), featureId: x.featureId, body, ref: `answer:${id}`, meta: { answer: x.answer } });
    } catch (e) {
      this.d.log(`inbox: queueing answer ${id} failed`, e);
    }
  }

  /** 这条汇报排进管它的总控的信箱；找不到总控返回 false（留着，下一个 tick 再找）。 */
  private queueReport(id: number): boolean {
    const item = this.d.repo.get(id);
    const author = item ? this.d.head(item.sessionId) : null;
    if (!item || !author) return false;
    const target = this.reportTarget(item, author);
    if (target === null) return false;
    const m = M();
    try {
      this.d.mailbox.send({
        kind: "report", from: author.id, to: target, featureId: item.featureId, ref: `report:${id}`,
        body: m.inboxReportLine(this.whoOf(author), m.inboxReportKinds[item.reportKind ?? "progress"], item.text),
      });
      return true;
    } catch (e) {
      this.d.log(`inbox: queueing report ${id} failed`, e);
      return false;
    }
  }

  /**
   * 汇报送给谁（head id）：管这个 session 的 epic 总控（内部是 feature 总控），开着的优先，其次是最近的那个（关着的读信箱要等打开）。
   * ticket 的 session、修复 session → epic 总控；epic 总控和全局总控上面都没有。
   */
  private reportTarget(item: InboxItem, author: Session): string | null {
    if (!mayHaveCoordinator(roleOf(author), item) || item.featureId === null) return null;
    const f = item.featureId;
    const ok = (h: Session) => h.id !== author.id && h.ticketKey === null && h.featureId === f && h.fixesSession === null;
    const open = this.d.openHeads().find(ok)?.id ?? null;
    if (open !== null) return open;
    const id = this.d.latestCoordinator?.({ feature: f }) ?? null;
    return id === null || this.headId(id) === author.id ? null : this.headId(id);
  }

  /** 给总控看的「谁」：ticket 号（ticket 有几个仓库时加仓库名）、总控、修复 session。 */
  private whoOf(s: Session): string {
    const role = roleOf(s);
    return M().inboxWho(role, s.ticketKey, role === "ticket" ? this.repoOf(s) : null);
  }

  /** ticket 有不止一个仓库时，这个 session 的仓库目录名。 */
  private repoOf(s: Session): string | null {
    if (s.ticketKey === null || s.repoId === null) return null;
    const t = this.d.ticket(s.ticketKey);
    if (!t || t.repos.length < 2) return null;
    const r = t.repos.find((x) => x.id === s.repoId);
    return r ? repoName(r.repoPath) : null;
  }

  /** 界面上的一条：跳到哪里、终端开没开、谁问的。 */
  itemView(item: InboxItem): InboxItemView {
    const s = this.d.head(item.sessionId);
    const sessionId = s?.id ?? item.sessionId;
    const role: InboxRole = s ? roleOf(s) : item.ticketKey !== null ? "ticket" : item.featureId !== null ? "feature_coordinator" : "shipherd";
    // 以前的 epic session（BTL-246 去掉了）留下的条目没有 ticket、feature：跳到 Shipherd 页。
    const target: NowTarget =
      item.ticketKey !== null ? { page: "ticket", key: item.ticketKey, sessionId }
      : s?.featureId != null || (s === null && item.featureId !== null) ? { page: "feature", id: (s?.featureId ?? item.featureId) as number, sessionId }
      : { page: "shipherd", sessionId };
    return {
      id: item.id, kind: item.kind, sessionId, role, ticketKey: item.ticketKey, featureId: item.featureId,
      repo: s && role === "ticket" ? this.repoOf(s) : null,
      text: item.text, options: item.options, context: item.context, reportKind: item.reportKind,
      answer: item.status === "pending" ? item.answer : null, createdAt: item.createdAt,
      open: this.d.termOf(sessionId) !== null, target,
    };
  }

  /** 全部未决的「待你决定」，从早到晚（「现在」页）。 */
  pendingDecisionViews(): InboxItemView[] {
    return this.d.repo.pendingDecisions().map((x) => this.itemView(x));
  }

  /** feature 页（Shipherd 总控页用 all）上面的两栏。 */
  view(scope: InboxScope): InboxView {
    const filter: InboxFilter = "all" in scope ? null : scope;
    return {
      decisions: this.d.repo.pendingDecisions(filter).map((x) => this.itemView(x)),
      reports: this.d.repo.recentReports(filter, RECENT_REPORTS_LIMIT).map((x) => this.itemView(x)),
    };
  }

  /** 总控对话区的汇报，一页 limit 条、从新到旧；before 是上一页最早一条汇报的 id（不认识就当没给）。多取一条判断还有没有更早的。 */
  reportsPage(scope: InboxScope, o: { before?: number; limit: number }): { reports: InboxItemView[]; hasMore: boolean } {
    const filter: InboxFilter = "all" in scope ? null : scope;
    const rows = this.d.repo.recentReports(filter, o.limit + 1, o.before);
    return { reports: rows.slice(0, o.limit).map((x) => this.itemView(x)), hasMore: rows.length > o.limit };
  }
}
