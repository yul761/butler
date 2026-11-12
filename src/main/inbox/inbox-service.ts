import { sanitizeTask, TASK_LIMIT, type ReportKind } from "../../shared/control";
import type { InboxItemView, InboxRole, InboxScope, InboxView, NowTarget, Session, Ticket } from "../../shared/types";
import type { InboxFilter, InboxItem, InboxOwner, InboxRepo } from "../db/inbox-repo";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { M } from "../strings";

/** feature 页、epic 页上最多显示这么多条最近的汇报。 */
export const RECENT_REPORTS_LIMIT = 30;
/** 汇报这么久还没送到总控（总控一直没开、没停下来）就不送了：过时的「做完了」只会误导总控。 */
export const REPORT_DELIVERY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** 一次送给总控的几条汇报加起来最多这么多字符（sanitizeTask 的上限之内，留出开头的位置）；剩下的下一次送。 */
const REPORT_BATCH_CHARS = TASK_LIMIT - 1000;

export interface InboxServiceDeps {
  repo: InboxRepo;
  /** 链上最新的 session（换新过的话是新的那个）；没有为 null。 */
  head(sessionId: string): Session | null;
  ticket(key: string): Ticket | null;
  /** feature 属于哪个 epic；不属于或者找不到为 null。 */
  epicOfFeature(featureId: number): number | null;
  /** 跑着这个 session（链上任何一个 id）的终端；没有为 null。 */
  termOf(sessionId: string): string | null;
  /** 开着终端的 Butler session 的 head。 */
  openHeads(): Session[];
  /** 递回答用的：不看「需要你」（未决的 ask_user 本身就算需要你），别的照常（忙、屏幕上有对话框、用户在打字、有草稿、在换新）。 */
  answerGuard: Pick<DeliveryGuard, "check" | "recheckAfter">;
  /** 递汇报用的：和 CI 结果同一道 guard（总控在等用户回答时不往里贴）。 */
  reportGuard: Pick<DeliveryGuard, "check" | "recheckAfter">;
  deliver(termId: string, text: string, recheck: () => boolean): Promise<DeliverResult>;
  notify(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

/** 提问 / 汇报的是哪种 session。 */
export function roleOf(s: Pick<Session, "ticketKey" | "coordinator" | "featureId" | "fixesSession" | "epicId">): InboxRole {
  if (s.ticketKey !== null) return s.coordinator ? "ticket_coordinator" : "ticket";
  if (s.featureId !== null) return s.fixesSession !== null ? "fix" : "feature_coordinator";
  return "epic";
}

const repoName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * 「待你决定」和汇报（BTL-190 第 2+3 点）。
 * - ask_user 记一条 pending 的 decision；用户在卡片上答了以后先记下答案（status 还是 pending），等提问的 session 停下来再送进去，送到才算 answered。
 * - 用户直接在终端里回答（提问的 session 收到 UserPromptSubmit）：它所有未决的条目都算 answered。Butler 自己递回答引起的那次不算。
 * - report 存下；done / blocked 等管它的总控停下来时送进去（progress 只存不送）。
 */
export class InboxService {
  /** 正在往里递东西的 session（head id）：同一个 session 同时只递一条。 */
  private readonly busy = new Set<string>();
  /** 正在递回答的 session（head id）→ 这次递的条目：这次递引起的 UserPromptSubmit 只结束这些条目。 */
  private readonly answering = new Map<string, number[]>();

  constructor(private readonly d: InboxServiceDeps) {}

  /** 这个 session 拥有的 ticket、feature、epic：ticket 的 session 从 ticket 往上找。 */
  private owner(s: Session): InboxOwner {
    if (s.ticketKey !== null) {
      const featureId = this.d.ticket(s.ticketKey)?.featureId ?? null;
      return { sessionId: s.id, ticketKey: s.ticketKey, featureId, epicId: featureId === null ? null : this.d.epicOfFeature(featureId) };
    }
    if (s.featureId !== null) return { sessionId: s.id, ticketKey: null, featureId: s.featureId, epicId: this.d.epicOfFeature(s.featureId) };
    return { sessionId: s.id, ticketKey: null, featureId: null, epicId: s.epicId };
  }

  private headId(sessionId: string): string {
    return this.d.head(sessionId)?.id ?? sessionId;
  }

  /** ask_user：记一条「待你决定」。同一个 session 还没决的同一个问题被这条顶掉（superseded）。s 是提问的 session 的 head。 */
  ask(s: Session, q: { question: string; options?: string[]; context?: string }): number {
    const now = this.d.now();
    for (const old of this.d.repo.pendingDecisions()) {
      if (old.text === q.question && this.headId(old.sessionId) === s.id) this.d.repo.resolve(old.id, "superseded", now);
    }
    const id = this.d.repo.addDecision({ ...this.owner(s), question: q.question, options: q.options ?? [], context: q.context ?? null, createdAt: now });
    this.d.notify();
    return id;
  }

  /** report：存下来。返回会不会送给总控（done / blocked，而且这个 session 上面有总控）。 */
  report(s: Session, text: string, kind: ReportKind): { id: number; queued: boolean } {
    const queued = kind !== "progress" && roleOf(s) !== "epic";
    const id = this.d.repo.addReport({ ...this.owner(s), text, kind, status: queued ? "pending" : "dismissed", createdAt: this.d.now() });
    this.d.notify();
    if (queued) void this.flushReports();
    return { id, queued };
  }

  /** 用户在卡片上回答（选项或者打的字）：记下答案，能送就马上送。条目已经不是未决的返回 false。 */
  answer(id: number, text: string): boolean {
    const answer = text.trim();
    const item = this.d.repo.get(id);
    if (!answer || !item || item.kind !== "decision" || !this.d.repo.setAnswer(id, answer)) return false;
    this.d.notify();
    void this.flushAnswers(this.headId(item.sessionId));
    return true;
  }

  /** 「不用了」：结束这一条，什么都不送。 */
  dismiss(id: number): boolean {
    const item = this.d.repo.get(id);
    if (!item || item.kind !== "decision" || !this.d.repo.resolve(id, "dismissed", this.d.now())) return false;
    this.d.notify();
    return true;
  }

  /**
   * 这个 session 收到 UserPromptSubmit：用户在终端里回答了，它所有未决的条目都算 answered（有答案的留着答案）。
   * Butler 正在往里递回答时只结束这次递的条目（deliver 送到后自己结束）。
   */
  promptSubmitted(sessionId: string): void {
    const head = this.headId(sessionId);
    if (this.answering.has(head)) return;
    const now = this.d.now();
    let changed = false;
    for (const item of this.d.repo.pendingDecisions()) {
      if (this.headId(item.sessionId) === head && this.d.repo.resolve(item.id, "answered", now)) changed = true;
    }
    if (changed) this.d.notify();
  }

  /** 这个 session（链上任何一个 id）有未决的 ask_user：不自动输入（除了回答本身）、不闲置关闭、不自动换新。 */
  hasPendingDecision(sessionId: string): boolean {
    const head = this.headId(sessionId);
    return this.d.repo.pendingDecisions().some((item) => this.headId(item.sessionId) === head);
  }

  /** 递还没递出去的回答和汇报；太旧的汇报不再送。永不 reject。 */
  async flush(): Promise<void> {
    try {
      const heads = new Set(this.d.repo.pendingDecisions().filter((x) => x.answer !== null).map((x) => this.headId(x.sessionId)));
      for (const h of heads) await this.flushAnswers(h);
      await this.flushReports();
    } catch (e) {
      this.d.log("inbox: flush failed", e);
    }
  }

  /** 把这个 session 已经答了、还没送的回答一起送进去（一条消息）。 */
  private async flushAnswers(head: string): Promise<void> {
    if (this.busy.has(head)) return;
    const items = this.d.repo.pendingDecisions().filter((x) => x.answer !== null && this.headId(x.sessionId) === head);
    if (items.length === 0) return;
    const gate = this.d.answerGuard.check(head);
    if (!gate.ok) return;
    const m = M();
    const lines = items.map((x) => m.inboxAnswer(x.text, x.answer ?? ""));
    const text = lines.length === 1 ? lines[0] : [m.inboxAnswersIntro, ...lines].join("\n\n");
    this.busy.add(head);
    this.answering.set(head, items.map((x) => x.id));
    try {
      const result = await this.d.deliver(gate.termId, sanitizeTask(text), this.d.answerGuard.recheckAfter(head, gate));
      if (result === "sent") {
        const now = this.d.now();
        for (const x of items) this.d.repo.resolve(x.id, "answered", now);
        this.d.notify();
      } else this.d.log(`inbox: answers for ${head}: ${result}`);
    } catch (e) {
      this.d.log(`inbox: answers for ${head} failed`, e);
    } finally {
      this.busy.delete(head);
      this.answering.delete(head);
    }
  }

  /**
   * 汇报送给谁：管这个 session 的、终端开着的总控（head id）。
   * ticket 的 session → 同一个 ticket 的总控 → feature 总控 → epic session；ticket 总控、修复 session → feature 总控 → epic session；
   * feature 总控 → epic session。
   */
  private reportTarget(item: InboxItem, author: Session): string | null {
    const open = this.d.openHeads();
    const role = roleOf(author);
    const pick = (ok: (h: Session) => boolean): string | null => open.find((h) => h.id !== author.id && ok(h))?.id ?? null;
    let target: string | null = null;
    if (role === "ticket" && item.ticketKey !== null) target = pick((h) => h.ticketKey === item.ticketKey && h.coordinator);
    if (target === null && role !== "feature_coordinator" && role !== "epic" && item.featureId !== null) {
      target = pick((h) => h.ticketKey === null && h.featureId === item.featureId && h.fixesSession === null);
    }
    if (target === null && role !== "epic" && item.epicId !== null) target = pick((h) => h.ticketKey === null && h.featureId === null && h.epicId === item.epicId);
    return target;
  }

  /** 把还要送的汇报按总控分组，每个总控一条消息。 */
  private async flushReports(): Promise<void> {
    const now = this.d.now();
    const byTarget = new Map<string, { item: InboxItem; author: Session }[]>();
    for (const item of this.d.repo.pendingReports()) {
      const author = this.d.head(item.sessionId);
      if (!author || now - item.createdAt > REPORT_DELIVERY_MAX_AGE_MS) {
        this.d.repo.resolve(item.id, "dismissed", now);
        continue;
      }
      const target = this.reportTarget(item, author);
      if (target !== null) byTarget.set(target, [...(byTarget.get(target) ?? []), { item, author }]);
    }
    for (const [target, list] of byTarget) await this.deliverReports(target, list);
  }

  private async deliverReports(target: string, list: { item: InboxItem; author: Session }[]): Promise<void> {
    if (this.busy.has(target)) return;
    const gate = this.d.reportGuard.check(target);
    if (!gate.ok) return;
    const m = M();
    const lines: string[] = [];
    const sent: number[] = [];
    let size = 0;
    for (const { item, author } of list) {
      const line = m.inboxReportLine(this.whoOf(author), m.inboxReportKinds[item.reportKind ?? "progress"], item.text);
      // 第一条总要送；后面的放不下就留到下一次。
      if (sent.length > 0 && size + line.length > REPORT_BATCH_CHARS) break;
      lines.push(line);
      sent.push(item.id);
      size += line.length;
    }
    this.busy.add(target);
    try {
      const result = await this.d.deliver(gate.termId, sanitizeTask([m.inboxReportsIntro, ...lines].join("\n\n")), this.d.reportGuard.recheckAfter(target, gate));
      if (result === "sent") {
        const at = this.d.now();
        for (const id of sent) this.d.repo.resolve(id, "answered", at);
        this.d.notify();
      } else this.d.log(`inbox: reports for ${target}: ${result}`);
    } catch (e) {
      this.d.log(`inbox: reports for ${target} failed`, e);
    } finally {
      this.busy.delete(target);
    }
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
    const role: InboxRole = s ? roleOf(s) : item.ticketKey !== null ? "ticket" : item.featureId !== null ? "feature_coordinator" : "epic";
    const target: NowTarget =
      item.ticketKey !== null ? { page: "ticket", key: item.ticketKey, sessionId }
      : s?.featureId != null || (s === null && item.featureId !== null) ? { page: "feature", id: (s?.featureId ?? item.featureId) as number, sessionId }
      : { page: "epic", id: item.epicId ?? 0, sessionId };
    return {
      id: item.id, kind: item.kind, sessionId, role, ticketKey: item.ticketKey, featureId: item.featureId, epicId: item.epicId,
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

  /** feature 页、epic 页（以后 Butler 总控页用 all）上面的两栏。 */
  view(scope: InboxScope): InboxView {
    const filter: InboxFilter = "all" in scope ? null : scope;
    return {
      decisions: this.d.repo.pendingDecisions(filter).map((x) => this.itemView(x)),
      reports: this.d.repo.recentReports(filter, RECENT_REPORTS_LIMIT).map((x) => this.itemView(x)),
    };
  }
}
