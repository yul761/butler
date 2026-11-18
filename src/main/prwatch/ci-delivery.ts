import type { BranchWatchRepo } from "../db/branch-watch-repo";
import type { TicketPrsRepo } from "../db/ticket-prs-repo";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import type { CiCheck } from "../tickets/gh";
import type { TriageDecision } from "../loop/ci-triage";
import type { CiItemRef, CiUndelivered, CiUndeliveredReason, Session } from "../../shared/types";
import { sanitizeTask } from "../../shared/control";
import { M } from "../strings";
import { CI_LOG_LINES } from "./pr-watcher";

/** 整条通知不能超过 sanitizeTask 的上限，否则结尾的“请修复后再 push”会被截掉；日志总共最多留这么多字符。 */
const LOG_CHARS_TOTAL = 5000;

export interface CiDeliveryDeps {
  prs: Pick<TicketPrsRepo, "get" | "needingRead" | "setDelivered">;
  branches: Pick<BranchWatchRepo, "get" | "all" | "setDelivered">;
  /** ticket 仓库记着的分支；仓库没了为 null。 */
  currentBranch(repoId: number): string | null;
  guard: Pick<DeliveryGuard, "check" | "recheckAfter">;
  /** 这个 ticket 这个仓库这个分支上的结论递给谁（pickRecipient）。 */
  recipient(ticketKey: string, repoId: number, branch: string): Recipient;
  /** recheck 在粘贴前调用（I2）：不通过就什么都不写，返回 blocked。 */
  deliver(termId: string, text: string, recheck: () => boolean): Promise<DeliverResult>;
  /** CI 失败分类（工作流 I）：递之前问一下，hold 就先不递（不算没递出去），note 附在通知后面。没有就原样递。 */
  triage?: { decide(item: CiItem, row: { headSha: string | null; ci: string; failed: CiCheck[] }): TriageDecision };
  /** 正在递的 session，和评论闭环共用（同一个 session 同时只递一条）。没有就自己建一个。 */
  busy?: Set<string>;
  now(): number;
  log(msg: string, err?: unknown): void;
}

/** 一个 PR 行（ticket_prs 的 id）或一个仓库的分支行（branch_watch）。 */
export type CiItem = CiItemRef;

/** 递过的标记：`${headSha}:${ci}`。待递 = ci 是 passing/failing 且标记和 deliveredKey 不同。 */
export function deliveryKey(row: { headSha: string | null; ci: string }): string {
  return `${row.headSha ?? ""}:${row.ci}`;
}

/** 递不出去这么久就在「现在」页提醒（工作流 W）。 */
export const CI_UNDELIVERED_MS = 30 * 60_000;

/** 开着终端的一个 session（head）：pickRecipient 从这里面挑。 */
export interface RecipientCandidate { id: string; gitBranch: string | null; coordinator: boolean }

export type Recipient =
  | { ok: true; sessionId: string; via: "owner" | "branch" | "ticket" }
  | { ok: false; reason: "no_session" | "owner_closed" }
  /** promised：PR 在 ticket 分支上，本来有人等着（这时才在「现在」页提醒）；别的分支上认不出的多半是相关的、别人的 PR。 */
  | { ok: false; reason: "unowned"; candidates: string[]; promised: boolean };

/**
 * 结论递给谁（工作流 W，设计文档 2026-11-18-ws-w-ci-delivery）：
 * 1. 推过这个分支、在上面开过 PR 的 session（owner，hook 记下的），终端开着。
 * 2. 开着的、不是总控的 session 里，启动时就在这个分支上的：正好一个就递它；ticket 分支上有几个（都在共享检出里）递第一个。
 *    归属的终端关了也走这一步（用户新开了一个 session 在同一个分支上等），但不递给别的分支上的 session（以前就是这样递错人的）。
 * 3. 没有归属、PR 在 ticket 分支上、只开着一个 session 而且还不知道它在哪个分支：递它（原来的规则，只留没有歧义的情况）。
 * 都不是：没有开着的 session 为 no_session，记着归属的为 owner_closed，有 session 但认不出是谁的为 unowned。
 */
export function pickRecipient(i: { owner: string | null; ownerOpen: boolean; open: RecipientCandidate[]; ticketBranch: string | null; branch: string }): Recipient {
  if (i.owner !== null && i.ownerOpen) return { ok: true, sessionId: i.owner, via: "owner" };
  const cands = i.open.filter((c) => !c.coordinator);
  const onTicket = i.branch === i.ticketBranch;
  const on = cands.filter((c) => c.gitBranch === i.branch);
  if (on.length === 1 || (on.length > 1 && onTicket)) return { ok: true, sessionId: on[0].id, via: onTicket ? "ticket" : "branch" };
  if (i.owner !== null) return { ok: false, reason: "owner_closed" };
  if (onTicket && cands.length === 1 && cands[0].gitBranch === null) return { ok: true, sessionId: cands[0].id, via: "ticket" };
  return cands.length === 0 ? { ok: false, reason: "no_session" } : { ok: false, reason: "unowned", candidates: cands.map((c) => c.id), promised: onTicket };
}

