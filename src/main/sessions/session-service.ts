import { existsSync } from "node:fs";
import { sanitizePrefill } from "../../shared/text";
import type { Pr } from "../../shared/handoff";
import {
  effectiveStatus,
  type Feature,
  type FeatureView,
  type OpenFeatureSessionRequest,
  type OpenSessionRequest,
  type OpenSessionResult,
  type Session,
  type SessionView,
  type Ticket,
  type TicketRepo,
  type TicketView,
  type UnclaimedSession,
} from "../../shared/types";
import { launchEnv, type LaunchDeps, resolveLaunch, withArgs } from "../claude/launch";
import { claudeArgs, cmdShimSafe, sessionEnv } from "../claude/spawn";
import type { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import type { FeaturesRepo } from "../db/features-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { currentBranch } from "../tickets/git";
import { dirsOutsideWorkspace, isInside, TicketError, type TicketService } from "../tickets/ticket-service";
import { suggestTicket, type TranscriptState, UNCLAIMED_WINDOW_MS } from "./discovery";
import type { PtyManager } from "./pty-manager";
import { M } from "../strings";

export interface SessionServiceDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  settings: SettingsRepo;
  ticketService: TicketService;
  pty: PtyManager;
  /** 首次 health 探测完成后 resolve；open 据此决定 claude 是否缺失。 */
  ready: () => Promise<void>;
  /** 这个 session 在磁盘上有没有对话记录（没有就不能 --resume）。 */
  transcriptExists: (sessionId: string) => boolean;
  /** 三态版本，供 handleExit 判断能否安全删行（unknown 必须保留）。 */
  transcriptState: (sessionId: string) => TranscriptState;
  claude: () => { path: string | null; pathValue: string };
  newId: () => string;
  now: () => number;
  platform: NodeJS.Platform;
  baseEnv: NodeJS.ProcessEnv;
  /**
   * 写好这个 ticket 的记忆 --mcp-config 文件并返回路径；记忆关闭或 bundle 不存在时返回 null（设计文档 8.4）。
   * featureId：ticket 属于的 feature，要多挂 feature 的记忆（设计文档 2026-10-26）。
   */
  mcpConfig?: (ticketKey: string, opts: { coordinator: boolean; featureId: number | null }) => string | null;
  /** feature 总控的 --mcp-config 文件（feature 记忆、全局记忆、butler-sessions）。 */
  featureMcpConfig?: (featureId: number) => string | null;
  /** feature（设计文档 2026-10-26）；不给就没有 feature 总控。 */
  features?: FeaturesRepo;
  /** feature 汇总（设计文档 2026-10-28）；不给 FeatureView 里 summary 为 null。 */
  featureHandoffs?: Pick<FeatureHandoffsRepo, "latest">;
  /** 取 ticket 的最新有效 handoff 里的 PR；不给就都是 []。 */
  handoffs?: Pick<HandoffsRepo, "latestValid">;
  /** 目录是否存在（测试注入；默认读真实磁盘）。 */
  dirExists?: (dir: string) => boolean;
  /** 要打开这个 ticket 的 session 时调用：把它的记忆补同步一次（排进记忆的同步队列，不等它）。 */
  syncMemory?: (ticketKey: string) => void;
  /** 读 claude.cmd shim 用的文件系统（测试注入；默认读真实磁盘）。 */
  launchFs?: Pick<LaunchDeps, "read" | "exists">;
  log?: (msg: string, err?: unknown) => void;
}

type OpenFailure = Extract<OpenSessionResult, { ok: false }>;

interface Placement {
  repo: TicketRepo | null;
  coordinator: boolean;
  cwd: string;
}

/** 不是渲染进程能传的打开参数：总控开子 session 时用。 */
export interface OpenExtra {
  spawnedBy?: string;
}

/** 同一个目录：Windows 的路径不分大小写，也不分 / 和 \\。 */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => (platform === "win32" ? p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : p.replace(/\/+$/, ""));
  return norm(a) === norm(b);
}

export class SessionService {
  constructor(private readonly d: SessionServiceDeps) {}

