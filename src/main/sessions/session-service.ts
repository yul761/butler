import { existsSync, mkdirSync } from "node:fs";
import type { SessionActivity } from "../../shared/activity";
import { sanitizePrefill } from "../../shared/text";
import type { Pr } from "../../shared/handoff";
import {
  effectiveStatus,
  type Epic,
  type EpicView,
  type Feature,
  type FeatureHandoffRecord,
  type FeatureView,
  type OpenEpicSessionRequest,
  type OpenFeatureSessionRequest,
  type OpenFixSessionRequest,
  type OpenSessionRequest,
  type OpenSessionResult,
  type EpicFeatureRow,
  type Session,
  type SessionView,
  type Ticket,
  type TicketRepo,
  type TicketView,
  type UnclaimedSession,
} from "../../shared/types";
import { launchEnv, type LaunchDeps, resolveLaunch, withArgs } from "../claude/launch";
import { claudeArgs, cmdShimSafe, sessionEnv } from "../claude/spawn";
import type { EpicsRepo } from "../db/epics-repo";
import { epicFeatureRows, type LiveFeature } from "../epics/epic-info";
import type { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import type { FeaturesRepo } from "../db/features-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { NewSession, SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { currentLang } from "../i18n";
import { currentBranch } from "../tickets/git";
import { dirsOutsideWorkspace, isInside, TicketError, type TicketService } from "../tickets/ticket-service";
import { describeActivity } from "./activity-monitor";
import { suggestTicket, type TranscriptState, UNCLAIMED_WINDOW_MS } from "./discovery";
import { fixTaskMessage } from "./fix-task";
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
   * featureId：ticket 属于的 feature，要多挂 feature 的记忆（设计文档 2026-10-26）。epicId：这个 feature 属于的 epic，要多挂 epic 的记忆。
   */
  mcpConfig?: (ticketKey: string, opts: { coordinator: boolean; featureId: number | null; epicId: number | null }) => string | null;
  /** feature 总控的 --mcp-config 文件（feature 记忆、全局记忆、butler-sessions；feature 属于 epic 时加 epic 记忆）。 */
  featureMcpConfig?: (featureId: number, epicId: number | null) => string | null;
  /** epic session 的 --mcp-config 文件。 */
  epicMcpConfig?: (epicId: number) => string | null;
  /**
   * 交互 session 的 --settings 文件：直接启用仓库 .mcp.json 里的 server，不停在选择对话框上（用户在 dirs 里禁用过的照旧禁用）。
   * 返回 null 时不加 --settings。
   */
  mcpSettings?: (dirs: string[]) => string | null;
  /** feature（设计文档 2026-10-26）；不给就没有 feature 总控。 */
  features?: FeaturesRepo;
  /** epic（设计文档 2026-11-01）；不给就没有 epic session。 */
  epics?: EpicsRepo;
  /** feature 汇总（设计文档 2026-10-28）；不给 FeatureView 里 summary 为 null。 */
  featureHandoffs?: Pick<FeatureHandoffsRepo, "latest" | "latestValid">;
  /** 取 ticket 的最新有效 handoff 里的 PR；不给就都是 []。 */
  handoffs?: Pick<HandoffsRepo, "knownPrs">;
  /** session 此刻的活动（ActivityMonitor）；不给 FeatureView 里 activity 是空的。 */
  activity?: (sessionId: string) => SessionActivity | null;
  /** session 的名字（SendMessage 用它寻址）；查不到时是 null。 */
  sessionName?: (sessionId: string) => Promise<string | null>;
  /** 把任务作为第一条消息交给新 session（修复 session 的任务）。 */
  submit?: (termId: string, message: string) => Promise<"sent" | "exited" | "timeout">;
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

/** 在工作区里启动 claude 时，feature 级 session 和 epic session 各自不同的地方。 */
interface WorkspaceTarget {
  /** 日志里的称呼。 */
  label: string;
  workspace: string;
  /** 源仓库（用户在这些目录里禁用过的项目 MCP 照旧禁用）。 */
  repoPaths: string[];
  /** 要 claude 看到的目录；工作区里面的、不存在的不加 --add-dir。 */
  dirs: string[];
  mcpConfig: () => string | null;
  /** 新建 session 时这一行的角色。 */
  row: Pick<NewSession, "coordinator" | "featureId" | "fixesSession" | "epicId">;
}

type Claude = { path: string; pathValue: string };

/** 不是渲染进程能传的打开参数：总控开子 session 时用。 */
export interface OpenExtra {
  spawnedBy?: string;
}

/** 同一个目录：Windows 的路径不分大小写，也不分 / 和 \\。 */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => (platform === "win32" ? p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : p.replace(/\/+$/, ""));
  return norm(a) === norm(b);
}

