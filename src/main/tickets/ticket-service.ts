import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AddRepoInput, CreateTicketInput, Ticket, TicketRepo, UpdateRepoInput, WorkMode } from "../../shared/types";
import type { FeaturesRepo } from "../db/features-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { ticketFileStem } from "../util/ticket-file";
import {
  addWorktree, branchExists, checkout, createBranch, currentBranch, detachHead, GitError, gitErrorSummary, hasCommits, isDirty,
  isValidBranchName, isWorktreeOf, pruneWorktrees, repoRoot, switchTo, unbranchedCommits,
} from "./git";
import { isValidTicketKey, renderBranch } from "./ticket-key";
import { M } from "../strings";

export type TicketErrorCode =
  | "invalid_key" | "exists" | "archived" | "not_git_repo" | "worktree_exists" | "dirty" | "not_found"
  | "invalid_branch" | "empty_repo" | "git_failed" | "sessions_open" | "branch_checked_out" | "busy" | "unbranched_commits"
  | "repo_exists" | "invalid_name" | "workspace_taken" | "invalid_workspace";

export class TicketError extends Error {
  constructor(readonly code: TicketErrorCode, message: string) {
    super(message);
  }
}

/** git 命令失败转成带 code 的 TicketError，界面上显示 git 给出的原因而不是整段输出。 */
function asTicketError(e: unknown): unknown {
  return e instanceof GitError ? new TicketError("git_failed", M().gitFailed(gitErrorSummary(e))) : e;
}

/** 单独 ticket 的 worktree 放在仓库旁边：<仓库>-worktrees/<ticket 号>。 */
function worktreePathFor(root: string, key: string): string {
  return join(dirname(root), `${basename(root)}-worktrees`, key);
}

/** feature 下 ticket 的 worktree 放在工作区里：<工作区>/<仓库名>-<小写 ticket 号>（设计文档 2026-10-26）。 */
function featureWorktreePath(workspaceDir: string, root: string, key: string): string {
  return join(workspaceDir, `${basename(root)}-${ticketFileStem(key).toLowerCase()}`);
}

/** 后台 claude 的目录：cwd 加上 --add-dir；repoDirs 是这个 ticket 现有的全部仓库工作目录。 */
export interface HeadlessDirs {
  cwd: string;
  addDirs: string[];
  repoDirs: string[];
}

export type BranchCheck = { ok: true } | { ok: false; current: string; expected: string; dirty: boolean };

export interface TicketServiceDeps {
  tickets: TicketsRepo;
  /** feature（设计文档 2026-10-26）；不给就没有 feature 下的 ticket。 */
  features?: FeaturesRepo;
  settings: SettingsRepo;
  now: () => number;
  /** 总控 session 的工作区目录放在这里面（~/.butler/workspaces）。 */
  workspacesDir: string;
}


const norm = (p: string) => {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};

/** 同一个目录（Windows 不分大小写）。 */
export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** child 是 parent 本身或在它里面。 */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * feature 的工作区之外还要 --add-dir 的目录：不在工作区里面、目录存在的，去重。
 * 总控 session 和后台 claude 共用；same、exists 可以换成调用方自己的（平台、测试注入）。
 */
export function dirsOutsideWorkspace(
  dirs: string[],
  workspaceDir: string,
  o: { same?: (a: string, b: string) => boolean; exists?: (dir: string) => boolean } = {},
): string[] {
  const same = o.same ?? samePath;
  const exists = o.exists ?? existsSync;
  const out: string[] = [];
  for (const dir of dirs) {
    if (isInside(dir, workspaceDir) || out.some((d) => same(d, dir)) || !exists(dir)) continue;
    out.push(dir);
  }
  return out;
}

export class TicketService {
  /** 正在改仓库的 ticket：期间不能再改，也不能打开 session（目录可能正被切换）。 */
  private readonly updatingKeys = new Set<string>();

  constructor(private readonly d: TicketServiceDeps) {}

  updating(key: string): boolean {
    return this.updatingKeys.has(key);
  }

