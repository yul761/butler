import { realpathSync } from "node:fs";
import type { CreateFeatureInput, Feature, FeatureRepo } from "../../shared/types";
import { withTransaction, type Db } from "../db/database";
import type { FeaturesRepo } from "../db/features-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { checkNameLimit, defaultWorkspaceDir, gitRootOf, resolveWorkspaceDir, uniqueRoots } from "./workspace";
import { samePath, TicketError } from "./ticket-service";
import { M } from "../strings";

export interface FeatureServiceDeps {
  features: FeaturesRepo;
  tickets: TicketsRepo;
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
    return defaultWorkspaceDir(repoPaths, name);
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

  /**
   * 从 Jira 接进来的 ticket 所属的 epic（BTL-246 §7，内部是 feature）：按 Jira epic 的 key 找没归档的那个，没有就新建一个
   * （名字「KEY 标题」，工作区用默认的；以前那个归档了也新建，工作区目录和归档的错开）。ticket 的仓库加进它的仓库列表。返回 id。
   */
  async ensureJiraEpic(epic: { key: string; title: string | null }, repoPath: string): Promise<number> {
    const root = await gitRootOf(repoPath);
    const found = this.d.features.byJiraEpic(epic.key);
    if (found) {
      if (!found.repos.some((r) => samePath(r.repoPath, root))) this.d.features.addRepo(found.id, root, this.d.now());
      return found.id;
    }
    const name = `${epic.key} ${epic.title ?? ""}`.replace(/\s+/g, " ").trim().slice(0, FEATURE_NAME_LIMIT).trim();
    const all = [...this.d.features.list(), ...this.d.features.listArchived()];
    const base = this.defaultWorkspace([root], name);
    // 存的是真实路径（经过 symlink 的写法对不上）：目录已经在时按真实路径比。
    const real = (d: string): string => {
      try {
        return realpathSync.native(d);
      } catch {
        return d;
      }
    };
    const taken = (d: string) => all.some((f) => samePath(f.workspaceDir, d) || samePath(f.workspaceDir, real(d)));
    let dir = base;
    for (let n = 2; taken(dir); n++) dir = `${base}-${n}`;
    const workspaceDir = resolveWorkspaceDir(dir, this.d.homeDir);
    const now = this.d.now();
    return this.tx(() => {
      const fid = this.d.features.insert({ name, workspaceDir, createdAt: now });
      this.d.features.addRepo(fid, root, now);
      this.d.features.setJiraEpic(fid, epic.key);
      return fid;
    });
  }

  async addRepo(featureId: number, repoPath: string): Promise<FeatureRepo> {
    const f = this.get(featureId);
    const root = await gitRootOf(repoPath);
    if (f.repos.some((r) => samePath(r.repoPath, root))) throw new TicketError("repo_exists", M().featureHasRepo(root));
    return this.d.features.getRepo(this.d.features.addRepo(featureId, root, this.d.now()))!;
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

  /** 归档 feature：和它还没归档的 ticket 一起归档；有终端在跑时拒绝。已经归档的什么都不做。 */
  archive(featureId: number, opts: { terminalsOpen: () => boolean }): void {
    if (this.get(featureId).archivedAt !== null) return;
    if (opts.terminalsOpen()) throw new TicketError("sessions_open", M().featureTerminalsArchive);
    this.archiveNow(featureId, this.d.now());
  }

  /** 立刻归档，不查终端：feature 和它还没归档的 ticket 用同一个时间戳 at。 */
  archiveNow(featureId: number, at: number): void {
    const f = this.get(featureId);
    if (f.archivedAt !== null) return;
    const keys = this.d.tickets.listByFeature(featureId).map((t) => t.key);
    this.tx(() => {
      for (const k of keys) this.d.tickets.archive(k, at);
      this.d.features.archive(featureId, at);
    });
    for (const k of keys) this.d.onTicketArchived?.(k);
  }

  /** 恢复 feature，以及和它一起归档的 ticket（之前单独归档的保持归档）。 */
  unarchive(featureId: number): void {
    const f = this.get(featureId);
    if (f.archivedAt === null) return;
    const keys = this.d.tickets.listByFeature(featureId, { includeArchived: true }).filter((t) => t.archivedAt === f.archivedAt).map((t) => t.key);
    this.tx(() => {
      for (const k of keys) this.d.tickets.unarchive(k);
      this.d.features.unarchive(featureId);
    });
  }

  private tx<T>(fn: () => T): T {
    return this.d.db ? withTransaction(this.d.db, fn) : fn();
  }
}
