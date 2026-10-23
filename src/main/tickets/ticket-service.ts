import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CreateTicketInput, Ticket, UpdateTicketInput } from "../../shared/types";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import {
  addWorktree, branchExists, checkout, createBranch, currentBranch, detachHead, GitError, gitErrorSummary, hasCommits, isDirty,
  isValidBranchName, isWorktreeOf, pruneWorktrees, repoRoot, switchTo,
} from "./git";
import { isValidTicketKey, renderBranch } from "./ticket-key";

export type TicketErrorCode =
  | "invalid_key" | "exists" | "archived" | "not_git_repo" | "worktree_exists" | "dirty" | "not_found"
  | "invalid_branch" | "empty_repo" | "git_failed" | "sessions_open" | "branch_checked_out";

export class TicketError extends Error {
  constructor(readonly code: TicketErrorCode, message: string) {
    super(message);
  }
}

/** git 命令失败转成带 code 的 TicketError，界面上显示 git 给出的原因而不是整段输出。 */
function asTicketError(e: unknown): unknown {
  return e instanceof GitError ? new TicketError("git_failed", `git 操作失败：${gitErrorSummary(e)}`) : e;
}

/** ticket 的 worktree 放在仓库旁边：<仓库>-worktrees/<ticket 号>。 */
function worktreePathFor(root: string, key: string): string {
  return join(dirname(root), `${basename(root)}-worktrees`, key);
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
    const existing = this.d.tickets.get(key);
    if (existing?.archivedAt != null) throw new TicketError("archived", `ticket ${key} 已经归档，可以在“已归档”里恢复`);
    if (existing) throw new TicketError("exists", `ticket ${key} 已经存在`);

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
        worktreePath = worktreePathFor(root, key);
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

  /**
   * 编辑 ticket。改标题随时可以；改工作方式或分支要动 git，这个 ticket 有终端在跑时拒绝（claude 的工作目录会被换掉）。
   * - worktree → 分支模式：worktree 先离开分支（detach），目录和文件原样保留，主仓库之后就能检出这个分支。
   * - 分支模式 → worktree：在 <仓库>-worktrees/<key> 建 worktree；那里已经是这个仓库的 worktree（以前改回分支模式留下的）就复用。
   * - 只改分支：worktree 模式在 worktree 里切过去，分支模式只记下新分支（下次打开 session 时照常检查、提示切换）。
   * 分支不存在就新建。有未提交改动的 worktree 一律不动。已有 session 的工作目录不变，仍在原来的目录里恢复。
   */
  async update(input: UpdateTicketInput, opts: { terminalsOpen: boolean }): Promise<Ticket> {
    const t = this.d.tickets.get(input.key);
    if (!t) throw new TicketError("not_found", `找不到 ticket ${input.key}`);
    const title = input.title === undefined ? t.title : input.title.trim() || null;
    const workMode = input.workMode ?? t.workMode;
    const branch = input.branch?.trim() || t.branch;
    let worktreePath = t.worktreePath;

    if (workMode !== t.workMode || branch !== t.branch) {
      if (opts.terminalsOpen) throw new TicketError("sessions_open", "这个 ticket 还有终端在运行，先在终端里退出 claude 再改工作方式或分支");
      const root = t.repoPath;
      if (!(await isValidBranchName(root, branch))) throw new TicketError("invalid_branch", `分支名不合法：${branch}`);
      try {
        const exists = await branchExists(root, branch);
        if (t.workMode === "worktree" && t.worktreePath && existsSync(t.worktreePath)) {
          if (await isDirty(t.worktreePath)) throw new TicketError("dirty", `worktree 里有未提交的改动：${t.worktreePath}`);
          if (workMode === "worktree") {
            await switchTo(t.worktreePath, branch, !exists);
          } else {
            await detachHead(t.worktreePath);
            if (!exists) await createBranch(root, branch);
            worktreePath = null;
          }
        } else if (workMode === "worktree") {
          worktreePath = await this.attachWorktree(root, t.key, branch, exists);
        } else {
          if (!exists) await createBranch(root, branch);
          worktreePath = null;
        }
      } catch (e) {
        throw asTicketError(e);
      }
    }

    const updated: Ticket = { ...t, title, workMode, worktreePath, branch };
    this.d.tickets.update(updated);
    return updated;
  }

  /** 分支模式改成 worktree（或者原来的 worktree 目录不见了）：建一个新的，或者复用这个 ticket 以前留下的。 */
  private async attachWorktree(root: string, key: string, branch: string, exists: boolean): Promise<string> {
    const path = worktreePathFor(root, key);
    if (exists && (await currentBranch(root)) === branch) {
      throw new TicketError("branch_checked_out", `主仓库现在就在 ${branch} 上，git 不允许同一个分支同时检出两次。先把主仓库切到别的分支再改成 worktree`);
    }
    if (existsSync(path)) {
      if (!(await isWorktreeOf(root, path))) throw new TicketError("worktree_exists", `目录已存在：${path}`);
      if (await isDirty(path)) throw new TicketError("dirty", `worktree 里有未提交的改动：${path}`);
      await switchTo(path, branch, !exists);
    } else {
      await pruneWorktrees(root);
      await addWorktree(root, path, branch, !exists);
    }
    return path;
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