  /** 打开的终端以启动时的 session id 为 termId；/clear 后要沿链比较当前 head。 */
  private openHeads(): Map<string, string> {
    const heads = new Map<string, string>();
    for (const termId of this.d.pty.openIds()) {
      const head = this.d.sessions.head(termId);
      if (head) heads.set(head.id, termId);
    }
    return heads;
  }

  private prefill(termId: string, text: string, idleMs?: number): void {
    this.d.pty.prefill(termId, text, idleMs).catch((e: unknown) => this.d.log?.(`prefill ${termId} failed`, e));
  }

  async open(req: OpenSessionRequest, extra: OpenExtra = {}): Promise<OpenSessionResult> {
    await this.d.ready();
    const prefill = req.prefill ? sanitizePrefill(req.prefill) : "";
    const ticket = this.d.tickets.get(req.ticketKey);
    if (!ticket) return { ok: false, reason: "no_ticket" };
    if (this.d.ticketService.updating(ticket.key)) return { ok: false, reason: "ticket_busy" };

    let head: Session | null = null;
    if (req.sessionId) {
      head = this.d.sessions.head(req.sessionId);
      if (!head) return { ok: false, reason: "no_session" };
      const existing = this.openHeads().get(head.id);
      if (existing) {
        if (prefill) this.prefill(existing, prefill, 0);
        return { ok: true, termId: existing, alreadyOpen: true };
      }
    }

    const { path: claudePath, pathValue } = this.d.claude();
    if (!claudePath) return { ok: false, reason: "claude_missing" };

    const placed = await this.place(ticket, head, req);
    if ("ok" in placed) return placed;
    const { repo, coordinator, cwd } = placed;
    // place 里等了 git：这期间仓库可能被移除、ticket 可能开始修改，同一个 session 也可能已经被另一次点击打开了。
    if (this.d.ticketService.updating(ticket.key)) return { ok: false, reason: "ticket_busy" };
    if (head) {
      const opened = this.openHeads().get(head.id);
      if (opened) {
        if (prefill) this.prefill(opened, prefill, 0);
        return { ok: true, termId: opened, alreadyOpen: true };
      }
    }
    if (!head && repo && !this.d.tickets.getRepo(repo.id)) return { ok: false, reason: "no_repo" };

    this.syncMemory(ticket.key);
    // 启动方式只解析一次：记忆挂载的检查和真正启动用同一个结果（P5-PF10）。
    const launch = resolveLaunch(claudePath, [], this.d.platform, { ...this.d.launchFs, pathValue });
    const mcpConfigPath = this.configPath(ticket.key, () => this.d.mcpConfig?.(ticket.key, { coordinator, featureId: ticket.featureId }) ?? null, claudePath, launch.viaCmd);
    const addDirs = coordinator ? this.addDirsFor(ticket, claudePath, launch.viaCmd) : [];
    let termId: string;
    let args: string[];
    let insertedRow = false;
    if (head) {
      // claude --resume 只能在 session 当初的项目目录里找到它；没发过消息的 session 没有记录，用同一个 id 重新开
      termId = head.id;
      args = claudeArgs({ mode: this.d.transcriptExists(head.id) ? "resume" : "new", sessionId: head.id, mcpConfigPath, addDirs });
    } else {
      termId = this.d.newId();
      args = claudeArgs({ mode: "new", sessionId: termId, mcpConfigPath, addDirs });
      const now = this.d.now();
      insertedRow = this.d.sessions.insertIfAbsent({
        id: termId, ticketKey: ticket.key, cwd, origin: "butler", lastActivityAt: now, createdAt: now,
        repoId: repo?.id ?? null, coordinator, spawnedBy: extra.spawnedBy ?? null,
      });
    }

    try {
      const full = withArgs(launch, args);
      this.d.pty.open(termId, { file: full.file, args: full.args }, {
        cwd,
        env: launchEnv(full, sessionEnv(this.d.baseEnv, { pathValue, ticketKey: ticket.key, sessionId: termId })),
      });
    } catch (e) {
      // claude 没能启动：刚插入的那一行只是空壳，不能留在列表里。
      if (insertedRow) this.d.sessions.delete(termId);
      throw e;
    }
    if (prefill) this.prefill(termId, prefill);
    return { ok: true, termId, alreadyOpen: false };
  }

