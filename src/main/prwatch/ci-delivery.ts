import type { BranchWatchRepo } from "../db/branch-watch-repo";
import type { TicketPrsRepo } from "../db/ticket-prs-repo";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import type { CiCheck } from "../tickets/gh";
import type { CiItemRef, CiUndelivered, CiUndeliveredReason } from "../../shared/types";
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
  | { ok: false; reason: "unowned"; candidates: string[] };

/**
 * 结论递给谁（工作流 W，设计文档 2026-11-18-ws-w-ci-delivery）：
 * 1. 推过这个分支、在上面开过 PR 的 session（owner，hook 记下的）。记着归属但它的终端关了：不递给别人（以前就是这样递错人的）。
 * 2. 没有归属：开着的、不是总控的 session 里，启动时就在这个分支上的那一个（正好一个）。
 * 3. PR 在 ticket 仓库记着的分支上：第一个开着的、不是总控的 session（原来的规则）。
 * 都不是：没有开着的 session 为 no_session，有但认不出是谁的为 unowned。
 */
export function pickRecipient(i: { owner: string | null; ownerOpen: boolean; open: RecipientCandidate[]; ticketBranch: string | null; branch: string }): Recipient {
  if (i.owner !== null) return i.ownerOpen ? { ok: true, sessionId: i.owner, via: "owner" } : { ok: false, reason: "owner_closed" };
  const cands = i.open.filter((c) => !c.coordinator);
  if (i.branch !== i.ticketBranch) {
    const on = cands.filter((c) => c.gitBranch === i.branch);
    if (on.length === 1) return { ok: true, sessionId: on[0].id, via: "branch" };
  } else if (cands.length > 0) return { ok: true, sessionId: cands[0].id, via: "ticket" };
  return cands.length === 0 ? { ok: false, reason: "no_session" } : { ok: false, reason: "unowned", candidates: cands.map((c) => c.id) };
}

/** 为什么没递（日志和「现在」页的提醒用）。delivered 是已经递过（resend 的返回值），不是失败。 */
export type CiSkipReason = CiUndeliveredReason | "delivered" | "not_open" | "not_settled";

/** 递一条要用的：哪个 ticket 的哪个仓库哪个分支、通知里写什么、递完记到哪。 */
interface Pending { ticketKey: string; repoId: number; branch: string; number: number | null; label: string; key: string; text: () => string; mark: () => void }

/** 还没递出去的一条：从什么时候起、最近一次为什么没递、本来要递给谁。 */
interface Waiting { key: string; since: number; reason: CiUndeliveredReason; sessionId: string | null; ticketKey: string; number: number | null; branch: string }

/** 有人在等（session 开着，只是现在递不进去、或者认不出是谁的）的原因才提醒；归属的终端关了、根本没有 session 的不提醒。 */
const NOTIFY = (r: CiUndeliveredReason): boolean => r !== "no_session" && r !== "owner_closed" && r !== "no_repo" && r !== "no_sha";

const itemId = (item: CiItem): string => (item.kind === "pr" ? `pr:${item.id}` : `branch:${item.repoId}`);

/**
 * 把 CI 的结论递给 PR 所属的 session（pickRecipient）：现在不能递就留着，等 flush。去重全在这里（PrWatcher 可能对同一个结论多次调用）。
 * 每个 ticket 的 PR 行各递各的：两个 ticket 链接同一个 PR，各自的 session 都收到。分支行只递 ticket 仓库现在分支上的。
 * 每个不递的原因都记日志（同一条结论同一个原因只记一次）；递不出去超过 CI_UNDELIVERED_MS 的由 undelivered() 给「现在」页。
 */
export class CiDelivery {
  /** 正在递的 session：同一个 session 同时只递一条。 */
  private readonly busy = new Set<string>();
  /** 每一条上一次记日志的 `${deliveryKey}|${reason}`：原因没变不再记。 */
  private readonly logged = new Map<string, string>();
  /** 还没递出去的结论，键 itemId。只在内存里：重启后第一轮会再递一次，递不出去再从头计时。 */
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly d: CiDeliveryDeps) {}

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
      if (now - w.since < CI_UNDELIVERED_MS || !NOTIFY(w.reason)) continue;
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
      return {
        ticketKey: r.ticketKey, repoId: r.repoId, branch: r.headBranch, number: r.number, label, key,
        text: () => notice(r, M().ciWherePr(r.number)), mark: () => this.d.prs.setDelivered(r.id, key),
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
    return {
      ticketKey: r.ticketKey, repoId: r.repoId, branch: r.branch, number: null, label, key,
      text: () => notice(r, M().ciWhereBranch(r.branch)), mark: () => this.d.branches.setDelivered(r.repoId, key),
    };
  }

  /** 没递：记日志（原因变了才记），有人在等的记进 waiting。 */
  private skipped(id: string, label: string, key: string, reason: CiSkipReason, p: Pending | null, sessionId: string | null): CiSkipReason {
    if (reason === "delivered" || reason === "not_open" || reason === "not_settled") {
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
      this.waiting.set(id, { key, since, reason, sessionId, ticketKey: p.ticketKey, number: p.number, branch: p.branch });
    }
    return reason;
  }

  private async tryDeliver(item: CiItem): Promise<"sent" | CiSkipReason> {
    const id = itemId(item);
    const p = this.pending(item);
    if ("skip" in p) return this.skipped(id, p.label, "", p.skip, null, null);
    const to = this.d.recipient(p.ticketKey, p.repoId, p.branch);
    if (!to.ok) return this.skipped(id, p.label, p.key, to.reason, p, null);
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
