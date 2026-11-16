import type { BranchWatchRepo, BranchWatchRow } from "../db/branch-watch-repo";
import type { TicketPr, TicketPrsRepo } from "../db/ticket-prs-repo";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import type { CiCheck } from "../tickets/gh";
import { sanitizeTask } from "../../shared/control";
import { M } from "../strings";
import { CI_LOG_LINES } from "./pr-watcher";

/** 整条通知不能超过 sanitizeTask 的上限，否则结尾的“请修复后再 push”会被截掉；日志总共最多留这么多字符。 */
const LOG_CHARS_TOTAL = 5000;

export interface CiDeliveryDeps {
  prs: Pick<TicketPrsRepo, "get" | "needingRead" | "setDelivered">;
  branches: Pick<BranchWatchRepo, "get" | "all" | "setDelivered">;
  /** ticket 仓库现在的分支；仓库没了为 null。 */
  currentBranch(repoId: number): string | null;
  guard: Pick<DeliveryGuard, "check" | "recheckAfter">;
  /** 这个 ticket 这个仓库自己的 session（不算总控），终端开着的那个的 head id；没有为 null。 */
  sessionFor(ticketKey: string, repoId: number): string | null;
  /** recheck 在粘贴前调用（I2）：不通过就什么都不写，返回 blocked。 */
  deliver(termId: string, text: string, recheck: () => boolean): Promise<DeliverResult>;
  now(): number;
  log(msg: string, err?: unknown): void;
}

/** 一个 PR 行（ticket_prs 的 id）或一个仓库的分支行（branch_watch）。 */
export type CiItem = { kind: "pr"; id: number } | { kind: "branch"; repoId: number };

/** 递过的标记：`${headSha}:${ci}`。待递 = ci 是 passing/failing 且标记和 deliveredKey 不同。 */
export function deliveryKey(row: { headSha: string | null; ci: string }): string {
  return `${row.headSha ?? ""}:${row.ci}`;
}

/** 递一条要用的：哪个 ticket 的哪个仓库、通知里写什么、递完记到哪。 */
interface Pending { ticketKey: string; repoId: number; label: string; key: string; text: () => string; mark: () => void }

/**
 * 把 CI 的结论递给对应 ticket 仓库的 session：现在不能递就留着，等 flush。去重全在这里（PrWatcher 可能对同一个结论多次调用）。
 * 每个 ticket 的 PR 行各递各的：两个 ticket 链接同一个 PR，各自的 session 都收到。
 * 只递 ticket 仓库现在分支上的：PR 行要还开着、head_branch 是仓库现在的分支；分支行的分支要是仓库现在的分支。
 */
export class CiDelivery {
  /** 正在递的 session：同一个 session 同时只递一条。 */
  private readonly busy = new Set<string>();

  constructor(private readonly d: CiDeliveryDeps) {}

  async settled(item: CiItem): Promise<void> {
    await this.tryDeliver(item);
  }

  async flush(): Promise<void> {
    for (const r of this.d.prs.needingRead()) {
      if (r.ci === "passing" || r.ci === "failing") await this.tryDeliver({ kind: "pr", id: r.id });
    }
    for (const r of this.d.branches.all()) {
      if (r.ci === "passing" || r.ci === "failing") await this.tryDeliver({ kind: "branch", repoId: r.repoId });
    }
  }

  /** 重新读一遍：别处可能刚递过，或者 CI 又变了。不该递为 null。 */
  private pending(item: CiItem): Pending | null {
    if (item.kind === "pr") {
      const r = this.d.prs.get(item.id);
      if (!r || r.state !== "open" || r.repoId === null || !settledRow(r) || r.headBranch !== this.d.currentBranch(r.repoId)) return null;
      const key = deliveryKey(r);
      if (key === r.deliveredKey) return null;
      return { ticketKey: r.ticketKey, repoId: r.repoId, label: `${r.ticketKey}#${r.number}`, key, text: () => notice(r, M().ciWherePr(r.number)), mark: () => this.d.prs.setDelivered(r.id, key) };
    }
    const r = this.d.branches.get(item.repoId);
    if (!r || !settledRow(r) || r.branch !== this.d.currentBranch(r.repoId)) return null;
    const key = deliveryKey(r);
    if (key === r.deliveredKey) return null;
    return { ticketKey: r.ticketKey, repoId: r.repoId, label: `${r.ticketKey}@${r.branch}`, key, text: () => notice(r, M().ciWhereBranch(r.branch)), mark: () => this.d.branches.setDelivered(r.repoId, key) };
  }

  private async tryDeliver(item: CiItem): Promise<void> {
    const p = this.pending(item);
    if (!p) return;
    const sessionId = this.d.sessionFor(p.ticketKey, p.repoId);
    if (sessionId === null || this.busy.has(sessionId)) return;
    const gate = this.d.guard.check(sessionId);
    if (!gate.ok) return;
    this.busy.add(sessionId);
    try {
      // 粘贴前再看一遍（I2）：等输入框就绪的这段时间里用户可能开始输入、换新可能开始了。blocked 和 timeout 一样留到下一次 flush。
      const result = await this.d.deliver(gate.termId, sanitizeTask(p.text()), this.d.guard.recheckAfter(sessionId, gate));
      // 只有真的递出去才记；递的过程中如果结论变了，标记的还是递出去的那一条。
      if (result === "sent") p.mark();
      else this.d.log(`ci delivery ${p.label}: ${result}`);
    } catch (e) {
      this.d.log(`ci delivery ${p.label} failed`, e);
    } finally {
      this.busy.delete(sessionId);
    }
  }
}

const settledRow = (r: Pick<TicketPr | BranchWatchRow, "ci" | "headSha">) => (r.ci === "passing" || r.ci === "failing") && r.headSha !== null;

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