  /** 同一个 ticket 的仓库改动（包括合并后的清理）一次只做一个；已经有一个在做时抛 busy。 */
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.updatingKeys.has(key)) throw new TicketError("busy", M().ticketBusy);
    this.updatingKeys.add(key);
    try {
      return await fn();
    } finally {
      this.updatingKeys.delete(key);
    }
  }

  private ticket(key: string): Ticket {
    const t = this.d.tickets.get(key);
    if (!t) throw new TicketError("not_found", M().ticketNotFound(key));
    return t;
  }

  repo(id: number): TicketRepo {
    const r = this.d.tickets.getRepo(id);
    if (!r) throw new TicketError("not_found", M().repoNotFound);
    return r;
  }

  /**
   * 新 ticket。仓库可以不填（之后再添加）；填了就和添加仓库一样建 worktree / 分支，可以一次填好几个。
   * 建在 feature 下时 worktree 放进 feature 的工作区。任何一个仓库失败都不建 ticket（已经建好的 worktree 留着，下次复用）。
   */
  async create(input: CreateTicketInput): Promise<Ticket> {
    const key = input.key.trim().toUpperCase();
    if (!isValidTicketKey(key, this.d.settings.get("ticketPattern"))) throw new TicketError("invalid_key", M().invalidKey(input.key));
    const existing = this.d.tickets.get(key);
    if (existing?.archivedAt != null) throw new TicketError("archived", M().ticketArchived(key));
    if (existing) throw new TicketError("exists", M().ticketExists(key));
    const featureId = input.featureId ?? null;
    if (featureId !== null) {
      const f = this.d.features?.get(featureId);
      if (!f) throw new TicketError("not_found", M().featureNotFound);
      if (f.archivedAt !== null) throw new TicketError("archived", M().featureArchived(f.name));
    }

    const now = this.d.now();
    const paths = (input.repoPaths ?? (input.repoPath ? [input.repoPath] : [])).map((p) => p.trim()).filter(Boolean);
    const repos: Awaited<ReturnType<TicketService["prepareRepo"]>>[] = [];
    for (const repoPath of paths) {
      repos.push(await this.prepareRepo(key, repos, { repoPath, workMode: input.workMode ?? "worktree", branch: input.branch, title: input.title }, featureId));
    }
    const [first, ...rest] = repos.map((r) => ({ ...r, ticketKey: key, createdAt: now }));
    this.d.tickets.insert(
      { key, title: input.title?.trim() || null, status: "active", statusManual: null, createdAt: now, archivedAt: null, featureId },
      first,
    );
    for (const r of rest) this.d.tickets.addRepo(r);
    return this.ticket(key);
  }

  /** 给 ticket 加一个仓库：和新建 ticket 时一样校验、建 worktree / 分支。 */
  async addRepo(input: AddRepoInput): Promise<TicketRepo> {
    const t = this.ticket(input.ticketKey);
    if (t.archivedAt !== null) throw new TicketError("archived", M().ticketArchivedAddRepo(t.key));
    return this.exclusive(t.key, async () => {
      const prepared = await this.prepareRepo(t.key, t.repos, { ...input, title: t.title }, t.featureId);
      const id = this.d.tickets.addRepo({ ...prepared, ticketKey: t.key, createdAt: this.d.now() });
      return this.repo(id);
    });
  }

  /**
   * 解除仓库和 ticket 的关联：磁盘上的 worktree 和分支不动。这个仓库（或总控）有终端在跑时拒绝。
   */
  removeRepo(id: number, opts: { terminalsOpen: boolean }): void {
    const r = this.repo(id);
    if (this.updatingKeys.has(r.ticketKey)) throw new TicketError("busy", M().ticketBusy);
    if (opts.terminalsOpen) throw new TicketError("sessions_open", M().repoTerminalsRemove);
    this.d.tickets.removeRepo(id);
  }

  /** 校验仓库并建好 worktree / 分支，返回要存的字段。 */
  private async prepareRepo(
    key: string,
    existing: Pick<TicketRepo, "repoPath">[],
    input: { repoPath: string; workMode: WorkMode; branch?: string; title?: string | null },
    featureId: number | null,
  ): Promise<Pick<TicketRepo, "repoPath" | "workMode" | "worktreePath" | "branch">> {
    let root: string;
    try {
      root = await repoRoot(input.repoPath);
    } catch {
      throw new TicketError("not_git_repo", M().notGitRepo(input.repoPath));
    }
    if (existing.some((r) => samePath(r.repoPath, root))) throw new TicketError("repo_exists", M().ticketHasRepo(root));
    if (!(await hasCommits(root))) throw new TicketError("empty_repo", M().emptyRepo);

    const branch = input.branch?.trim() || renderBranch(this.d.settings.get("branchTemplate"), key, input.title);
    if (!(await isValidBranchName(root, branch))) throw new TicketError("invalid_branch", M().invalidBranch(branch));

    let worktreePath: string | null = null;
    try {
      const exists = await branchExists(root, branch);
      const leftover = this.worktreePath(key, featureId, root);
      if (input.workMode === "worktree") {
        // 以前移除（或改成分支模式）时留下的 worktree：干净的就接着用。
        worktreePath = await this.attachWorktree(root, leftover, branch, exists);
      } else {
        // 留下的 worktree 还占着这个分支：先让它离开，主仓库之后才能检出（没有改动、没有游离提交时）。
        if (exists && existsSync(leftover) && (await isWorktreeOf(root, leftover)) && (await currentBranch(leftover)) === branch) {
          if (await isDirty(leftover)) throw new TicketError("dirty", M().worktreeDirty(leftover));
          await detachHead(leftover);
        }
        if (!exists) await createBranch(root, branch);
      }
    } catch (e) {
      throw asTicketError(e);
    }
    return { repoPath: root, workMode: input.workMode, worktreePath, branch };
  }

  setTitle(key: string, title: string): Ticket {
    this.ticket(key);
    this.d.tickets.setTitle(key, title.trim() || null);
    return this.ticket(key);
  }

  /**
   * 改一个仓库的工作方式或分支。这个仓库（或总控）有终端在跑时拒绝（claude 的工作目录会被换掉）。
   * - worktree → 分支模式：worktree 先离开分支（detach），目录和文件原样保留，主仓库之后就能检出这个分支。
   * - 分支模式 → worktree：在 <仓库>-worktrees/<key> 建 worktree；那里已经是这个仓库的 worktree（以前改回分支模式留下的）就复用。
   * - 只改分支：worktree 模式在 worktree 里切过去，分支模式只记下新分支（下次打开 session 时照常检查、提示切换）。
   * 分支不存在就新建。有未提交改动的 worktree 一律不动。已有 session 的工作目录不变，仍在原来的目录里恢复。
   */
  async updateRepo(input: UpdateRepoInput, opts: { terminalsOpen: boolean }): Promise<TicketRepo> {
    const r = this.repo(input.repoId);
    const workMode = input.workMode ?? r.workMode;
    const branch = input.branch?.trim() || r.branch;
    if (workMode === r.workMode && branch === r.branch) return r;
    if (opts.terminalsOpen) throw new TicketError("sessions_open", M().repoTerminalsEdit);
    return this.exclusive(r.ticketKey, async () => {
      const worktreePath = await this.moveWork(r, workMode, branch);
      const updated: TicketRepo = { ...r, workMode, worktreePath, branch };
      this.d.tickets.updateRepo(updated);
      return updated;
    });
  }

  /** updateRepo 的 git 部分，返回新的 worktree 路径（分支模式是 null）。新分支从仓库原来的分支开始。 */
  private async moveWork(t: TicketRepo, workMode: WorkMode, branch: string): Promise<string | null> {
    const root = t.repoPath;
    if (!(await isValidBranchName(root, branch))) throw new TicketError("invalid_branch", M().invalidBranch(branch));
    try {
      const exists = await branchExists(root, branch);
      const start = branch !== t.branch && (await branchExists(root, t.branch)) ? t.branch : undefined;
      if (t.workMode === "worktree" && t.worktreePath && existsSync(t.worktreePath)) {
        if (await isDirty(t.worktreePath)) throw new TicketError("dirty", M().worktreeDirty(t.worktreePath));
        await this.refuseUnbranched(t.worktreePath);
        if (workMode === "worktree") {
          await switchTo(t.worktreePath, branch, !exists, start);
          return t.worktreePath;
        }
        await detachHead(t.worktreePath);
        if (!exists) await createBranch(root, branch, start);
        return null;
      }
      // 手动删掉的 worktree 还登记着、占着分支：先清掉登记，主仓库才能检出这个分支。
      if (t.workMode === "worktree") await pruneWorktrees(root);
      if (workMode === "worktree") return await this.attachWorktree(root, this.worktreePath(t.ticketKey, this.featureOf(t.ticketKey), root), branch, exists, start);
      if (!exists) await createBranch(root, branch, start);
      return null;
    } catch (e) {
      throw asTicketError(e);
    }
  }

  /** 游离 HEAD 上有不属于任何分支的提交：切走就只剩 reflog 能找到，拒绝。 */
  private async refuseUnbranched(dir: string): Promise<void> {
    const n = await unbranchedCommits(dir);
    if (n > 0) {
      throw new TicketError("unbranched_commits", M().unbranchedCommits(dir, n));
    }
  }

  /** ticket 在这个仓库里的 worktree 放在哪：feature 下的放进工作区，否则在仓库旁边。 */
  private worktreePath(key: string, featureId: number | null, root: string): string {
    const f = featureId === null ? null : this.d.features?.get(featureId);
    return f ? featureWorktreePath(f.workspaceDir, root, key) : worktreePathFor(root, key);
  }

  private featureOf(key: string): number | null {
    return this.d.tickets.get(key)?.featureId ?? null;
  }

  /** feature 总控的工作目录：feature 的工作区（不在就建）。 */
  featureWorkspaceDir(featureId: number): string {
    const f = this.d.features?.get(featureId);
    if (!f) throw new TicketError("not_found", M().featureNotFound);
    mkdirSync(f.workspaceDir, { recursive: true });
    return f.workspaceDir;
  }

  /** feature 下未归档 ticket 的全部仓库工作目录（去重）。 */
  featureWorkDirs(featureId: number): string[] {
    const dirs: string[] = [];
    for (const t of this.d.tickets.listByFeature(featureId)) {
      for (const r of t.repos) {
        const dir = this.workDir(r);
        if (!dirs.some((d) => samePath(d, dir))) dirs.push(dir);
      }
    }
    return dirs;
  }

  /** feature 汇总的后台 claude：在工作区里跑，工作区外的仓库目录各一个 --add-dir（同总控 session）。 */
  featureHeadlessDirs(featureId: number): HeadlessDirs {
    const cwd = this.featureWorkspaceDir(featureId);
    const repoDirs = this.featureWorkDirs(featureId);
    return { cwd, addDirs: dirsOutsideWorkspace(repoDirs, cwd), repoDirs };
  }

  /** 分支模式改成 worktree（或者原来的 worktree 目录不见了）：在 path 建一个新的，或者复用这个 ticket 以前留下的。 */
  private async attachWorktree(root: string, path: string, branch: string, exists: boolean, start?: string): Promise<string> {
    if (exists && (await currentBranch(root)) === branch) {
      throw new TicketError("branch_checked_out", M().branchCheckedOut(branch));
    }
    if (existsSync(path)) {
      if (!(await isWorktreeOf(root, path))) throw new TicketError("worktree_exists", M().dirExists(path));
      if (await isDirty(path)) throw new TicketError("dirty", M().worktreeDirty(path));
      await this.refuseUnbranched(path);
      await switchTo(path, branch, !exists, start);
    } else {
      await pruneWorktrees(root);
      await addWorktree(root, path, branch, !exists, start);
    }
    return path;
  }

  /**
   * PR 合并后被自动清理的 worktree（设计文档 2026-10-26）：在原来的路径上从保留的分支重建，分支不在了就从仓库当前 HEAD 新建。
   * 没被清理过就原样返回。
   */
  async ensureWorktree(r: TicketRepo): Promise<TicketRepo> {
    if (r.worktreeRemovedAt === null || r.workMode !== "worktree" || !r.worktreePath) return r;
    const path = r.worktreePath;
    return this.exclusive(r.ticketKey, async () => {
      try {
        if (!existsSync(path)) {
          await pruneWorktrees(r.repoPath);
          await addWorktree(r.repoPath, path, r.branch, !(await branchExists(r.repoPath, r.branch)));
        } else if (!(await isWorktreeOf(r.repoPath, path))) {
          // 清理之后有人在原来的位置写了文件（比如 feature 总控），那里已经不是 worktree：不接管它，免得 claude 在一个普通目录里干活。
          throw new TicketError("worktree_exists", M().notAWorktreeAnymore(path));
        }
      } catch (e) {
        throw asTicketError(e);
      }
      this.d.tickets.markWorktreeRemoved(r.id, null);
      this.d.tickets.setCleanupBlocked(r.id, null);
      return this.repo(r.id);
    });
  }

  /** 仓库的工作目录：worktree，或者仓库本身。 */
  workDir(r: TicketRepo): string {
    return r.worktreePath ?? r.repoPath;
  }

  /** 总控 session 的工作区目录（Butler 建的空目录）：~/.butler/workspaces/<ticket>。 */
  workspaceDir(ticketKey: string): string {
    const dir = this.workspacePath(ticketKey);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 同上，但不建目录。 */
  workspacePath(ticketKey: string): string {
    return join(this.d.workspacesDir, ticketFileStem(ticketKey));
  }

  /** hook 发现的 session 在这个 ticket 的哪个仓库里、是不是总控（在工作区目录里）。 */
  placement(ticketKey: string, cwd: string): { repoId: number | null; coordinator: boolean } {
    if (samePath(cwd, this.workspacePath(ticketKey))) return { repoId: null, coordinator: true };
    const t = this.d.tickets.get(ticketKey);
    return { repoId: (t && this.repoForCwd(t, cwd)?.id) ?? null, coordinator: false };
  }

  /**
   * 后台 claude（刷新、handoff）在哪里跑：第一个仓库的工作目录（项目级 MCP，如 Jira / GitHub，在那里找得到），
   * 其余仓库各一个 --add-dir。没有仓库时在工作区目录里。
   */
  headlessDirs(t: Ticket): HeadlessDirs {
    const repoDirs = t.repos.map((r) => this.workDir(r)).filter((d) => existsSync(d));
    if (repoDirs.length === 0) return { cwd: this.workspaceDir(t.key), addDirs: [], repoDirs };
    return { cwd: repoDirs[0], addDirs: repoDirs.slice(1), repoDirs };
  }

  /**
   * 找出 cwd 属于哪个仓库（认领、hook 发现的 session 用）：在仓库的工作目录或仓库本身里面都算；
   * 有嵌套时取最深的那个。
   */
  repoForCwd(t: Ticket, cwd: string): TicketRepo | null {
    let best: { repo: TicketRepo; depth: number } | null = null;
    for (const r of t.repos) {
      for (const dir of [this.workDir(r), r.repoPath]) {
        if (isInside(cwd, dir) && (!best || dir.length > best.depth)) best = { repo: r, depth: dir.length };
      }
    }
    return best?.repo ?? null;
  }

  async checkBranch(r: TicketRepo): Promise<BranchCheck> {
    if (r.workMode === "worktree") return { ok: true };
    const current = await currentBranch(r.repoPath);
    if (current === r.branch) return { ok: true };
    return { ok: false, current, expected: r.branch, dirty: await isDirty(r.repoPath) };
  }

  async switchBranch(r: TicketRepo): Promise<void> {
    if (this.updatingKeys.has(r.ticketKey)) throw new TicketError("busy", M().ticketBusy);
    if (await isDirty(r.repoPath)) throw new TicketError("dirty", M().repoDirtyNoSwitch);
    try {
      await checkout(r.repoPath, r.branch);
    } catch (e) {
      throw asTicketError(e);
    }
  }
}
