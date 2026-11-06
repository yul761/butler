import type { PrWatchRepo, PrWatchRow } from "../db/pr-watch-repo";
import type { DeliveryGuard } from "../sessions/delivery-guard";
import { sanitizeTask } from "../../shared/control";
import { M } from "../strings";
import { CI_LOG_LINES } from "./pr-watcher";

/** 整条通知不能超过 sanitizeTask 的上限，否则结尾的“请修复后再 push”会被截掉；日志总共最多留这么多字符。 */
const LOG_CHARS_TOTAL = 5000;

export interface CiDeliveryDeps {
  repo: Pick<PrWatchRepo, "all" | "get" | "setDelivered">;
  guard: Pick<DeliveryGuard, "check">;
  /** 这个 ticket 这个仓库自己的 session（不算总控），终端开着的那个的 head id；没有为 null。 */
  sessionFor(ticketKey: string, repoId: number): string | null;
  deliver(termId: string, text: string): Promise<"sent" | "exited" | "timeout">;
  now(): number;
  log(msg: string, err?: unknown): void;
}

/** 递过的标记：`${headSha}:${ci}`。待递 = ci 是 passing/failing 且标记和 deliveredKey 不同。 */
export function deliveryKey(row: Pick<PrWatchRow, "headSha" | "ci">): string {
  return `${row.headSha ?? ""}:${row.ci}`;
}

/** 把 CI 的结论递给对应仓库的 session：现在不能递就留着，等 flush。去重全在这里（PrWatcher 可能对同一个结论多次调用）。 */
export class CiDelivery {
  /** 正在递的 session：同一个 session 同时只递一条。 */
  private readonly busy = new Set<string>();

  constructor(private readonly d: CiDeliveryDeps) {}

  async settled(row: PrWatchRow): Promise<void> {
    await this.tryDeliver(row.repoId);
  }

  async flush(): Promise<void> {
    for (const r of this.d.repo.all()) {
      if (r.ci === "passing" || r.ci === "failing") await this.tryDeliver(r.repoId);
    }
  }

  private async tryDeliver(repoId: number): Promise<void> {
    // 重新读一遍：别处可能刚递过，或者 CI 又变了。
    const row = this.d.repo.get(repoId);
    if (!row || (row.ci !== "passing" && row.ci !== "failing") || row.headSha === null) return;
    const key = deliveryKey(row);
    if (key === row.deliveredKey) return;
    const sessionId = this.d.sessionFor(row.ticketKey, row.repoId);
    if (sessionId === null || this.busy.has(sessionId)) return;
    const gate = this.d.guard.check(sessionId);
    if (!gate.ok) return;
    this.busy.add(sessionId);
    try {
      const result = await this.d.deliver(gate.termId, sanitizeTask(notice(row)));
      // 只有真的递出去才记；递的过程中如果结论变了，标记的还是递出去的那一条。
      if (result === "sent") this.d.repo.setDelivered(repoId, key);
      else this.d.log(`ci delivery ${row.ticketKey}#${repoId}: ${result}`);
    } catch (e) {
      this.d.log(`ci delivery ${row.ticketKey}#${repoId} failed`, e);
    } finally {
      this.busy.delete(sessionId);
    }
  }
}

function notice(row: PrWatchRow): string {
  const m = M();
  const where = row.number !== null ? m.ciWherePr(row.number) : m.ciWhereBranch(row.branch);
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
