import type { Ticket, TicketRepo, WatchedPr } from "../../shared/types";
import type { PrTarget } from "./pr-watcher";

export interface WatchTargetDeps {
  /** 仓库的工作目录（TicketService.workDir）：gh 在这里跑。 */
  workDir(r: TicketRepo): string;
  /** 这个仓库自己的 session 有没有终端开着（SessionService.hasRepoTerminal）。 */
  sessionOpen(ticketKey: string, repoId: number): boolean;
  /** 这个仓库在 pr_watch 里的行；还没查过为 null。 */
  watched(repoId: number): (Pick<WatchedPr, "state" | "number" | "ci"> & { branch: string }) | null;
  /** 这个 ticket 最新的有效 handoff 里有没有开着的 PR。 */
  handoffHasOpenPr(ticketKey: string): boolean;
}

/**
 * 纯函数：PrWatcher 要查的分支。tickets 是未归档的 ticket；每个仓库满足其一就查：
 * 这个仓库的 session 开着；pr_watch 里它的 PR 还开着；还没查过（或者第一次就没查成：没见过 PR、ci 是 unknown）、
 * 但 ticket 最新 handoff 里有开着的 PR。查过、确实没有 PR 的分支不靠 handoff 再查。
 * 已合并、已关闭的不再查（session 开着也一样），免得占着 PR_WATCH_MAX 的名额。
 */
export function watchTargets(tickets: Pick<Ticket, "key" | "repos">[], d: WatchTargetDeps): PrTarget[] {
  const out: PrTarget[] = [];
  for (const t of tickets) {
    for (const r of t.repos) {
      // ticket 的分支改过（TicketsRepo.updateRepo）：行是旧分支的，当作还没查过（I4）。
      const stored = d.watched(r.id);
      const row = stored && stored.branch === r.branch ? stored : null;
      if (row?.state === "merged" || row?.state === "closed") continue;
      const sessionOpen = d.sessionOpen(t.key, r.id);
      const neverRead = row === null || (row.number === null && row.ci === "unknown");
      if (!sessionOpen && row?.state !== "open" && !(neverRead && d.handoffHasOpenPr(t.key))) continue;
      out.push({ ticketKey: t.key, repoId: r.id, repoPath: r.repoPath, cwd: d.workDir(r), branch: r.branch, sessionOpen });
    }
  }
  return out;
}
