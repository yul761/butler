import { existsSync } from "node:fs";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { combinedPr } from "../handoff/prs";
import { GitError, gitErrorSummary, isDirty, removeWorktree, unbranchedCommits } from "./git";
import type { TicketService } from "./ticket-service";

export type CleanupOutcome = { repoId: number; result: "removed" | "blocked" | "skipped"; reason?: string };

export interface CleanupDeps {
  tickets: TicketsRepo;
  ticketService: Pick<TicketService, "updating">;
  /** 这个仓库自己的 session 有终端在跑（总控不算：它改的东西都在 git 里）。 */
  repoBusy: (ticketKey: string, repoId: number) => boolean;
  now: () => number;
}

/** 最新一次完整 handoff 里的 PR 合起来看已经合并（多仓库 ticket 见 combinedPr）。 */
export function isMerged(handoffs: Pick<HandoffsRepo, "latestValid">, ticketKey: string): boolean {
  const p = handoffs.latestValid(ticketKey)?.payload;
  return !!p && combinedPr(p.prs)?.state === "merged";
}

/** 为什么这个 worktree 现在不能删；能删时返回 null。 */
async function blocker(d: CleanupDeps, ticketKey: string, repoId: number, dir: string): Promise<string | null> {
  if (d.repoBusy(ticketKey, repoId)) return "这个仓库的终端还在运行";
  // 被 .gitignore 忽略的文件（node_modules 之类）不算：git worktree remove 也不管它们。
  if (await isDirty(dir)) return "worktree 里有未提交的改动或未跟踪的文件";
  // 没 push 的提交不拦：本地分支保留，提交不会丢。只有游离 HEAD 上不属于任何分支的提交会随目录一起丢。
  if ((await unbranchedCommits(dir)) > 0) return "游离 HEAD 上有不在任何分支上的提交";
  return null;
}

/**
 * PR 合并后清理 ticket 的 worktree（设计文档 2026-10-26）：只处理 worktree 模式、还没清理过、目录还在的仓库。
 * 不安全的不删，把原因记在 cleanup_blocked 上给用户看；删掉的记 worktree_removed_at，分支保留，再开 session 时重建。
 * ticket 正在修改仓库时全部跳过，下次再试。
 */
export async function cleanupTicketWorktrees(d: CleanupDeps, ticketKey: string): Promise<CleanupOutcome[]> {
  const repos = d.tickets.listRepos(ticketKey).filter((r) => r.workMode === "worktree" && r.worktreeRemovedAt === null && r.worktreePath && existsSync(r.worktreePath));
  if (d.ticketService.updating(ticketKey)) return repos.map((r) => ({ repoId: r.id, result: "skipped" }));
  const out: CleanupOutcome[] = [];
  for (const r of repos) {
    const dir = r.worktreePath!;
    let reason: string | null;
    try {
      reason = await blocker(d, ticketKey, r.id, dir);
      if (!reason) await removeWorktree(r.repoPath, dir);
    } catch (e) {
      reason = e instanceof GitError ? `git 操作失败：${gitErrorSummary(e)}` : (e as Error).message;
    }
    if (reason) {
      d.tickets.setCleanupBlocked(r.id, reason);
      out.push({ repoId: r.id, result: "blocked", reason });
    } else {
      d.tickets.markWorktreeRemoved(r.id, d.now());
      d.tickets.setCleanupBlocked(r.id, null);
      out.push({ repoId: r.id, result: "removed" });
    }
  }
  return out;
}
