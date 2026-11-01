import type { CreateFeatureInput, Feature, FeatureRepo } from "../../shared/types";
import { withTransaction, type Db } from "../db/database";
import type { EpicsRepo } from "../db/epics-repo";
import type { FeaturesRepo } from "../db/features-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { checkNameLimit, defaultWorkspaceDir, gitRootOf, resolveWorkspaceDir, uniqueRoots } from "./workspace";
import { samePath, TicketError } from "./ticket-service";
import { M } from "../strings";

export interface FeatureServiceDeps {
  features: FeaturesRepo;
  tickets: TicketsRepo;
  /** 恢复 feature 时，它所在的 epic 如果已归档，一并恢复。 */
  epics?: EpicsRepo;
  /** feature 加了仓库之后调用（让 epic 补上这个仓库）。 */
  onRepoAdded?: (featureId: number, repoPath: string) => void;
  now: () => number;
  /** 归档 feature 时连带归档的每个 ticket：清掉它的 MCP 配置文件。 */
  onTicketArchived?: (ticketKey: string) => void;
  /** 给了就把归档 / 恢复放进一个事务。 */
  db?: Db;
  /** 展开工作区路径里的 ~（测试注入；默认是用户目录）。 */
  homeDir?: string;
}

/** feature 名最长多少字。 */
export const FEATURE_NAME_LIMIT = 100;

/**
 * feature（设计文档 2026-10-26）：一组 ticket 加一个工作区目录。这里只管 feature 本身；feature 下的 ticket 由 TicketService 建，
 * worktree 放在工作区里。
 */
export class FeatureService {
  constructor(private readonly d: FeatureServiceDeps) {}

  get(id: number): Feature {
    const f = this.d.features.get(id);
    if (!f) throw new TicketError("not_found", M().featureNotFound);
    return f;
  }

  listArchived(): Feature[] {
    return this.d.features.listArchived();
  }

  /** 工作区默认放在仓库上一层的旁边：~/Code/shop/frontend → ~/Code/shop-features/<名字>。 */
  defaultWorkspace(repoPaths: string[], name: string): string {
    return defaultWorkspaceDir(repoPaths, name, "features");
  }

  private static checkName(name: string): string {
    return checkNameLimit(name, FEATURE_NAME_LIMIT, M().featureNameInvalid(FEATURE_NAME_LIMIT));
  }

  async create(input: CreateFeatureInput): Promise<Feature> {
    const name = FeatureService.checkName(input.name);
    const roots = await uniqueRoots(input.repoPaths);
    const workspaceDir = resolveWorkspaceDir(input.workspaceDir?.trim() || this.defaultWorkspace(roots, name), this.d.homeDir);
    if (this.d.features.byWorkspace(workspaceDir)) throw new TicketError("workspace_taken", M().workspaceTaken(workspaceDir));
    const now = this.d.now();
    const id = this.tx(() => {
      const fid = this.d.features.insert({ name, workspaceDir, createdAt: now });
      for (const r of roots) this.d.features.addRepo(fid, r, now);
      return fid;
    });
    return this.get(id);
  }

  async addRepo(featureId: number, repoPath: string): Promise<FeatureRepo> {
    const f = this.get(featureId);
    const root = await gitRootOf(repoPath);
    if (f.repos.some((r) => samePath(r.repoPath, root))) throw new TicketError("repo_exists", M().featureHasRepo(root));
    const added = this.d.features.getRepo(this.d.features.addRepo(featureId, root, this.d.now()))!;
    this.d.onRepoAdded?.(featureId, root);
    return added;
  }

  /** 只影响以后建 ticket 时的选项；已有 ticket 的仓库、磁盘上的东西都不动。 */
  removeRepo(featureRepoId: number): void {
    if (!this.d.features.getRepo(featureRepoId)) throw new TicketError("not_found", M().repoNotFound);
    this.d.features.removeRepo(featureRepoId);
  }

  /** 改名字不改工作区目录（里面已经有 worktree 了）。 */
  rename(featureId: number, name: string): Feature {
    this.get(featureId);
    this.d.features.setName(featureId, FeatureService.checkName(name));
    return this.get(featureId);
  }

  /** feature 和它还没归档的 ticket 用同一个时间戳归档；有终端在跑时拒绝。 */
  archive(featureId: number, opts: { terminalsOpen: boolean }): void {
    const f = this.get(featureId);
    if (f.archivedAt !== null) return;
    if (opts.terminalsOpen) throw new TicketError("sessions_open", M().featureTerminalsArchive);
    const now = this.d.now();
    const keys = this.d.tickets.listByFeature(featureId).map((t) => t.key);
    this.tx(() => {
      for (const k of keys) this.d.tickets.archive(k, now);
      this.d.features.archive(featureId, now);
    });
    for (const k of keys) this.d.onTicketArchived?.(k);
  }

  /** 恢复 feature，以及和它一起归档的 ticket（之前单独归档的保持归档）；它的 epic 已归档时只恢复 epic 本身，epic 下别的 feature 不动。 */
  unarchive(featureId: number): void {
    const f = this.get(featureId);
    if (f.archivedAt === null) return;
    const keys = this.d.tickets.listByFeature(featureId, { includeArchived: true }).filter((t) => t.archivedAt === f.archivedAt).map((t) => t.key);
    this.tx(() => {
      for (const k of keys) this.d.tickets.unarchive(k);
      this.d.features.unarchive(featureId);
      const epic = f.epicId === null ? null : this.d.epics?.get(f.epicId);
      if (epic && epic.archivedAt !== null) this.d.epics!.unarchive(epic.id);
    });
  }

  private tx<T>(fn: () => T): T {
    return this.d.db ? withTransaction(this.d.db, fn) : fn();
  }
}