/** 一行显示一个活动：卡住 > 等你批准 > 等你回话 > 最近有活动。 */
function mostUrgent(activities: SessionActivity[]): SessionActivity | undefined {
  const rank = (a: SessionActivity) => (a.stuck ? 0 : a.kind === "approval" ? 1 : a.kind === "waiting" ? 2 : 3);
  return [...activities].sort((a, b) => rank(a) - rank(b) || (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0))[0];
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
    const epicId = ticket.featureId === null ? null : (this.d.features?.get(ticket.featureId)?.epicId ?? null);
    const mcpConfigPath = this.configPath(ticket.key, () => this.d.mcpConfig?.(ticket.key, { coordinator, featureId: ticket.featureId, epicId }) ?? null, claudePath, launch.viaCmd);
    const settingsPath = this.configPath(ticket.key, () => this.d.mcpSettings?.([cwd, ...ticket.repos.map((r) => r.repoPath)]) ?? null, claudePath, launch.viaCmd, "MCP approval settings");
    const addDirs = coordinator ? this.addDirsFor(ticket, claudePath, launch.viaCmd) : [];
    let termId: string;
    let args: string[];
    let insertedRow = false;
    if (head) {
      // claude --resume 只能在 session 当初的项目目录里找到它；没发过消息的 session 没有记录，用同一个 id 重新开
      termId = head.id;
      args = claudeArgs({ mode: this.d.transcriptExists(head.id) ? "resume" : "new", sessionId: head.id, mcpConfigPath, settingsPath, addDirs });
    } else {
      termId = this.d.newId();
      args = claudeArgs({ mode: "new", sessionId: termId, mcpConfigPath, settingsPath, addDirs });
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
  private configPath(label: string, write: () => string | null, claudePath: string, viaCmd: boolean, kind = "memory MCP config"): string | undefined {
    let file: string | null;
    try {
      file = write();
    } catch (e) {
      this.d.log?.(`${kind} for ${label} not written`, e);
      return undefined;
    }
    if (!file) return undefined;
    // 计划 5：能认出的 shim 不经过 cmd.exe，路径原样传递；只有回退到 cmd.exe 时才需要这道检查（计划 4 的 P4-R7）。
    if (viaCmd && !cmdShimSafe(claudePath, file, this.d.platform)) {
      this.d.log?.(`${kind} not passed for ${label}: the path cannot pass through cmd.exe safely`);
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
    const feature = this.d.features?.get(req.featureId);
    if (!feature || feature.archivedAt !== null) return { ok: false, reason: "no_ticket" };
    return this.resumeOrStart(req, (head) => head.featureId === feature.id, (claude, head) => this.startInFeature(feature, claude, { head }));
  }

  /**
   * epic session（设计文档 2026-11-01）：在 epic 的工作区里打开，每个仓库一个 --add-dir，方便规划时读代码。不设 BUTLER_TICKET。
   * 不是总控：feature 汇总、handoff 和 ActivityMonitor 都不处理它。
   */
  async openEpic(req: OpenEpicSessionRequest): Promise<OpenSessionResult> {
    await this.d.ready();
    const epic = this.d.epics?.get(req.epicId);
    if (!epic || epic.archivedAt !== null) return { ok: false, reason: "no_ticket" };
    return this.resumeOrStart(req, (head) => head.epicId === epic.id, (claude, head) => this.startInEpic(epic, claude, head));
  }

  /** 恢复 sessionId 这个 session（属于这里、终端还开着时直接用那个终端），或者新开一个。start 返回终端 id。 */
  private async resumeOrStart(
    req: { sessionId?: string; prefill?: string },
    belongs: (head: Session) => boolean,
    start: (claude: Claude, head: Session | null) => string | OpenFailure,
  ): Promise<OpenSessionResult> {
    const prefill = req.prefill ? sanitizePrefill(req.prefill) : "";
    let head: Session | null = null;
    if (req.sessionId) {
      head = this.d.sessions.head(req.sessionId);
      if (!head || !belongs(head)) return { ok: false, reason: "no_session" };
      const existing = this.openHeads().get(head.id);
      if (existing) {
        if (prefill) this.prefill(existing, prefill, 0);
        return { ok: true, termId: existing, alreadyOpen: true };
      }
    }
    const claude = this.d.claude();
    if (!claude.path) return { ok: false, reason: "claude_missing" };
    const termId = start({ path: claude.path, pathValue: claude.pathValue }, head);
    if (typeof termId !== "string") return termId;
    if (prefill) this.prefill(termId, prefill);
    return { ok: true, termId, alreadyOpen: false };
  }

  /**
   * 修复 session（设计文档 2026-10-31）：在 feature 工作区里开一个 feature 级的 session，把卡住 session 的情况和规则作为任务发给它。
   * 不是总控，不受运行数量上限限制；同一个卡住的 session 已经有修复 session 在跑时返回那一个。
   */
  async openFix(req: OpenFixSessionRequest): Promise<OpenSessionResult> {
    await this.d.ready();
    const feature = this.d.features?.get(req.featureId);
    if (!feature || feature.archivedAt !== null) return { ok: false, reason: "no_ticket" };
    const stuck = this.d.sessions.head(req.stuckSessionId);
    const ticket = stuck?.ticketKey ? this.d.tickets.get(stuck.ticketKey) : null;
    if (!stuck || !ticket || ticket.featureId !== feature.id) return { ok: false, reason: "no_session" };
    const running = this.runningFix(stuck.id);
    if (running) return { ok: true, termId: running, alreadyOpen: true };
    const activity = this.d.activity?.(stuck.id);
    if (!activity) return { ok: false, reason: "no_session" };
    const claude = this.d.claude();
    if (!claude.path) return { ok: false, reason: "claude_missing" };

    const coordinator = this.runningCoordinator(feature.id);
    const [sessionName, coordinatorName] = await Promise.all([this.sessionName(stuck.id), coordinator ? this.sessionName(coordinator.id) : null]);
    // 查名字时等了磁盘：另一次点击可能已经开好了。从这里到终端打开都是同步的，不会再开第二个。
    const opened = this.runningFix(stuck.id);
    if (opened) return { ok: true, termId: opened, alreadyOpen: true };

    const termId = this.startInFeature(feature, { path: claude.path, pathValue: claude.pathValue }, { fixes: stuck.id });
    const message = fixTaskMessage({
      ticket: ticket.title ? `${ticket.key} ${ticket.title}` : ticket.key, sessionId: stuck.id, sessionName, coordinatorName,
      coordinatorDir: coordinator ? feature.workspaceDir : null, cwd: stuck.cwd,
      activity: describeActivity(activity), reason: activity.reason ?? "", lastOutput: activity.lastOutput,
    }, currentLang());
    // 不等任务写完：等输入框就绪可能要十几秒（用户还要处理信任文件夹之类的对话框），界面先切到新终端。
    this.d.submit?.(termId, message).then(
      (res) => res === "sent" || this.d.log?.(`fix task for ${termId} not delivered (${res})`),
      (e: unknown) => this.d.log?.(`fix task for ${termId} failed`, e),
    );
    return { ok: true, termId, alreadyOpen: false };
  }

  private async sessionName(sessionId: string): Promise<string | null> {
    return (await this.d.sessionName?.(sessionId)) ?? null;
  }

  /** 这个卡住的 session 的修复 session 在哪个终端里跑。fixesSession 记的可能是它 /clear 之前的 id，沿链比较。 */
  private runningFix(stuckId: string): string | null {
    for (const [id, termId] of this.openHeads()) {
      const fixes = this.d.sessions.get(id)?.fixesSession;
      if (fixes && this.d.sessions.head(fixes)?.id === stuckId) return termId;
    }
    return null;
  }

  /** 这个 feature 有终端在跑的总控（最近活动的那个）。 */
  private runningCoordinator(featureId: number): Session | null {
    const heads = this.openHeads();
    return this.d.sessions.listFeatureCoordinators(featureId).find((s) => s.coordinator && heads.has(s.id)) ?? null;
  }

  /** 在 feature 工作区里启动 claude，返回终端 id：恢复 head；没有 head 时新建一行，给了 fixes 就是修复 session，否则是总控。 */
  private startInFeature(feature: Feature, claude: Claude, from: { head?: Session | null; fixes?: string }): string {
    return this.startInWorkspace({
      label: `feature ${feature.id}`,
      workspace: this.d.ticketService.featureWorkspaceDir(feature.id),
      repoPaths: feature.repos.map((r) => r.repoPath),
      // feature 下未归档 ticket 的仓库工作目录。
      dirs: this.d.tickets.listByFeature(feature.id).flatMap((t) => t.repos.map((r) => this.d.ticketService.workDir(r))),
      mcpConfig: () => this.d.featureMcpConfig?.(feature.id, feature.epicId) ?? null,
      row: { coordinator: !from.fixes, featureId: feature.id, fixesSession: from.fixes ?? null },
    }, claude, from.head ?? null);
  }

  /** 工作区不见了（用户删了）就重建，和 feature 一样；建不了时返回错误，不抛。 */
  private startInEpic(epic: Epic, claude: Claude, head: Session | null): string | OpenFailure {
    const cwd = head?.cwd || epic.workspaceDir;
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (e) {
      this.d.log?.(`epic ${epic.id}: cannot create ${cwd}`, e);
      return { ok: false, reason: "no_repo" };
    }
    const repoPaths = epic.repos.map((r) => r.repoPath);
    return this.startInWorkspace({
      label: `epic ${epic.id}`,
      workspace: epic.workspaceDir,
      repoPaths,
      dirs: repoPaths,
      mcpConfig: () => this.d.epicMcpConfig?.(epic.id) ?? null,
      row: { epicId: epic.id },
    }, claude, head);
  }

  /** 在工作区里启动 claude，返回终端 id：恢复 head；没有 head 时按 target.row 新建一行。 */
  private startInWorkspace(target: WorkspaceTarget, claude: Claude, head: Session | null): string {
    const { path: claudePath, pathValue } = claude;
    const cwd = head?.cwd || target.workspace;
    const launch = resolveLaunch(claudePath, [], this.d.platform, { ...this.d.launchFs, pathValue });
    const mcpConfigPath = this.configPath(target.label, target.mcpConfig, claudePath, launch.viaCmd);
    const settingsPath = this.configPath(target.label, () => this.d.mcpSettings?.([cwd, ...target.repoPaths]) ?? null, claudePath, launch.viaCmd, "MCP approval settings");
    const addDirs = this.workspaceAddDirs(target, claudePath, launch.viaCmd);
    let termId: string;
    let args: string[];
    let insertedRow = false;
    if (head) {
      termId = head.id;
      args = claudeArgs({ mode: this.d.transcriptExists(head.id) ? "resume" : "new", sessionId: head.id, mcpConfigPath, settingsPath, addDirs });
    } else {
      termId = this.d.newId();
      args = claudeArgs({ mode: "new", sessionId: termId, mcpConfigPath, settingsPath, addDirs });
      const now = this.d.now();
      insertedRow = this.d.sessions.insertIfAbsent({
        id: termId, ticketKey: null, cwd, origin: "butler", lastActivityAt: now, createdAt: now, ...target.row,
      });
    }
    try {
      const full = withArgs(launch, args);
      this.d.pty.open(termId, { file: full.file, args: full.args }, { cwd, env: launchEnv(full, sessionEnv(this.d.baseEnv, { pathValue, sessionId: termId })) });
    } catch (e) {
      if (insertedRow) this.d.sessions.delete(termId);
      throw e;
    }
    return termId;
  }

  /** 工作区之外要另外加的目录（同样的存在、cmd.exe 检查）。 */
  private workspaceAddDirs(target: WorkspaceTarget, claudePath: string, viaCmd: boolean): string[] {
    const dirs = dirsOutsideWorkspace(target.dirs, target.workspace, { same: (a, b) => samePath(a, b, this.d.platform), exists: this.d.dirExists ?? existsSync });
    return dirs.filter((dir) => {
      if (!viaCmd || cmdShimSafe(claudePath, dir, this.d.platform)) return true;
      this.d.log?.(`session in ${target.label}: ${dir} cannot pass through cmd.exe safely; not added`);
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

  /** feature 正在运行的终端数：feature 级 session（总控和修复 session），加上它所有 ticket 的终端。 */
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

  /** epic 自己的 session 正在运行的终端数（不算它下面的 feature）。 */
  epicTerminalCount(epicId: number): number {
    return this.d.pty.openIds().filter((termId) => this.d.sessions.head(termId)?.epicId === epicId).length;
  }

  hasEpicTerminal(epicId: number): boolean {
    return this.epicTerminalCount(epicId) > 0;
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

  /** 未归档的 feature，带上它的 ticket 和 feature 级 session（总控和修复 session）。 */
  featureViews(): FeatureView[] {
    const heads = this.openHeads();
    const tickets = this.allTicketViews(heads);
    return (this.d.features?.list() ?? []).map((f) => {
      const { sessions, hiddenSessions } = this.split(this.d.sessions.listByFeature(f.id), heads);
      // 按建立顺序（和 list_tickets 一样），不是单独 ticket 列表的最新在前。
      const own = tickets.filter((t) => t.featureId === f.id).sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
      const ticketPrs: Record<string, Pr[]> = {};
      const activity: Record<string, SessionActivity> = {};
      for (const t of own) {
        ticketPrs[t.key] = this.d.handoffs?.knownPrs(t.key) ?? [];
        const a = mostUrgent(t.sessions.filter((s) => s.termId !== null).flatMap((s) => this.d.activity?.(s.id) ?? []));
        if (a) activity[t.key] = a;
      }
      return {
        ...f, tickets: own, sessions, hiddenSessions, waiting: sessions.some((s) => s.waitingForInput) || own.some((t) => t.waiting),
        summary: this.d.featureHandoffs?.latest(f.id) ?? null, ticketPrs, activity,
      };
    });
  }

  /** (featureId → 汇总是否变过的 stamp + 结果)：已归档的 feature 和汇总没变的 feature 不用每次状态变化都查库。 */
  private readonly validSummaries = new Map<number, { stamp: string; rec: FeatureHandoffRecord | null }>();

  /** epic 下一个 feature 的实时标志，只算这几个标志（不建完整的 FeatureView）。 */
  private liveOf(featureId: number, heads: Map<string, string>): LiveFeature {
    const tickets = this.d.tickets.listByFeature(featureId);
    const own = this.split(this.d.sessions.listByFeature(featureId), heads);
    let waiting = own.sessions.some((s) => s.waitingForInput);
    let stuck = false;
    for (const t of tickets) {
      for (const s of this.split(this.d.sessions.listByTicket(t.key), heads).sessions) {
        waiting ||= s.waitingForInput;
        if (s.termId !== null && this.d.activity?.(s.id)?.stuck === true) stuck = true;
      }
    }
    return {
      stuck, waiting,
      started: tickets.length > 0 || own.sessions.length + own.hiddenSessions.length > 0,
      summary: this.d.featureHandoffs?.latest(featureId) ?? null,
    };
  }

  /** epic 下各 feature 的一行情况，以及其中有没有在等用户的 feature。 */
  private epicRowsFrom(epicId: number, heads: Map<string, string>): { rows: EpicFeatureRow[]; waiting: boolean } {
    const fh = this.d.featureHandoffs;
    if (!this.d.features || !fh) return { rows: [], waiting: false };
    let waiting = false;
    const rows = epicFeatureRows(epicId, {
      features: this.d.features,
      latestValid: (id, stamp) => {
        const hit = this.validSummaries.get(id);
        if (hit && hit.stamp === stamp) return hit.rec;
        const rec = fh.latestValid(id);
        this.validSummaries.set(id, { stamp, rec });
        return rec;
      },
      live: (id) => {
        const l = this.liveOf(id, heads);
        waiting ||= l.waiting;
        return l;
      },
    });
    return { rows, waiting };
  }

  /** 一个 epic 下各 feature 的情况（渲染 epic handoff 用）。 */
  epicFeatureRows(epicId: number): EpicFeatureRow[] {
    return this.epicRowsFrom(epicId, this.openHeads()).rows;
  }

  /** 未归档的 epic，带上它的 session 和下面各 feature 的情况。没有 epic 时什么都不算（每次状态变化都会调用）。 */
  epicViews(): EpicView[] {
    const list = this.d.epics?.list() ?? [];
    if (list.length === 0) return [];
    const heads = this.openHeads();
    return list.map((e) => {
      const { sessions, hiddenSessions } = this.split(this.d.sessions.listByEpic(e.id), heads);
      const { rows, waiting } = this.epicRowsFrom(e.id, heads);
      return {
        ...e, sessions, hiddenSessions, features: rows,
        waiting: sessions.some((s) => s.waitingForInput) || waiting,
        stuck: rows.some((f) => f.status === "stuck"),
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
    // ticket 的 session、feature 级 session，或者 epic session。
    if (!s || (!s.ticketKey && s.featureId === null && s.epicId === null)) throw new TicketError("not_found", M().sessionNotFound);
    if (this.openHeads().has(s.id)) throw new TicketError("sessions_open", M().sessionTerminalHide);
    this.d.sessions.dismiss(s.id);
  }

  unhide(sessionId: string): void {
    const s = this.d.sessions.get(sessionId);
    if (!s || (!s.ticketKey && s.featureId === null && s.epicId === null)) throw new TicketError("not_found", M().sessionNotFound);
    this.d.sessions.undismiss(s.id);
  }
}
