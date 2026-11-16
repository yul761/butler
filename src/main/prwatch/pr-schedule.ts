import type { BranchWatchRow } from "../db/branch-watch-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { Ticket, TicketRepo } from "../../shared/types";

/** 有检查在跑、session 开着：每分钟查一次。 */
export const PR_FAST_MS = 60_000;
/** 其余每 5 分钟查一次。 */
export const PR_SLOW_MS = 300_000;
/** 同时跟踪的分支/PR 最多这么多个，超出时优先保留 session 开着的。 */
export const PR_WATCH_MAX = 40;
/** 没开 session 的分支：每半小时找一次 PR。 */
export const BRANCH_IDLE_MS = 30 * 60_000;

export interface BranchTarget {
  ticketKey: string;
  repoId: number;
  repoPath: string;
  cwd: string;
  branch: string;
  sessionOpen: boolean;
}

/** 每个 URL 一次轮询：rows 是所有 ticket 对这个 URL 的行。 */
export interface PrPoll {
  url: string;
  rows: TicketPr[];
  cwd: string;
  repoPath: string | null;
  slug: string;
  sessionOpen: boolean;
}

/** 每个 ticket 仓库一个要找 PR / 看 CI 的分支。 */
export function branchTargets(
  tickets: Pick<Ticket, "key" | "repos">[],
  d: { ghWorkDir(r: TicketRepo): string; sessionOpen(ticketKey: string, repoId: number): boolean },
): BranchTarget[] {
  return tickets.flatMap((t) =>
    t.repos.map((r) => ({
      ticketKey: t.key, repoId: r.id, repoPath: r.repoPath, cwd: d.ghWorkDir(r), branch: r.branch, sessionOpen: d.sessionOpen(t.key, r.id),
    })),
  );
}

/** 按 URL 合并各 ticket 的行；cwd 是 PR 所在 ticket 仓库的工作目录，不是 ticket 仓库的（repoId 为 null）用 home。 */
export function prPolls(
  rows: TicketPr[],
  d: {
    repoOf(repoId: number): TicketRepo | null;
    ghWorkDir(r: TicketRepo): string;
    home: string;
    sessionOpen(ticketKey: string, repoId: number | null): boolean;
  },
): PrPoll[] {
  const byUrl = new Map<string, TicketPr[]>();
  for (const r of rows) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r]);
  return [...byUrl.entries()].map(([url, group]) => {
    let repo: TicketRepo | null = null;
    for (const r of group) {
      repo = r.repoId === null ? null : d.repoOf(r.repoId);
      if (repo) break;
    }
    return {
      url,
      rows: group,
      cwd: repo ? d.ghWorkDir(repo) : d.home,
      repoPath: repo ? repo.repoPath : null,
      slug: group[0].slug,
      sessionOpen: group.some((r) => d.sessionOpen(r.ticketKey, r.repoId)),
    };
  });
}

/** 一个 PR 下次该查的时间：没读过的马上；合并、关闭的不再查。 */
export function nextPrCheckAt(pr: Pick<TicketPr, "state" | "checkedAt" | "ci">, sessionOpen: boolean): number {
  if (pr.checkedAt === 0) return 0;
  if (pr.state !== "open") return Infinity;
  return pr.checkedAt + (pr.ci === "pending" && sessionOpen ? PR_FAST_MS : PR_SLOW_MS);
}

/** 一个分支下次该查的时间。分支上有开着的 PR 时由 PR 的轮询接手（一个 head 分支同时只有一个开着的 PR）。 */
export function nextBranchCheckAt(row: BranchWatchRow | null, sessionOpen: boolean, hasOpenPr: boolean): number {
  if (hasOpenPr) return Infinity;
  if (!row) return 0;
  if (sessionOpen) return row.checkedAt + (row.ci === "pending" ? PR_FAST_MS : PR_SLOW_MS);
  return row.checkedAt + BRANCH_IDLE_MS;
}

/** 超出上限时先留 session 开着的，其余保持原来的顺序。 */
export function capRound<T extends { sessionOpen: boolean }>(items: T[]): T[] {
  return [...items.filter((t) => t.sessionOpen), ...items.filter((t) => !t.sessionOpen)].slice(0, PR_WATCH_MAX);
}
