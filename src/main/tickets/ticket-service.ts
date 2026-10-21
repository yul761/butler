import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CreateTicketInput, Ticket } from "../../shared/types";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import {
  addWorktree, branchExists, checkout, createBranch, currentBranch, GitError, gitErrorSummary, hasCommits, isDirty,
  isValidBranchName, repoRoot,
} from "./git";
import { isValidTicketKey, renderBranch } from "./ticket-key";

export type TicketErrorCode =
  | "invalid_key" | "exists" | "not_git_repo" | "worktree_exists" | "dirty" | "not_found"
  | "invalid_branch" | "empty_repo" | "git_failed";

export class TicketError extends Error {
  constructor(readonly code: TicketErrorCode, message: string) {
    super(message);
  }
}

/** git 命令失败转成带 code 的 TicketError，界面上显示 git 给出的原因而不是整段输出。 */
function asTicketError(e: unknown): unknown {
  return e instanceof GitError ? new TicketError("git_failed", `git 操作失败：${gitErrorSummary(e)}`) : e;
}

export type BranchCheck = { ok: true } | { ok: false; current: string; expected: string; dirty: boolean };

export interface TicketServiceDeps {
  tickets: TicketsRepo;
  settings: SettingsRepo;
  now: () => number;
}

export class TicketService {
  constructor(private readonly d: TicketServiceDeps) {}

  async create(input: CreateTicketInput): Promise<Ticket> {
    const key = input.key.trim().toUpperCase();
    if (!isValidTicketKey(key, this.d.settings.get("ticketPattern"))) throw new TicketError("invalid_key", `ticket 号格式不对：${input.key}`);
    if (this.d.tickets.get(key)) throw new TicketError("exists", `ticket ${key} 已经存在`);

    let root: string;
    try {
      root = await repoRoot(input.repoPath);
    } catch {
      throw new TicketError("not_git_repo", `${input.repoPath} 不是 git 仓库`);
    }

    if (!(await hasCommits(root))) throw new TicketError("empty_repo", "这个仓库还没有任何提交");

    const branch = input.branch?.trim() || renderBranch(this.d.settings.get("branchTemplate"), key);
    if (!(await isValidBranchName(root, branch))) throw new TicketError("invalid_branch", `分支名不合法：${branch}`);

    let worktreePath: string | null = null;
    try {
      if (input.workMode === "worktree") {
        worktreePath = join(dirname(root), `${basename(root)}-worktrees`, key);
        if (existsSync(worktreePath)) throw new TicketError("worktree_exists", `目录已存在：${worktreePath}`);
        await addWorktree(root, worktreePath, branch, !(await branchExists(root, branch)));
      } else if (!(await branchExists(root, branch))) {
        await createBranch(root, branch);
      }
    } catch (e) {
      throw asTicketError(e);
    }

    const ticket: Ticket = {
      key,
      title: input.title?.trim() || null,
      repoPath: root,
      workMode: input.workMode,
      worktreePath,
      branch,
      status: "active",
      statusManual: null,
      createdAt: this.d.now(),
      archivedAt: null,
    };
    this.d.tickets.insert(ticket);
    return ticket;
  }

  workDir(t: Ticket): string {
    return t.worktreePath ?? t.repoPath;
  }

  async checkBranch(t: Ticket): Promise<BranchCheck> {
    if (t.workMode === "worktree") return { ok: true };
    const current = await currentBranch(t.repoPath);
    if (current === t.branch) return { ok: true };
    return { ok: false, current, expected: t.branch, dirty: await isDirty(t.repoPath) };
  }

  async switchBranch(t: Ticket): Promise<void> {
    if (await isDirty(t.repoPath)) throw new TicketError("dirty", "工作区有未提交的改动，不会自动切换分支");
    try {
      await checkout(t.repoPath, t.branch);
    } catch (e) {
      throw asTicketError(e);
    }
  }
}
