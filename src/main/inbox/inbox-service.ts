import { sanitizeTask, TASK_LIMIT, type ReportKind } from "../../shared/control";
import type { InboxItemView, InboxRole, InboxScope, InboxView, NowTarget, Session, Ticket } from "../../shared/types";
import type { InboxArchiveScope, InboxFilter, InboxItem, InboxOwner, InboxRepo } from "../db/inbox-repo";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { M } from "../strings";

/** feature 页、epic 页上最多显示这么多条最近的汇报。 */
export const RECENT_REPORTS_LIMIT = 30;
/** 汇报这么久还没送到总控（总控一直没开、没停下来）就不送了：过时的「做完了」只会误导总控。 */
export const REPORT_DELIVERY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** 一次送给总控的几条汇报（或者送给提问的 session 的几条回答）加起来最多这么多字符（sanitizeTask 的上限之内，留出开头的位置）；剩下的下一次送。 */
const BATCH_CHARS = TASK_LIMIT - 1000;
/**
 * 递回答送到（deliver 返回 sent）以后这么久之内，这个 session 的下一次 UserPromptSubmit 算是这次递引起的（只认一次）：
 * deliver 没等到 hook 就返回时（hook 不通、等满了），迟到的那一次不能把它别的未决条目当成用户在终端里答了。
 */
export const ANSWERING_TTL_MS = 30_000;

export interface InboxServiceDeps {
  repo: InboxRepo;
  /** 链上最新的 session（换新过的话是新的那个）；没有为 null。 */
  head(sessionId: string): Session | null;
  /** Butler 正在给这个 session（链上任何一个 id）换新：/handoff 和接着做的话引起的 UserPromptSubmit 不是用户在回答。 */
  refreshing(sessionId: string): boolean;
  ticket(key: string): Ticket | null;
  /** feature 属于哪个 epic；不属于或者找不到为 null。 */
  epicOfFeature(featureId: number): number | null;
  /** 跑着这个 session（链上任何一个 id）的终端；没有为 null。 */
  termOf(sessionId: string): string | null;
  /** 开着终端的 Butler session 的 head。 */
  openHeads(): Session[];
  /** epic 的名字（送给 Butler 总控的汇报里写是哪个 epic，BTL-190 第 5 点）；不给或者找不到就不写。 */
  epicName?(epicId: number): string | null;
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
export function roleOf(s: Pick<Session, "ticketKey" | "coordinator" | "featureId" | "fixesSession" | "epicId"> & { butler?: boolean }): InboxRole {
  if (s.ticketKey !== null) return s.coordinator ? "ticket_coordinator" : "ticket";
  if (s.featureId !== null) return s.fixesSession !== null ? "fix" : "feature_coordinator";
  // Butler 总控（BTL-190 第 5 点）：ticket、feature、epic 都是空的。
  if (s.butler) return "butler";
  return "epic";
}

/**
 * 上面可能有管它的总控（汇报才有地方送）：ticket session 一直可能（ticket 总控随时能开）；ticket 总控、修复 session 要属于 feature 或 epic；
 * feature 总控要属于 epic；epic session 和 Butler 总控这里都算没有（epic 的另看 Butler 总控开没开）。
 */
function mayHaveCoordinator(role: InboxRole, o: Pick<InboxOwner, "featureId" | "epicId">): boolean {
  if (role === "ticket") return true;
  if (role === "ticket_coordinator" || role === "fix") return o.featureId !== null || o.epicId !== null;
  if (role === "feature_coordinator") return o.epicId !== null;
  return false;
}

const repoName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * 「待你决定」和汇报（BTL-190 第 2+3 点）。
 * - ask_user 记一条 pending 的 decision；用户在卡片上答了以后先记下答案（status 还是 pending），等提问的 session 停下来再送进去，送到才算 answered。
 * - 用户直接在终端里回答（提问的 session 收到 UserPromptSubmit）：它还没答的条目都算 answered（卡片上答好、还没送的留着，下次照常送）。
 *   Butler 自己递回答、换新时输入的 /handoff 和接着做的话引起的那次不算。
 * - report 存下；done / blocked 等管它的总控停下来时送进去（progress 只存不送；上面不可能有总控的也只存）。
 */
export class InboxService {
  /** 正在往里递东西的 session（head id）：同一个 session 同时只递一条。 */
  private readonly busy = new Set<string>();
  /** 正在递回答、或者刚送到回答的 session（head id）→ 到什么时候为止：这次递引起的 UserPromptSubmit 不结束别的条目（见 ANSWERING_TTL_MS）。 */
  private readonly answering = new Map<string, number>();

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

