import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { CreateFeatureInput, Feature, FeatureRepo } from "../../shared/types";
import { withTransaction, type Db } from "../db/database";
import type { FeaturesRepo } from "../db/features-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { featureDirName } from "../util/ticket-file";
import { repoRoot } from "./git";
import { samePath, TicketError } from "./ticket-service";

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
    if (!f) throw new TicketError("not_found", "找不到这个 feature");
    return f;
  }

  listArchived(): Feature[] {
    return this.d.features.listArchived();
  }

  /** 工作区默认放在仓库上一层的旁边：~/Code/shop/frontend → ~/Code/shop-features/<名字>。 */
  defaultWorkspace(repoPaths: string[], name: string): string {
    const parent = dirname(repoPaths[0]);
    return join(dirname(parent), `${basename(parent)}-features`, featureDirName(name));
  }

  /**
   * 工作区目录：展开 ~，必须是绝对路径；建好之后存真实路径（claude 和 hook 报上来的 cwd 是真实路径，经过 symlink 的写法对不上）。
   */
  private workspacePath(dir: string): string {
    const expanded = dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\") ? join(this.d.homeDir ?? homedir(), dir.slice(1)) : dir;
    if (!isAbsolute(expanded)) throw new TicketError("invalid_workspace", `工作区目录要写完整路径（例如 ~/Code/shop-features/名字）：${dir}`);
    const abs = resolve(expanded);
    try {
      mkdirSync(abs, { recursive: true });
      return realpathSync.native(abs);
    } catch (e) {
      throw new TicketError("invalid_workspace", `建不了工作区目录 ${abs}：${(e as Error).message}`);
    }
  }

  private static checkName(name: string): string {
    const n = name.trim();
    if (!n || n.length > FEATURE_NAME_LIMIT) throw new TicketError("invalid_name", `feature 名字不能为空，最长 ${FEATURE_NAME_LIMIT} 字`);
    return n;
  }

  private static async root(path: string): Promise<string> {
    try {
      return await repoRoot(path);
    } catch {
      throw new TicketError("not_git_repo", `${path} 不是 git 仓库`);
    }
  }

  async create(input: CreateFeatureInput): Promise<Feature> {
    const name = FeatureService.checkName(input.name);
    if (input.repoPaths.length === 0) throw new TicketError("not_git_repo", "至少选一个仓库");
    const roots: string[] = [];
    for (const p of input.repoPaths) {
      const root = await FeatureService.root(p);
      if (!roots.some((r) => samePath(r, root))) roots.push(root);
    }
    const workspaceDir = this.workspacePath(input.workspaceDir?.trim() || this.defaultWorkspace(roots, name));
    if (this.d.features.byWorkspace(workspaceDir)) throw new TicketError("workspace_taken", `另一个 feature 已经在用这个工作区：${workspaceDir}`);
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
    const root = await FeatureService.root(repoPath);
    if (f.repos.some((r) => samePath(r.repoPath, root))) throw new TicketError("repo_exists", `这个 feature 已经有仓库 ${root}`);
    return this.d.features.getRepo(this.d.features.addRepo(featureId, root, this.d.now()))!;
  }

  /** 只影响以后建 ticket 时的选项；已有 ticket 的仓库、磁盘上的东西都不动。 */
  removeRepo(featureRepoId: number): void {
    if (!this.d.features.getRepo(featureRepoId)) throw new TicketError("not_found", "找不到这个仓库");
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
    if (opts.terminalsOpen) throw new TicketError("sessions_open", "这个 feature 还有终端在运行，先在终端里退出 claude 再归档");
    const now = this.d.now();
    const keys = this.d.tickets.listByFeature(featureId).map((t) => t.key);
    this.tx(() => {
      for (const k of keys) this.d.tickets.archive(k, now);
      this.d.features.archive(featureId, now);
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