  /**
   * 这个 session 在哪个目录里跑、属于哪个仓库：
   * - 恢复：仍在它当初的目录里（claude --resume 只在那里找得到它）。分支检查看它的仓库；目录不是仓库现在的工作目录时，看那个目录本身。
   * - 新总控：ticket 的工作区目录，不检查分支。
   * - 新 session：指定的仓库；没指定时 ticket 只有一个仓库就用它。
   */
  private async place(ticket: Ticket, head: Session | null, req: OpenSessionRequest): Promise<Placement | OpenFailure> {
    if (head) {
      let repo = head.repoId === null ? null : (ticket.repos.find((r) => r.id === head.repoId) ?? null);
      // 在被清理掉的 worktree 里跑过的 session：claude --resume 要在原来的目录里，先把它重建出来（设计文档 2026-10-26）。
      if (repo?.worktreePath && head.cwd && isInside(head.cwd, repo.worktreePath)) repo = await this.d.ticketService.ensureWorktree(repo);
      const fallback = head.coordinator || !repo ? this.d.ticketService.workspaceDir(ticket.key) : this.d.ticketService.workDir(repo);
      const cwd = head.cwd || fallback;
      if (!req.force && !head.coordinator && repo) {
        if (samePath(cwd, this.d.ticketService.workDir(repo), this.d.platform)) {
          const mismatch = await this.branchMismatch(repo);
          if (mismatch) return mismatch;
        } else {
          // 在别的目录里启动的旧 session（仓库后来改过工作方式）：检查那个目录的分支，而不是仓库现在的目录。
          const moved = await this.oldWorkdirCheck(cwd, repo.branch);
          if (moved) return moved;
        }
      }
      return { repo, coordinator: head.coordinator, cwd };
    }
    if (req.coordinator) return { repo: null, coordinator: true, cwd: this.d.ticketService.workspaceDir(ticket.key) };
    const picked = req.repoId !== undefined ? ticket.repos.find((r) => r.id === req.repoId) : ticket.repos.length === 1 ? ticket.repos[0] : undefined;
    if (!picked) return { ok: false, reason: ticket.repos.length === 0 || req.repoId !== undefined ? "no_repo" : "pick_repo" };
    const repo = await this.d.ticketService.ensureWorktree(picked);
    if (!req.force) {
      const mismatch = await this.branchMismatch(repo);
      if (mismatch) return mismatch;
    }
    return { repo, coordinator: false, cwd: this.d.ticketService.workDir(repo) };
  }

  private async branchMismatch(repo: TicketRepo): Promise<OpenFailure | null> {
    const check = await this.d.ticketService.checkBranch(repo);
    return check.ok ? null : { ok: false, reason: "branch_mismatch", repoId: repo.id, current: check.current, expected: check.expected, dirty: check.dirty };
  }

  /** 总控能看到的目录：每个仓库现在的工作目录（不存在的跳过；要经过 cmd.exe 又没法安全传递的也跳过）。 */
  private addDirsFor(ticket: Ticket, claudePath: string, viaCmd: boolean): string[] {
    const dirs: string[] = [];
    for (const r of ticket.repos) {
      const dir = this.d.ticketService.workDir(r);
      if (!(this.d.dirExists ?? existsSync)(dir)) continue;
      if (viaCmd && !cmdShimSafe(claudePath, dir, this.d.platform)) {
        this.d.log?.(`coordinator for ${ticket.key}: ${dir} cannot pass through cmd.exe safely; not added`);
        continue;
      }
      dirs.push(dir);
    }
    return dirs;
  }

  /**
   * ticket 改过工作方式后，旧 session 仍在它当初的目录里恢复。那个目录已经不在 ticket 的分支上（比如离开分支的 worktree）时先提示，
   * 免得 claude 在游离 HEAD 或别的分支上继续干活。目录读不了就不拦（交给启动本身报错）。
   */
  private async oldWorkdirCheck(cwd: string, expected: string): Promise<OpenFailure | null> {
    let current: string;
    try {
      current = await currentBranch(cwd);
    } catch {
      return null;
    }
    return current === expected ? null : { ok: false, reason: "old_workdir", cwd, current, expected };
  }