  /**
   * report：存下来。queued：会送给总控（done / blocked，而且这个 session 上面可能有总控）。
   * noCoordinator：done / blocked，但上面不可能有总控（没有 feature 的 ticket 总控、不属于 epic 的 feature 总控、Butler 总控自己，
   * 以及 Butler 总控没开着时的 epic session），只存。
   */
  report(s: Session, text: string, kind: ReportKind): { id: number; queued: boolean; noCoordinator: boolean } {
    const owner = this.owner(s);
    const noCoordinator = kind !== "progress" && !this.hasCoordinator(s, owner);
    const queued = kind !== "progress" && !noCoordinator;
    const id = this.d.repo.addReport({ ...owner, text, kind, status: queued ? "pending" : "dismissed", createdAt: this.d.now() });
    this.d.notify();
    if (queued) void this.flushReports();
    return { id, queued, noCoordinator };
  }

  /** ticket、feature、epic 归档了：这个范围里还未决的「待你决定」和汇报都记成 dismissed（不再显示、不再送）。 */
  dismissScope(scope: InboxArchiveScope): void {
    if (this.d.repo.dismissPending(scope, this.d.now()) > 0) this.d.notify();
  }

  /** 这个 session 上面有没有能收汇报的总控：epic session 只有 Butler 总控开着时才有（BTL-190 第 5 点，没开就只存），别的看 mayHaveCoordinator。 */
  private hasCoordinator(s: Session, owner: Pick<InboxOwner, "featureId" | "epicId">): boolean {
    const role = roleOf(s);
    if (role === "epic") return this.d.openHeads().some((h) => h.butler);
    return mayHaveCoordinator(role, owner);
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
   * 这个 session 收到 UserPromptSubmit：用户在终端里回答了，它还没答的条目都算 answered。卡片上答好、还没送进去的不动：
   * 下次停下来照常送（不然答案永远送不进去）。
   * Butler 正在往里递回答、刚送到回答（只认一次，最多 ANSWERING_TTL_MS），或者正在换新（/handoff、接着做的话）时不算：
   * 递的回答送到后自己结束那几条。
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
    const lines: string[] = [];
    const sent: InboxItem[] = [];
    let size = m.inboxAnswersIntro.length;
    for (const x of items) {
      let line = m.inboxAnswer(x.text, x.answer ?? "");
      // 第一条总要送；后面的放不下就留到下一次（sanitizeTask 会截掉超出的部分，截掉的回答不能算送到了）。
      if (sent.length > 0 && size + 2 + line.length > BATCH_CHARS) break;
      // 单独一条就放不下：截掉它自己的回答，注明截掉了（不然它永远送不进去，后面的也一直卡着）。
      if (line.length > BATCH_CHARS) {
        const keep = Math.max(0, BATCH_CHARS - m.inboxAnswer(x.text, "").length - m.inboxAnswerCut.length);
        line = m.inboxAnswer(x.text, Array.from(x.answer ?? "").slice(0, keep).join("") + m.inboxAnswerCut);
      }
      lines.push(line);
      sent.push(x);
      size += 2 + line.length;
    }
    const text = lines.length === 1 ? lines[0] : [m.inboxAnswersIntro, ...lines].join("\n\n");
    this.busy.add(head);
    // 递的途中（不限时）和送到以后 ANSWERING_TTL_MS 之内，这个 session 的下一次 UserPromptSubmit 算这次递引起的。
    this.answering.set(head, Infinity);
    let typed = false;
    try {
      const result = await this.d.deliver(gate.termId, sanitizeTask(text), this.d.answerGuard.recheckAfter(head, gate));
      if (result === "sent") {
        typed = true;
        const now = this.d.now();
        // 只结束答案还是送出去那份的：投递途中用户改了答案，新答案留着下次送。
        for (const x of sent) this.d.repo.resolve(x.id, "answered", now, x.answer ?? undefined);
        this.d.notify();
      } else this.d.log(`inbox: answers for ${head}: ${result}`);
    } catch (e) {
      this.d.log(`inbox: answers for ${head} failed`, e);
    } finally {
      this.busy.delete(head);
      // 送到了、UserPromptSubmit 还没来（deliver 没等到 hook 就返回）：再等它一会儿。来过了（已经删掉）或者没送到就不留。
      if (typed && this.answering.has(head)) this.answering.set(head, this.d.now() + ANSWERING_TTL_MS);
      else this.answering.delete(head);
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
    // epic session → Butler 总控（BTL-190 第 5 点）。
    if (target === null && role === "epic") target = pick((h) => h.butler);
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
      if (sent.length > 0 && size + line.length > BATCH_CHARS) break;
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
    return M().inboxWho(role, s.ticketKey, role === "ticket" ? this.repoOf(s) : null, role === "epic" && s.epicId !== null ? this.d.epicName?.(s.epicId) : null);
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
    const role: InboxRole = s ? roleOf(s) : item.ticketKey !== null ? "ticket" : item.featureId !== null ? "feature_coordinator" : item.epicId !== null ? "epic" : "butler";
    const target: NowTarget =
      item.ticketKey !== null ? { page: "ticket", key: item.ticketKey, sessionId }
      : s?.featureId != null || (s === null && item.featureId !== null) ? { page: "feature", id: (s?.featureId ?? item.featureId) as number, sessionId }
      : role === "butler" ? { page: "butler", sessionId }
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