/**
 * CI 结论递给谁（index.ts 的 recipient）：pickRecipient，加上休眠着的 session（WS-M B）。
 * 选中休眠的也没关系：递之前 DeliveryGuard.check 会叫醒它（返回 hibernated），醒来以后 flush 再递一次。
 *
 * 先后：分支的归属者（开着或者休眠着都算）> 开着终端的 > 休眠着的。
 * 开着的能选出来就不看休眠的：多一个休眠的候选不能让本来认得出的分支变成「认不出是谁的」。
 */
export function ciRecipient(i: {
  ticketKey: string;
  repoId: number;
  branch: string;
  /** 开着终端的 head（同一个 head 可能出现多次，只算一次）。 */
  openHeads: Session[];
  /** 休眠着的 head。 */
  hibernatedHeads: Session[];
  /** branch_owners 记下的 session id（可能是链上的旧 id）；没有记过是 null。 */
  ownerSessionId: string | null;
  /** 链上任何一个 id 的 head。 */
  headOf: (id: string) => Session | null;
  /** 归属者开着终端。 */
  ownerTermOpen: boolean;
  /** ticket 仓库现在的分支。 */
  ticketBranch: string | null;
}): Recipient {
  const seen = new Set<string>();
  const pick = (heads: Session[]): RecipientCandidate[] => {
    const out: RecipientCandidate[] = [];
    for (const h of heads) {
      if (seen.has(h.id) || h.ticketKey !== i.ticketKey || h.repoId !== i.repoId) continue;
      seen.add(h.id);
      out.push({ id: h.id, gitBranch: h.gitBranch, coordinator: h.coordinator });
    }
    return out;
  };
  const open = pick(i.openHeads);
  const asleep = pick(i.hibernatedHeads);
  const owner = i.ownerSessionId === null ? null : (i.headOf(i.ownerSessionId)?.id ?? i.ownerSessionId);
  const ownerAsleep = owner !== null && i.hibernatedHeads.some((h) => h.id === owner);
  const base = { owner, ticketBranch: i.ticketBranch, branch: i.branch };
  const first = pickRecipient({ ...base, ownerOpen: i.ownerTermOpen || ownerAsleep, open });
  if (first.ok || asleep.length === 0) return first;
  const second = pickRecipient({ ...base, ownerOpen: false, open: [...open, ...asleep] });
  // 开着的一个都没有时，带上休眠的候选给出的原因更有用（unowned 会列出它们）。
  return second.ok || first.reason === "no_session" ? second : first;
}

/** 为什么没递（日志和「现在」页的提醒用）。delivered 是已经递过（resend 的返回值），不是失败。 */
export type CiSkipReason = CiUndeliveredReason | "delivered" | "not_open" | "not_settled" | "triage";

/** 递一条要用的：哪个 ticket 的哪个仓库哪个分支、通知里写什么、递完记到哪。 */
interface Pending { ticketKey: string; repoId: number; branch: string; number: number | null; label: string; key: string; text: () => string; mark: () => void }

/** 还没递出去的一条：从什么时候起、最近一次为什么没递、本来要递给谁。 */
interface Waiting { key: string; since: number; reason: CiUndeliveredReason; notify: boolean; sessionId: string | null; ticketKey: string; number: number | null; branch: string }

/**
 * 有人在等、重发可能有用的才提醒：认出了要递给谁只是现在递不进去，或者 ticket 分支上的认不出是谁的（Recipient.promised）。
 * 归属的终端关了、根本没有 session、别的分支上认不出是谁的不提醒（重发也还是一样，只记日志）。
 */
const NOTIFY = (r: CiUndeliveredReason): boolean => r !== "no_session" && r !== "owner_closed" && r !== "unowned" && r !== "no_repo" && r !== "no_sha";

const itemId = (item: CiItem): string => (item.kind === "pr" ? `pr:${item.id}` : `branch:${item.repoId}`);

/**
 * 把 CI 的结论递给 PR 所属的 session（pickRecipient）：现在不能递就留着，等 flush。去重全在这里（PrWatcher 可能对同一个结论多次调用）。
 * 每个 ticket 的 PR 行各递各的：两个 ticket 链接同一个 PR，各自的 session 都收到。分支行只递 ticket 仓库现在分支上的。
 * 每个不递的原因都记日志（同一条结论同一个原因只记一次）；递不出去超过 CI_UNDELIVERED_MS 的由 undelivered() 给「现在」页。
 */