  /** 记忆补同步（最终审查 6）：失败只写日志，session 照常打开。 */
  private syncMemory(ticketKey: string): void {
    try {
      this.d.syncMemory?.(ticketKey);
    } catch (e) {
      this.d.log?.(`memory sync for ${ticketKey} not started`, e);
    }
  }

  /** 记忆 MCP 配置（label 是 ticket 号或 feature）。写不出来、或者要经过 cmd.exe 又无法安全传递时不挂，session 照常打开。 */
  private configPath(label: string, write: () => string | null, claudePath: string, viaCmd: boolean): string | undefined {
    let file: string | null;
    try {
      file = write();
    } catch (e) {
      this.d.log?.(`memory MCP config for ${label} not written`, e);
      return undefined;
    }
    if (!file) return undefined;
    // 计划 5：能认出的 shim 不经过 cmd.exe，路径原样传递；只有回退到 cmd.exe 时才需要这道检查（计划 4 的 P4-R7）。
    if (viaCmd && !cmdShimSafe(claudePath, file, this.d.platform)) {
      this.d.log?.(`memory MCP not mounted for ${label}: the config path cannot pass through cmd.exe safely`);
      return undefined;
    }
    return file;
  }

  /**
   * feature 总控（设计文档 2026-10-26）：在 feature 的工作区里打开，feature 下 ticket 的 worktree 都在里面；
   * 工作区外面的仓库目录（分支模式、别处的 worktree）各加一个 --add-dir。不设 BUTLER_TICKET。
   */
  async openFeature(req: OpenFeatureSessionRequest): Promise<OpenSessionResult> {
    await this.d.ready();
    const prefill = req.prefill ? sanitizePrefill(req.prefill) : "";
    const feature = this.d.features?.get(req.featureId);
    if (!feature || feature.archivedAt !== null) return { ok: false, reason: "no_ticket" };

    let head: Session | null = null;
    if (req.sessionId) {
      head = this.d.sessions.head(req.sessionId);
      if (!head || head.featureId !== feature.id) return { ok: false, reason: "no_session" };
      const existing = this.openHeads().get(head.id);
      if (existing) {
        if (prefill) this.prefill(existing, prefill, 0);
        return { ok: true, termId: existing, alreadyOpen: true };
      }
    }
    const { path: claudePath, pathValue } = this.d.claude();
    if (!claudePath) return { ok: false, reason: "claude_missing" };

    const workspace = this.d.ticketService.featureWorkspaceDir(feature.id);
    const cwd = head?.cwd || workspace;
    const launch = resolveLaunch(claudePath, [], this.d.platform, { ...this.d.launchFs, pathValue });
    const mcpConfigPath = this.configPath(`feature ${feature.id}`, () => this.d.featureMcpConfig?.(feature.id) ?? null, claudePath, launch.viaCmd);
    const addDirs = this.featureAddDirs(feature, claudePath, launch.viaCmd);
    let termId: string;
    let args: string[];
    let insertedRow = false;
    if (head) {
      termId = head.id;
      args = claudeArgs({ mode: this.d.transcriptExists(head.id) ? "resume" : "new", sessionId: head.id, mcpConfigPath, addDirs });
    } else {
      termId = this.d.newId();
      args = claudeArgs({ mode: "new", sessionId: termId, mcpConfigPath, addDirs });
      const now = this.d.now();
      insertedRow = this.d.sessions.insertIfAbsent({
        id: termId, ticketKey: null, cwd, origin: "butler", lastActivityAt: now, createdAt: now, coordinator: true, featureId: feature.id,
      });
    }
    try {
      const full = withArgs(launch, args);
      this.d.pty.open(termId, { file: full.file, args: full.args }, { cwd, env: launchEnv(full, sessionEnv(this.d.baseEnv, { pathValue, sessionId: termId })) });
    } catch (e) {
      if (insertedRow) this.d.sessions.delete(termId);
      throw e;
    }
    if (prefill) this.prefill(termId, prefill);
    return { ok: true, termId, alreadyOpen: false };
  }

