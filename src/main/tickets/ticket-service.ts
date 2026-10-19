import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CreateTicketInput, Ticket } from "../../shared/types";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { addWorktree, branchExists, checkout, createBranch, currentBranch, isDirty, repoRoot } from "./git";
import { isValidTicketKey, renderBranch } from "./ticket-key";

export type TicketErrorCode = "invalid_key" | "exists" | "not_git_repo" | "worktree_exists" | "dirty" | "not_found";

export class TicketError extends Error {
  constructor(readonly code: TicketErrorCode, message: string) {
    super(message);
  }
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

    const branch = input.branch?.trim() || renderBranch(this.d.settings.get("branchTemplate"), key);
    let worktreePath: string | null = null;
    if (input.workMode === "worktree") {
      worktreePath = join(dirname(root), `${basename(root)}-worktrees`, key);
      if (existsSync(worktreePath)) throw new TicketError("worktree_exists", `目录已存在：${worktreePath}`);
      await addWorktree(root, worktreePath, branch, !(await branchExists(root, branch)));
    } else if (!(await branchExists(root, branch))) {
      await createBranch(root, branch);
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
    await checkout(t.repoPath, t.branch);
  }
}