export class CiDelivery {
  /** 正在递的 session：同一个 session 同时只递一条。 */
  private readonly busy: Set<string>;
  /** 每一条上一次记日志的 `${deliveryKey}|${reason}`：原因没变不再记。 */
  private readonly logged = new Map<string, string>();
  /** 还没递出去的结论，键 itemId。只在内存里：重启后第一轮会再递一次，递不出去再从头计时。 */
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly d: CiDeliveryDeps) {
    this.busy = d.busy ?? new Set();
  }

  async settled(item: CiItem): Promise<void> {
    await this.tryDeliver(item);
  }

  async flush(): Promise<void> {
    const seen = new Set<string>();
    for (const r of this.d.prs.needingRead()) {
      if (r.ci === "passing" || r.ci === "failing") {
        seen.add(itemId({ kind: "pr", id: r.id }));
        await this.tryDeliver({ kind: "pr", id: r.id });
      }
    }
    for (const r of this.d.branches.all()) {
      if (r.ci === "passing" || r.ci === "failing") {
        seen.add(itemId({ kind: "branch", repoId: r.repoId }));
        await this.tryDeliver({ kind: "branch", repoId: r.repoId });
      }
    }
    // 合并了、关闭了、CI 又在跑的：不再等着递。
    for (const id of [...this.waiting.keys()]) if (!seen.has(id)) this.forget(id);
  }

  /** 递不出去超过 CI_UNDELIVERED_MS、而且有人在等的结论（「现在」页的提醒），早的在前。 */
  undelivered(): CiUndelivered[] {
    const now = this.d.now();
    const out: CiUndelivered[] = [];
    for (const [id, w] of this.waiting) {
      if (now - w.since < CI_UNDELIVERED_MS || !w.notify) continue;
      const item: CiItem = id.startsWith("pr:") ? { kind: "pr", id: Number(id.slice(3)) } : { kind: "branch", repoId: Number(id.slice(7)) };
      out.push({ item, ticketKey: w.ticketKey, number: w.number, branch: w.branch, reason: w.reason, since: w.since, sessionId: w.sessionId });
    }
    return out.sort((a, b) => a.since - b.since);
  }

  /** 用户点了重发：马上再试一次（照样过 guard），返回结果；sent 是递出去了。 */
  async resend(item: CiItem): Promise<"sent" | CiSkipReason> {
    this.logged.delete(itemId(item));
    return this.tryDeliver(item);
  }

  private forget(id: string): void {
    this.waiting.delete(id);
    this.logged.delete(id);
  }

  /** 重新读一遍：别处可能刚递过，或者 CI 又变了。不该递时是原因。 */
  private pending(item: CiItem): Pending | { skip: CiSkipReason; label: string } {
    if (item.kind === "pr") {
      const r = this.d.prs.get(item.id);
      if (!r) return { skip: "not_open", label: `pr ${item.id}` };
      const label = `${r.ticketKey}#${r.number} (${(r.headSha ?? "").slice(0, 7)}:${r.ci})`;
      if (r.state !== "open") return { skip: "not_open", label };
      if (r.ci !== "passing" && r.ci !== "failing") return { skip: "not_settled", label };
      const key = deliveryKey(r);
      if (key === r.deliveredKey) return { skip: "delivered", label };
      if (r.headSha === null) return { skip: "no_sha", label };
      if (r.repoId === null || r.headBranch === null) return { skip: "no_repo", label };
      const t = this.triage(item, r);
      if (!t) return { skip: "triage", label };
      return {
        ticketKey: r.ticketKey, repoId: r.repoId, branch: r.headBranch, number: r.number, label, key,
        text: () => withNote(notice(r, M().ciWherePr(r.number)), t.note), mark: () => (this.d.prs.setDelivered(r.id, key), t.onSent?.()),
      };
    }
    const r = this.d.branches.get(item.repoId);
    if (!r) return { skip: "not_open", label: `branch ${item.repoId}` };
    const label = `${r.ticketKey}@${r.branch} (${(r.headSha ?? "").slice(0, 7)}:${r.ci})`;
    // 分支行是旧分支的（ticket 刚改了分支，下一轮会换成新分支的）：不递。
    if (r.branch !== this.d.currentBranch(r.repoId)) return { skip: "not_open", label };
    if (r.ci !== "passing" && r.ci !== "failing") return { skip: "not_settled", label };
    const key = deliveryKey(r);
    if (key === r.deliveredKey) return { skip: "delivered", label };
    if (r.headSha === null) return { skip: "no_sha", label };
    const t = this.triage(item, r);
    if (!t) return { skip: "triage", label };
    return {
      ticketKey: r.ticketKey, repoId: r.repoId, branch: r.branch, number: null, label, key,
      text: () => withNote(notice(r, M().ciWhereBranch(r.branch)), t.note), mark: () => (this.d.branches.setDelivered(r.repoId, key), t.onSent?.()),
    };
  }

  /** 问 triage：null = 先不递（在分类、在重跑）。triage 出错不挡递送。 */
  private triage(item: CiItem, r: { headSha: string | null; ci: string; failed: CiCheck[] }): { note: string | null; onSent?: () => void } | null {
    if (!this.d.triage) return { note: null };
    try {
      const t = this.d.triage.decide(item, r);
      return t.action === "hold" ? null : t;
    } catch (e) {
      this.d.log("ci delivery: triage failed", e);
      return { note: null };
    }
  }

  /** 没递：记日志（原因变了才记），有人在等的记进 waiting。 */
  private skipped(id: string, label: string, key: string, reason: CiSkipReason, p: Pending | null, sessionId: string | null, notify?: boolean): CiSkipReason {
    if (reason === "delivered" || reason === "not_open" || reason === "not_settled" || reason === "triage") {
      this.forget(id);
      return reason;
    }
    const sig = `${key}|${reason}`;
    if (this.logged.get(id) !== sig) {
      this.logged.set(id, sig);
      this.d.log(`ci delivery ${label} not delivered: ${reason}`);
    }
    if (p) {
      const prev = this.waiting.get(id);
      const since = prev && prev.key === key ? prev.since : this.d.now();
      this.waiting.set(id, { key, since, reason, notify: notify ?? NOTIFY(reason), sessionId, ticketKey: p.ticketKey, number: p.number, branch: p.branch });
    }
    return reason;
  }

  private async tryDeliver(item: CiItem): Promise<"sent" | CiSkipReason> {
    const id = itemId(item);
    const p = this.pending(item);
    if ("skip" in p) return this.skipped(id, p.label, "", p.skip, null, null);
    const to = this.d.recipient(p.ticketKey, p.repoId, p.branch);
    if (!to.ok) return this.skipped(id, p.label, p.key, to.reason, p, null, to.reason === "unowned" ? to.promised : undefined);
    const sessionId = to.sessionId;
    if (this.busy.has(sessionId)) return this.skipped(id, p.label, p.key, "busy_delivering", p, sessionId);
    const gate = this.d.guard.check(sessionId);
    if (!gate.ok) return this.skipped(id, p.label, p.key, `guard:${gate.block}`, p, sessionId);
    this.busy.add(sessionId);
    try {
      // 粘贴前再看一遍（I2）：等输入框就绪的这段时间里用户可能开始输入、换新可能开始了。blocked 和 timeout 一样留到下一次 flush。
      const result = await this.d.deliver(gate.termId, sanitizeTask(p.text()), this.d.guard.recheckAfter(sessionId, gate));
      // 只有真的递出去才记；递的过程中如果结论变了，标记的还是递出去的那一条。
      if (result === "sent") {
        p.mark();
        this.forget(id);
        this.d.log(`ci delivery ${p.label}: sent to ${sessionId} (${to.via})`);
        return "sent";
      }
      return this.skipped(id, p.label, p.key, `deliver:${result}`, p, sessionId);
    } catch (e) {
      this.d.log(`ci delivery ${p.label} failed`, e);
      return this.skipped(id, p.label, p.key, "failed", p, sessionId);
    } finally {
      this.busy.delete(sessionId);
    }
  }
}

/** Butler 的判断放在通知最后。日志最多 LOG_CHARS_TOTAL 字，加上判断也在 sanitizeTask 的上限以内。 */
function withNote(text: string, note: string | null): string {
  return note ? `${text}\n\n${note}` : text;
}

function notice(row: { ci: string; headSha: string | null; failed: CiCheck[] }, where: string): string {
  const m = M();
  const sha7 = (row.headSha ?? "").slice(0, 7);
  if (row.ci === "passing") return m.ciPassedNotice(where, sha7);
  const budget = Math.floor(LOG_CHARS_TOTAL / Math.max(1, row.failed.filter((f) => f.log).length));
  const failed = row.failed.map((f) => ({ name: f.name, log: f.log === undefined ? undefined : tail(f.log, budget) }));
  return m.ciFailedNotice(where, sha7, failed);
}

/** 最后 CI_LOG_LINES 行，再按字符数从尾部截。 */
function tail(log: string, maxChars: number): string {
  const text = log.replace(/\n+$/, "").split("\n").slice(-CI_LOG_LINES).join("\n");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