  /** feature 总控要另外加的目录：feature 下未归档 ticket 的仓库工作目录里，不在工作区里面的（同样的存在、cmd.exe 检查）。 */
  private featureAddDirs(feature: Feature, claudePath: string, viaCmd: boolean): string[] {
    const all = this.d.tickets.listByFeature(feature.id).flatMap((t) => t.repos.map((r) => this.d.ticketService.workDir(r)));
    const dirs = dirsOutsideWorkspace(all, feature.workspaceDir, { same: (a, b) => samePath(a, b, this.d.platform), exists: this.d.dirExists ?? existsSync });
    return dirs.filter((dir) => {
      if (!viaCmd || cmdShimSafe(claudePath, dir, this.d.platform)) return true;
      this.d.log?.(`coordinator for feature ${feature.id}: ${dir} cannot pass through cmd.exe safely; not added`);
      return false;
    });
  }

  /**
   * 终端退出时调用。Butler 新建、但用户一句话都没说就退出的 session 没有 transcript，也不能 --resume；
   * 留着只会多出一个空的“新对话”按钮，删掉。
   */
  handleExit(termId: string): void {
    const s = this.d.sessions.get(termId);
    if (s) this.pruneIfEmpty(s);
  }

  /**
   * 启动时调用一次：上次退出时终端还开着，退出事件来得比关数据库晚，handleExit 没跑，空 session 留了下来。
   * 规则和 handleExit 一样；终端还开着的（以及它 /clear 之后的 head）不动。返回删掉的行数。
   */
  pruneEmptySessions(): number {
    const open = new Set([...this.d.pty.openIds(), ...this.openHeads().keys()]);
    let pruned = 0;
    for (const s of this.d.sessions.listEmptyButler()) {
      if (!open.has(s.id) && this.pruneIfEmpty(s)) pruned++;
    }
    return pruned;
  }

  /** Butler 新建、没有第一句话、没被替换、确认没有 transcript 的 session：删掉并返回 true。 */
  private pruneIfEmpty(s: Session): boolean {
    if (s.origin !== "butler" || s.firstPrompt || s.replacedBy) return false;
    // 只有确认没有记录才删；读不了目录（unknown）时保留这一行。
    if (this.d.transcriptState(s.id) !== "absent") return false;
    this.d.sessions.delete(s.id);
    return true;
  }

  /**
   * 这个 ticket 有没有正在运行的终端（/clear 之后的 head 也算在启动它的终端上）。给了 repoId 时只算可能在这个仓库里工作的：
   * 这个仓库的 session、总控（它能看到所有仓库），以及认不出仓库的旧 session。
   */
  hasOpenTerminal(ticketKey: string, repoId?: number): boolean {
    return this.d.pty.openIds().some((termId) => {
      const h = this.d.sessions.head(termId);
      if (h?.ticketKey !== ticketKey) return false;
      return repoId === undefined || h.coordinator || h.repoId === null || h.repoId === repoId;
    });
  }

  /** 这个仓库自己的 session 有没有终端在跑（不算总控和认不出仓库的旧 session）：合并后清理 worktree 用。 */
  hasRepoTerminal(ticketKey: string, repoId: number): boolean {
    return this.d.pty.openIds().some((termId) => {
      const h = this.d.sessions.head(termId);
      return h?.ticketKey === ticketKey && h.repoId === repoId;
    });
  }

  /** 这个 session（或者它 /clear 之前的那个）有没有终端在跑。 */
  isRunning(sessionId: string): boolean {
    return this.openHeads().has(sessionId);
  }

  /** 这个 ticket 正在运行的终端数（总控开子 session 的上限用）。 */
  openTerminalCount(ticketKey: string): number {
    return this.d.pty.openIds().filter((termId) => this.d.sessions.head(termId)?.ticketKey === ticketKey).length;
  }

  /** feature 正在运行的终端数：feature 总控，加上它所有 ticket 的终端。 */
  featureTerminalCount(featureId: number): number {
    const keys = new Set(this.d.tickets.listByFeature(featureId).map((t) => t.key));
    return this.d.pty.openIds().filter((termId) => {
      const h = this.d.sessions.head(termId);
      return !!h && (h.featureId === featureId || (h.ticketKey !== null && keys.has(h.ticketKey)));
    }).length;
  }

  hasFeatureTerminal(featureId: number): boolean {
    return this.featureTerminalCount(featureId) > 0;
  }

