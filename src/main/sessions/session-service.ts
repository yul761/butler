import { sanitizePrefill } from "../../shared/text";
import {
  effectiveStatus,
  type OpenSessionRequest,
  type OpenSessionResult,
  type Session,
  type TicketView,
  type UnclaimedSession,
} from "../../shared/types";
import { launchEnv, type LaunchDeps, resolveLaunch, withArgs } from "../claude/launch";
import { claudeArgs, cmdShimSafe, sessionEnv } from "../claude/spawn";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { TicketError, type TicketService } from "../tickets/ticket-service";
import { suggestTicket, type TranscriptState, UNCLAIMED_WINDOW_MS } from "./discovery";
import type { PtyManager } from "./pty-manager";

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
  /** 写好这个 ticket 的记忆 --mcp-config 文件并返回路径；记忆关闭或 bundle 不存在时返回 null（设计文档 8.4）。 */
  mcpConfig?: (ticketKey: string) => string | null;
  /** 要打开这个 ticket 的 session 时调用：把它的记忆补同步一次（排进记忆的同步队列，不等它）。 */
  syncMemory?: (ticketKey: string) => void;
  /** 读 claude.cmd shim 用的文件系统（测试注入；默认读真实磁盘）。 */
  launchFs?: Pick<LaunchDeps, "read" | "exists">;
  log?: (msg: string, err?: unknown) => void;
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

  async open(req: OpenSessionRequest): Promise<OpenSessionResult> {
    await this.d.ready();
    const prefill = req.prefill ? sanitizePrefill(req.prefill) : "";
    const ticket = this.d.tickets.get(req.ticketKey);
    if (!ticket) return { ok: false, reason: "no_ticket" };

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

    if (!req.force) {
      const check = await this.d.ticketService.checkBranch(ticket);
      if (!check.ok) return { ok: false, reason: "branch_mismatch", current: check.current, expected: check.expected, dirty: check.dirty };
    }

    const workDir = this.d.ticketService.workDir(ticket);
    this.syncMemory(ticket.key);
    // 启动方式只解析一次：记忆挂载的检查和真正启动用同一个结果（P5-PF10）。
    const launch = resolveLaunch(claudePath, [], this.d.platform, { ...this.d.launchFs, pathValue });
    const mcpConfigPath = this.mcpConfigFor(ticket.key, claudePath, launch.viaCmd);
    let termId: string;
    let cwd: string;
    let args: string[];
    let insertedRow = false;
    if (head) {
      // claude --resume 只能在 session 当初的项目目录里找到它；没发过消息的 session 没有记录，用同一个 id 重新开
      termId = head.id;
      cwd = head.cwd || workDir;
      args = claudeArgs({ mode: this.d.transcriptExists(head.id) ? "resume" : "new", sessionId: head.id, mcpConfigPath });
    } else {
      termId = this.d.newId();
      cwd = workDir;
      args = claudeArgs({ mode: "new", sessionId: termId, mcpConfigPath });
      const now = this.d.now();
      insertedRow = this.d.sessions.insertIfAbsent({ id: termId, ticketKey: ticket.key, cwd, origin: "butler", lastActivityAt: now, createdAt: now });
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

  /** 记忆补同步（最终审查 6）：失败只写日志，session 照常打开。 */
  private syncMemory(ticketKey: string): void {
    try {
      this.d.syncMemory?.(ticketKey);
    } catch (e) {
      this.d.log?.(`memory sync for ${ticketKey} not started`, e);
    }
  }

  /** 这个 ticket 的记忆 MCP 配置。写不出来、或者要经过 cmd.exe 又无法安全传递时不挂，session 照常打开。 */
  private mcpConfigFor(ticketKey: string, claudePath: string, viaCmd: boolean): string | undefined {
    let file: string | null;
    try {
      file = this.d.mcpConfig?.(ticketKey) ?? null;
    } catch (e) {
      this.d.log?.(`memory MCP config for ${ticketKey} not written`, e);
      return undefined;
    }
    if (!file) return undefined;
    // 计划 5：能认出的 shim 不经过 cmd.exe，路径原样传递；只有回退到 cmd.exe 时才需要这道检查（计划 4 的 P4-R7）。
    if (viaCmd && !cmdShimSafe(claudePath, file, this.d.platform)) {
      this.d.log?.(`memory MCP not mounted for ${ticketKey}: the config path cannot pass through cmd.exe safely`);
      return undefined;
    }
    return file;
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

  ticketViews(): TicketView[] {
    const heads = this.openHeads();
    return this.d.tickets.list().map((t) => {
      const sessions = this.d.sessions
        .listByTicket(t.key)
        .filter((s) => !s.replacedBy)
        .map((s) => ({ ...s, termId: heads.get(s.id) ?? null }));
      return { ...t, effectiveStatus: effectiveStatus(t), sessions, waiting: sessions.some((s) => s.waitingForInput) };
    });
  }

  unclaimed(): UnclaimedSession[] {
    const pattern = this.d.settings.get("ticketPattern");
    return this.d.sessions.listUnclaimed(this.d.now() - UNCLAIMED_WINDOW_MS).map((s) => {
      const key = suggestTicket(s, pattern);
      return { ...s, suggestedTicket: key, suggestionExists: !!key && !!this.d.tickets.get(key) };
    });
  }

  claim(sessionId: string, ticketKey: string): void {
    if (!this.d.tickets.get(ticketKey)) throw new TicketError("not_found", `找不到 ticket ${ticketKey}`);
    this.d.sessions.setTicket(sessionId, ticketKey);
  }

  dismiss(sessionId: string): void {
    this.d.sessions.dismiss(sessionId);
  }
}
