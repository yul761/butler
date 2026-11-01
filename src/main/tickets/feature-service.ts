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
  /** feature 改名、归档、恢复之后调用，参数是它所在的 epic（没有 epic 不调用）：epic 的 handoff 要跟着重新渲染。 */
  onEpicChanged?: (epicId: number) => void;
  now: () => number;
  /** 归档 feature 时连带归档的每个 ticket：清掉它的 MCP 配置文件。 */
  onTicketArchived?: (ticketKey: string) => void;
  /** 归档 epic 下的 feature 之前调用（FeatureSummaryRunner.refreshBeforeArchive）：有新活动的先生成汇总。 */
  refreshBeforeArchive?: (featureIds: number[]) => Promise<void>;
  log?: (msg: string, err?: unknown) => void;
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
  /** 正在归档（等汇总）的 feature：连点时共用同一次。 */
  private readonly archiving = new Map<number, Promise<void>>();

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

  /** epicId、brief：epic session 的 create_feature 一次建好；界面上建 feature 不带。 */
  async create(input: CreateFeatureInput & { epicId?: number; brief?: string }): Promise<Feature> {
    const name = FeatureService.checkName(input.name);
    const roots = await uniqueRoots(input.repoPaths);
    const workspaceDir = resolveWorkspaceDir(input.workspaceDir?.trim() || this.defaultWorkspace(roots, name), this.d.homeDir);
    if (this.d.features.byWorkspace(workspaceDir)) throw new TicketError("workspace_taken", M().workspaceTaken(workspaceDir));
    const now = this.d.now();
    const id = this.tx(() => {
      const fid = this.d.features.insert({ name, workspaceDir, createdAt: now, epicId: input.epicId, brief: input.brief });
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
    const f = this.get(featureId);
    this.epicChanged(f.epicId);
    return f;
  }

  /**
   * 归档 feature：属于 epic 时先生成汇总（失败、超时照样归档），再和它还没归档的 ticket 一起归档；有终端在跑时拒绝。
   * 汇总可能要等两分钟，terminalsOpen 是函数：等完再看一次，这期间可能开了终端。
   */
  async archive(featureId: number, opts: { terminalsOpen: () => boolean }): Promise<void> {
    if (!this.canArchive(featureId, opts.terminalsOpen)) return;
    const running = this.archiving.get(featureId);
    if (running) return running;
    const p = this.refreshBeforeArchive([this.get(featureId)])
      .then(() => {
        if (this.canArchive(featureId, opts.terminalsOpen)) this.archiveNow(featureId, this.d.now());
      })
      .finally(() => this.archiving.delete(featureId));
    this.archiving.set(featureId, p);
    return p;
  }

  /** 已归档（可能是等汇总时跟着 epic 归档的）返回 false；有终端在跑时拒绝。 */
  private canArchive(featureId: number, terminalsOpen: () => boolean): boolean {
    if (this.get(featureId).archivedAt !== null) return false;
    if (terminalsOpen()) throw new TicketError("sessions_open", M().featureTerminalsArchive);
    return true;
  }

  /** 给这些 feature 里属于 epic 的生成汇总（见 FeatureSummaryRunner.refreshBeforeArchive），永不 reject：不能卡住归档。 */
  async refreshBeforeArchive(features: Feature[]): Promise<void> {
    const ids = features.filter((f) => f.epicId !== null).map((f) => f.id);
    if (ids.length === 0) return;
    try {
      await this.d.refreshBeforeArchive?.(ids);
    } catch (e) {
      this.d.log?.(`feature summaries before archive failed: ${ids.join(", ")}`, e);
    }
  }

  /** 立刻归档，不跑汇总，不查终端：feature 和它还没归档的 ticket 用同一个时间戳 at。epic 归档时在自己的事务里调用。 */
  archiveNow(featureId: number, at: number): void {
    const f = this.get(featureId);
    if (f.archivedAt !== null) return;
    const keys = this.d.tickets.listByFeature(featureId).map((t) => t.key);
    this.tx(() => {
      for (const k of keys) this.d.tickets.archive(k, at);
      this.d.features.archive(featureId, at);
    });
    for (const k of keys) this.d.onTicketArchived?.(k);
    this.epicChanged(f.epicId);
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
    this.epicChanged(f.epicId);
  }

  private epicChanged(epicId: number | null): void {
    if (epicId === null) return;
    try {
      this.d.onEpicChanged?.(epicId);
    } catch {
      // 通知失败不能让改名、归档失败。
    }
  }

  private tx<T>(fn: () => T): T {
    return this.d.db ? withTransaction(this.d.db, fn) : fn();
  }
}
