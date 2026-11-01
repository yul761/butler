import type { Epic, EpicRepo } from "../../shared/types";
import { withTransaction, type Db } from "../db/database";
import type { EpicsRepo } from "../db/epics-repo";
import type { FeaturesRepo } from "../db/features-repo";
import { M } from "../strings";
import type { FeatureService } from "../tickets/feature-service";
import { samePath, TicketError } from "../tickets/ticket-service";
import { checkNameLimit, defaultWorkspaceDir, gitRootOf, resolveWorkspaceDir, uniqueRoots } from "../tickets/workspace";

export interface EpicServiceDeps {
  epics: EpicsRepo;
  features: FeaturesRepo;
  /** 归档 / 恢复 epic 下的 feature 时走它，和单独归档 feature 的做法（连带 ticket）完全一致。 */
  featureService: FeatureService;
  now: () => number;
  /** 给了就把多步写入放进一个事务。 */
  db?: Db;
  /** 展开工作区路径里的 ~（测试注入；默认是用户目录）。 */
  homeDir?: string;
}

/** epic 名最长多少字。 */
export const EPIC_NAME_LIMIT = 100;

export interface CreateEpicInput {
  name: string;
  repoPaths: string[];
  workspaceDir?: string;
}

/**
 * epic（设计文档 2026-11-01）：feature 之上的一层，有自己的工作区和仓库列表。
 * 这里只管 epic 本身和 feature 的归属；feature 的工作区、worktree 不动。
 */
export class EpicService {
  constructor(private readonly d: EpicServiceDeps) {}

  get(id: number): Epic {
    const e = this.d.epics.get(id);
    if (!e) throw new TicketError("not_found", M().epicNotFound);
    return e;
  }

  listArchived(): Epic[] {
    return this.d.epics.listArchived();
  }

  /** ~/Code/shop/frontend → ~/Code/shop-epics/<名字>。 */
  defaultWorkspace(repoPaths: string[], name: string): string {
    return defaultWorkspaceDir(repoPaths, name, "epics");
  }

  private static checkName(name: string): string {
    return checkNameLimit(name, EPIC_NAME_LIMIT, M().epicNameInvalid(EPIC_NAME_LIMIT));
  }

  /** 检查仓库是 git 仓库要跑 git，所以是异步的。 */
  async create(input: CreateEpicInput): Promise<Epic> {
    const name = EpicService.checkName(input.name);
    const roots = await uniqueRoots(input.repoPaths);
    const workspaceDir = resolveWorkspaceDir(input.workspaceDir?.trim() || this.defaultWorkspace(roots, name), this.d.homeDir);
    if (this.d.epics.byWorkspace(workspaceDir)) throw new TicketError("workspace_taken", M().epicWorkspaceTaken(workspaceDir));
    const now = this.d.now();
    const id = this.tx(() => {
      const eid = this.d.epics.insert({ name, workspaceDir, createdAt: now });
      for (const r of roots) this.d.epics.addRepo(eid, r, now);
      return eid;
    });
    return this.get(id);
  }

  /** 改名字不改工作区目录。 */
  rename(epicId: number, name: string): Epic {
    this.get(epicId);
    this.d.epics.setName(epicId, EpicService.checkName(name));
    return this.get(epicId);
  }

  async addRepo(epicId: number, repoPath: string): Promise<EpicRepo> {
    const e = this.get(epicId);
    const root = await gitRootOf(repoPath);
    if (e.repos.some((r) => samePath(r.repoPath, root))) throw new TicketError("repo_exists", M().epicHasRepo(root));
    return this.d.epics.getRepo(this.d.epics.addRepo(epicId, root, this.d.now()))!;
  }

  /** 只影响以后 epic 能选的仓库；feature 里已有的仓库不动。 */
  removeRepo(epicRepoId: number): void {
    if (!this.d.epics.getRepo(epicRepoId)) throw new TicketError("not_found", M().repoNotFound);
    this.d.epics.removeRepo(epicRepoId);
  }

  /**
   * epic 和它还没归档的 feature（连同这些 feature 下还没归档的 ticket）用同一个时间戳归档；之前单独归档的保持原样。
   * 和归档 feature 一样，有终端在跑时整个拒绝（先检查，不会归档一半）：epic 自己的 session，或任何一个要归档的 feature 的终端。
   */
  archive(epicId: number, opts: { terminalsOpen: boolean; featureTerminalsOpen: (featureId: number) => boolean }): void {
    const e = this.get(epicId);
    if (e.archivedAt !== null) return;
    const live = this.d.features.listByEpic(epicId);
    if (opts.terminalsOpen || live.some((f) => opts.featureTerminalsOpen(f.id))) throw new TicketError("sessions_open", M().epicTerminalsArchive);
    const now = this.d.now();
    this.tx(() => {
      for (const f of live) this.d.featureService.archive(f.id, { terminalsOpen: false, at: now });
      this.d.epics.archive(epicId, now);
    });
  }

  /** 恢复 epic，以及和它一起归档的 feature（时间戳相同的；之前单独归档的保持归档）。每个 feature 的恢复交给 FeatureService（连带 ticket）。 */
  unarchive(epicId: number): void {
    const e = this.get(epicId);
    if (e.archivedAt === null) return;
    const together = this.d.features.listByEpic(epicId, { includeArchived: true }).filter((f) => f.archivedAt === e.archivedAt);
    this.tx(() => {
      for (const f of together) this.d.featureService.unarchive(f.id);
      this.d.epics.unarchive(epicId);
    });
  }

  /**
   * 只改 feature 的归属，不动工作区和 worktree。epicId 为 null：移出（不从原 epic 删仓库）。
   * 目标 epic 没有的仓库自动加进去，这样 epic session 总能读到这些代码。已归档的 epic 不能移入。
   */
  moveFeature(featureId: number, epicId: number | null): void {
    const f = this.d.features.get(featureId);
    if (!f) throw new TicketError("not_found", M().featureNotFound);
    if (epicId === null) {
      this.d.features.setEpic(featureId, null);
      return;
    }
    const e = this.get(epicId);
    if (e.archivedAt !== null) throw new TicketError("epic_archived", M().epicArchivedNoMove(e.name));
    this.tx(() => {
      this.d.features.setEpic(featureId, epicId);
      for (const r of f.repos) this.addMissingRepo(e, r.repoPath);
    });
  }

  /** feature 加了仓库之后调用：feature 属于某个 epic、而 epic 没有这个仓库时加进去。 */
  ensureFeatureRepo(featureId: number, repoPath: string): void {
    const f = this.d.features.get(featureId);
    if (!f || f.epicId === null) return;
    const e = this.d.epics.get(f.epicId);
    if (e) this.addMissingRepo(e, repoPath);
  }

  private addMissingRepo(epic: Epic, repoPath: string): void {
    if (epic.repos.some((r) => samePath(r.repoPath, repoPath))) return;
    this.d.epics.addRepo(epic.id, repoPath, this.d.now());
  }

  private tx<T>(fn: () => T): T {
    return this.d.db ? withTransaction(this.d.db, fn) : fn();
  }
}