  /** session 行加上它的终端；分成显示的和隐藏的（正在运行的终端永远显示，隐藏只对没在跑的 session 起作用）。 */
  private split(rows: Session[], heads: Map<string, string>): { sessions: SessionView[]; hiddenSessions: SessionView[] } {
    const all = rows.filter((s) => !s.replacedBy).map((s) => ({ ...s, termId: heads.get(s.id) ?? null }));
    return { sessions: all.filter((s) => !s.dismissed || s.termId !== null), hiddenSessions: all.filter((s) => s.dismissed && s.termId === null) };
  }

  private allTicketViews(heads: Map<string, string>): TicketView[] {
    return this.d.tickets.list().map((t) => {
      const { sessions, hiddenSessions } = this.split(this.d.sessions.listByTicket(t.key), heads);
      return { ...t, effectiveStatus: effectiveStatus(t), sessions, hiddenSessions, waiting: sessions.some((s) => s.waitingForInput) };
    });
  }

  /** 单独的 ticket（属于未归档 feature 的在 featureViews 里）。 */
  ticketViews(): TicketView[] {
    const active = new Set((this.d.features?.list() ?? []).map((f) => f.id));
    return this.allTicketViews(this.openHeads()).filter((t) => t.featureId === null || !active.has(t.featureId));
  }

  /** 未归档的 feature，带上它的 ticket 和 feature 总控 session。 */
  featureViews(): FeatureView[] {
    const heads = this.openHeads();
    const tickets = this.allTicketViews(heads);
    return (this.d.features?.list() ?? []).map((f) => {
      const { sessions, hiddenSessions } = this.split(this.d.sessions.listByFeature(f.id), heads);
      // 按建立顺序（和 list_tickets 一样），不是单独 ticket 列表的最新在前。
      const own = tickets.filter((t) => t.featureId === f.id).sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
      const ticketPrs: Record<string, Pr[]> = {};
      for (const t of own) ticketPrs[t.key] = this.d.handoffs?.latestValid(t.key)?.payload?.prs ?? [];
      return {
        ...f, tickets: own, sessions, hiddenSessions, waiting: sessions.some((s) => s.waitingForInput) || own.some((t) => t.waiting),
        summary: this.d.featureHandoffs?.latest(f.id) ?? null, ticketPrs,
      };
    });
  }

  unclaimed(): UnclaimedSession[] {
    const pattern = this.d.settings.get("ticketPattern");
    return this.d.sessions.listUnclaimed(this.d.now() - UNCLAIMED_WINDOW_MS).map((s) => {
      const key = suggestTicket(s, pattern);
      return { ...s, suggestedTicket: key, suggestionExists: !!key && !!this.d.tickets.get(key) };
    });
  }

  /** 认领：session 的目录落在 ticket 的某个仓库里，就记成那个仓库的 session。 */
  claim(sessionId: string, ticketKey: string): void {
    const ticket = this.d.tickets.get(ticketKey);
    if (!ticket) throw new TicketError("not_found", M().ticketNotFound(ticketKey));
    const s = this.d.sessions.get(sessionId);
    const repo = s?.cwd ? this.d.ticketService.repoForCwd(ticket, s.cwd) : null;
    this.d.sessions.setTicket(sessionId, ticketKey, repo?.id ?? null);
  }

  dismiss(sessionId: string): void {
    this.d.sessions.dismiss(sessionId);
  }

  /**
   * 把 ticket 里多余的 session 从列表里隐藏：只是不显示，对话记录、ticket 归属都不动，随时可以恢复。
   * 终端还在跑的不能隐藏（先在终端里退出 claude）。
   */
  hide(sessionId: string): void {
    const s = this.d.sessions.head(sessionId);
    // ticket 的 session，或者 feature 总控。
    if (!s || (!s.ticketKey && s.featureId === null)) throw new TicketError("not_found", M().sessionNotFound);
    if (this.openHeads().has(s.id)) throw new TicketError("sessions_open", M().sessionTerminalHide);
    this.d.sessions.dismiss(s.id);
  }

  unhide(sessionId: string): void {
    const s = this.d.sessions.get(sessionId);
    if (!s || (!s.ticketKey && s.featureId === null)) throw new TicketError("not_found", M().sessionNotFound);
    this.d.sessions.undismiss(s.id);
  }
}
