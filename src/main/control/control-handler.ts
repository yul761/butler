import { basename } from "node:path";
import type { SessionActivity } from "../../shared/activity";
import {
  sanitizeTask, taskMessage,
  type ControlRequest, type SessionCapacity, type ControlResult, type FeatureControlRequest, type InboxControlOp, type StartModel,
} from "../../shared/control";
import { effectiveStatus, type Block, type Feature, type FeatureRepo, type OpenSessionResult, type Session, type Ticket, type TicketRepo } from "../../shared/types";
import type { BlocksRepo } from "../db/blocks-repo";
import type { FeaturesRepo } from "../db/features-repo";
import { currentLang } from "../i18n";
import { M } from "../strings";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SessionModelChoice } from "../routing/routing-service";
import type { TicketsRepo } from "../db/tickets-repo";
import type { PreReviewView } from "../../shared/prereview";
import { resultForSession } from "../prereview/delivery";
import { admitOrRefuse, type AdmissionGate } from "./admission";
import type { StackControl } from "./stack-control";
import { shipherdControl, type ShipherdControlDeps } from "./shipherd-control";
import type { InboxService } from "../inbox/inbox-service";
import type { DeliverResult } from "../sessions/pty-manager";
import type { SessionService } from "../sessions/session-service";
import { startRefresh, type SessionRefresher } from "../sessions/session-refresher";
import { DEFAULT_TICKET_PATTERN } from "../tickets/ticket-key";
import { samePath, TicketError, type TicketService } from "../tickets/ticket-service";
import type { Mailbox } from "../mailbox/mailbox";
import type { ResumeStart, WakeState } from "../sessions/resumer";
import { isWorkflowCoordinatorOp, type WorkflowCoordinatorOp } from "../../shared/workflow-control";
import { WF } from "../workflow/strings";
import type { WorkflowControl } from "../workflow/workflow-control";

export interface ControlHandlerDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  ticketService: Pick<TicketService, "workDir" | "create">;
  sessionService: Pick<SessionService, "open" | "openTerminalCount" | "isRunning" | "termIdOf"> & Partial<Pick<SessionService, "featureTerminalCount" | "openFeature" | "runningCoordinator">>;
  /** feature 总控的请求（设计文档 2026-10-26）；不给就拒绝。 */
  features?: FeaturesRepo;
  /** epic 里的 feature（BTL-246，内部叫 block）：list_features、create_feature、reorder_features、set_ticket_feature 和 create_ticket 的 feature。不给就拒绝。 */
  blocks?: BlocksRepo;
  /** session 此刻的活动；监控还没看到它时为 null。 */
  activity?: (sessionId: string) => SessionActivity | null;
  /** session 当前命令输出的末尾（上限 4KB）。 */
  activityOutput?: (sessionId: string) => Promise<string>;
  /** end_session：关掉终端，和用户在界面上点 × 一样（pty.kill；session 留在列表里，之后能恢复）。 */
  kill: (termId: string) => void;
  /** end_session 结束一个休眠着的 session（WS-M B）：不再算休眠、不再自动唤醒，留下的 watcher 放开，等待标记清掉。 */
  endHibernated?: (headId: string) => void;
  /** refresh_session（计划 16）：先同步 precheck，能开始就在后台换新，不等它跑完。不给就拒绝。 */
  refresher?: Pick<SessionRefresher, "precheck" | "refresh">;
  /** 屏幕上有权限确认或启动对话框（PtyManager.screenNeedsUser）：这时不能结束。 */
  screenNeedsUser: (termId: string) => boolean;
  /** session 最后一条 assistant 文字回复的结尾（最多 500 字符）；读不到为 null。 */
  lastReply?: (sessionId: string) => string | null;
  /** 设置里的记忆开关（memoryOn）：关着时交任务不提 recall。不给当作开着。 */
  memoryEnabled?: () => boolean;
  /** 把任务作为第一条消息交给新 session（等启动对话框过去、输入框就绪、粘贴、回车）。 */
  submit: (termId: string, message: string) => Promise<DeliverResult>;
  notify: () => void;
  /**
   * 信箱（BTL-245）：Shipherd 总控和 feature 总控的 send_message 一律排队，不再因为对方在忙被拒。不给时 send_message 报「没开」。
   */
  mailbox?: Pick<Mailbox, "send" | "opened" | "views">;
  /**
   * 后台恢复关着的 session（BTL-256）：send_message 的目标终端关着时等这一次准入和打开的结果，返回值里写清楚。
   * 熔断压着、没接时为 null（不写 wake）。
   */
  resume?: (sessionId: string) => Promise<ResumeStart | null>;
  /** list_sessions 每行的 wake：关着的收到消息时会怎样。 */
  wakeState?: (sessionId: string) => WakeState;
  /** ask_user、report（BTL-190 第 2+3 点）；不给就拒绝。 */
  inbox?: Pick<InboxService, "ask" | "report">;
  /** Shipherd 总控的请求（BTL-190 第 5 点）；不给就拒绝。 */
  shipherd?: ShipherdControlDeps;
  /** 开发 session 的 submit_evidence、pre_review_result（工作流 G）；不给就拒绝。 */
  preReview?: {
    submit(sessionId: string, raw: unknown): Promise<{ ok: boolean; message: string }>;
    latest(sessionId: string): PreReviewView | null;
  };
  /** 设置里的 ticket 号格式：create_ticket 的号不对时告诉总控（不给用默认格式）。 */
  ticketPattern?: () => string;
  /**
   * start_session 的 model（档位或名字）→ 实际用的模型（RoutingService.sessionModel）。
   * 不给时原样传（2.1.0 的行为）。
   */
  sessionModel?: (requested: string) => SessionModelChoice;
  /**
   * 开新终端前按内存放行（工作流 W，取代每 ticket、每 feature 的固定上限）：start_session、
   * Shipherd 总控打开关着的总控都先问它；list_sessions 带上还能再开几个。不给时一律放行。
   */
  admission?: AdmissionGate;
  /** 栈式 PR（工作流 K）：list_stacks、stack_define、stack_rebase、stack_layer_mode 和 create_ticket 的 stack_on。不给时这些都报「没开」。 */
  stacks?: StackControl;
  log?: (msg: string, err?: unknown) => void;
  /** 工作流程（BTL-273）：workflow_step_done 和总控的 get/set/list_workflow_presets。不给就报「没开」。 */
  workflow?: WorkflowControl;
}

/** 除了 ask_user、report 和工作流程以外的请求（那几个先单独处理）。 */
type NonInbox<T> = Exclude<T, { op: InboxControlOp["op"] | WorkflowCoordinatorOp["op"] }>;

const ok = (value: unknown): ControlResult => ({ v: 1, ok: true, value });
const fail = (error: string): ControlResult => ({ v: 1, ok: false, error });
/** 带上现在还能再开几个（工作流 W）；sessions-server 把它写成单独一行。 */
const okCap = (value: unknown, capacity: SessionCapacity | undefined): ControlResult => (capacity ? { v: 1, ok: true, value, capacity } : ok(value));

/** 打不开 session 时给总控看的原因。 */
function openError(r: Extract<OpenSessionResult, { ok: false }>, repo: TicketRepo): string {
  switch (r.reason) {
    case "branch_mismatch":
      return M().ctlBranchMismatch(basename(repo.repoPath), r.current, r.expected);
    case "claude_missing":
      return M().ctlClaudeMissing;
    case "ticket_busy":
      return M().ctlTicketBusy;
    default:
      return M().ctlOpenFailed(r.reason);
  }
}

/**
 * 处理总控发来的请求（设计文档 2026-10-23 第二步）。请求文件谁都能写：ticket、仓库、开启者都在这里重新核对。
 */
export function controlHandler(d: ControlHandlerDeps): (req: ControlRequest) => Promise<ControlResult> {
  const name = (r: { repoPath: string }) => basename(r.repoPath);
  const repoNameOf = (t: Ticket, id: number | null) => {
    const r = t.repos.find((x) => x.id === id);
    return r ? name(r) : null;
  };

  const findRepo = (t: Ticket, wanted: string): TicketRepo | string => {
    const byPath = t.repos.find((r) => samePath(wanted, r.repoPath) || samePath(wanted, d.ticketService.workDir(r)));
    if (byPath) return byPath;
    const byName = t.repos.filter((r) => name(r).toLowerCase() === wanted.trim().toLowerCase());
    if (byName.length === 1) return byName[0];
    const names = t.repos.map(name).join(", ") || M().ctlNoRepos;
    return byName.length > 1 ? M().ctlRepoAmbiguous(wanted, t.repos.map((r) => d.ticketService.workDir(r)).join(", ")) : M().ctlNoSuchRepo(wanted, names);
  };

  /** 在 ticket 的这个仓库里开子 session，把任务交给它。开之前按内存放行（工作流 W）。 */
  const start = async (t: Ticket, repo: TicketRepo, rawTask: string, spawnedBy: string | null, model: StartModel | undefined, memory: "feature" | "ticket", extra: object = {}): Promise<ControlResult> => {
    const task = sanitizeTask(rawTask);
    if (!task) return fail(M().ctlEmptyTask);
    // 档位或名字 → 实际的模型；不认识的名字在开终端之前就拒绝。
    let actual: string | null | undefined = model;
    if (model !== undefined && d.sessionModel) {
      const c = d.sessionModel(model);
      if (!c.ok) return fail(c.error);
      actual = c.model;
    }
    const room = await admitOrRefuse(d.admission, `start_session ${t.key}`);
    if (!room.ok) return fail(room.error);
    let r: OpenSessionResult;
    try {
      r = await d.sessionService.open({ ticketKey: t.key, repoId: repo.id }, { spawnedBy: spawnedBy ?? undefined, model: actual ?? undefined });
    } catch (err) {
      room.release();
      throw err;
    }
    if (!r.ok) {
      room.release();
      return fail(openError(r, repo));
    }
    d.notify();
    // 不等任务写完：等输入框就绪可能要十几秒（用户还要处理信任文件夹之类的对话框），总控先拿到 session id。
    // 记忆关着时不让它去 recall（R36）：没有东西可读。
    d.submit(r.termId, taskMessage(task, currentLang(), d.memoryEnabled?.() === false ? null : memory)).then(
      (res) => res === "sent" || d.log?.(`control: task for ${r.termId} not delivered (${res})`),
      (e: unknown) => d.log?.(`control: task for ${r.termId} failed`, e),
    );
    return okCap({
      sessionId: r.termId, ...(model !== undefined && { model: actual ?? null }), ...(model !== undefined && actual !== model && { requestedModel: model }),
      ...extra, repo: name(repo), dir: d.ticketService.workDir(repo),
      note: M().ctlTaskNote,
    }, room.capacity);
  };

  const lastReply = (id: string) => d.lastReply?.(id) ?? null;

  /** list_sessions：带上现在还能再开几个（工作流 W）。 */
  const listed = async (rows: unknown[]): Promise<ControlResult> => okCap(rows, d.admission ? await d.admission.capacity() : undefined);

  const sessionRow = (t: Ticket | null, s: { id: string; coordinator: boolean; repoId: number | null; firstPrompt: string | null; waitingForInput: boolean; lastActivityAt: number | null; spawnedBy: string | null; hibernatedAt?: number | null }) => {
    const running = d.sessionService.isRunning(s.id);
    return {
    id: s.id,
    repo: s.coordinator ? M().ctlCoordinator : t ? repoNameOf(t, s.repoId) : null,
    firstPrompt: s.firstPrompt,
    running,
    // 休眠着（WS-M B）：进程被 Shipherd 结束了，不占内存；有消息时自动唤醒，不要了就 end_session。
    hibernated: !running && !!s.hibernatedAt,
    waitingForInput: s.waitingForInput,
    lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : null,
    startedByCoordinator: s.spawnedBy !== null,
    // BTL-256：关着的收到消息时会怎样（running、resumes、ended_by_user……）。
    ...(d.wakeState && { wake: d.wakeState(s.id) }),
    activity: listedActivity(s.id),
    last_reply: lastReply(s.id),
    };
  };

  /** list_sessions 里的活动：不带 lastOutput（要看输出用 session_activity）；监控还没看到的是 null。 */
  function listedActivity(id: string) {
    const a = d.activity?.(id) ?? null;
    if (!a) return null;
    const rest: Partial<SessionActivity> = { ...a };
    delete rest.lastOutput;
    return rest;
  }

  /** session_activity：session 是 list_sessions 里的 id，/clear 之前的旧 id 也认。belongs 判断它是不是总控管的。 */
  const sessionActivity = async (wanted: string, belongs: (s: Session) => boolean): Promise<ControlResult> => {
    const h = d.sessions.head(wanted);
    if (!h || !belongs(h)) return fail(M().ctlNoSuchSession(wanted));
    const a = listedActivity(h.id);
    // 监控还没看到：键和有活动时一样，值都是 null
    if (!a) return ok({ sessionId: h.id, kind: null, detail: null, background: null, startedAt: null, lastOutputAt: null, stuck: null, reason: null, action: null, limit: null, output: "", last_reply: lastReply(h.id) });
    let output = "";
    try {
      output = (await d.activityOutput?.(h.id)) ?? "";
    } catch (e) {
      d.log?.(`control: output of ${h.id} failed`, e);
    }
    return ok({ ...a, output, last_reply: lastReply(h.id) });
  };

  /**
   * end_session：总控结束它管的、已经停下来在等输入的 session，和用户点 × 一样只关终端（记录都在，之后能恢复）。
   * 用户是不是还要回话由总控看 last_reply 判断；这里只拒绝看得准的：终端没开、正在干活、屏幕上有等用户回答的确认。
   * 不能结束自己（from 是 /clear 之前的 id 也认）。
   */
  const endSession = (req: { from: string | null; session: string; reason: string }, belongs: (s: Session) => boolean): ControlResult => {
    const h = d.sessions.head(req.session);
    const self = req.from ? (d.sessions.head(req.from)?.id ?? req.from) : null;
    if (!h || !belongs(h) || h.id === self) return fail(M().ctlNoSuchSession(req.session));
    const termId = d.sessionService.termIdOf(h.id);
    if (!termId && h.hibernatedAt && d.endHibernated) {
      // 休眠着的：进程早就结束了，这里只是让它不再占上限、不再自动唤醒。
      d.endHibernated(h.id);
      d.log?.(`end_session ${h.id} (hibernated) by ${req.from ?? "?"}: ${req.reason.replace(/\s+/g, " ").trim()}`);
      return ok({ ended: true });
    }
    if (!termId) return fail(M().ctlSessionNotRunning(h.id));
    // 监控还没看到（刚开的终端）也当作在忙：看不准就不关。
    const kind = d.activity?.(h.id)?.kind ?? null;
    if ((kind !== "idle" && kind !== "waiting") || !h.waitingForInput) return fail(M().ctlSessionBusy(h.id, kind ?? "unknown"));
    if (d.screenNeedsUser(termId)) return fail(M().ctlSessionNeedsUser(h.id));
    d.kill(termId);
    d.log?.(`end_session ${h.id} by ${req.from ?? "?"}: ${req.reason.replace(/\s+/g, " ").trim()}`);
    return ok({ ended: true });
  };

  /**
   * refresh_session（计划 16）：范围和 end_session 一样，不能对自己（from 是 /clear 之前的 id 也认）。
   * 能不能开始由换新自己马上回答（precheck）；开始了就先返回 { started: true }，换新在后台跑，结果只记日志。
   */
  const refreshSession = (req: { from: string | null; session: string }, belongs: (s: Session) => boolean): ControlResult => {
    const h = d.sessions.head(req.session);
    const self = req.from ? (d.sessions.head(req.from)?.id ?? req.from) : null;
    if (!h || !belongs(h) || h.id === self) return fail(M().ctlNoSuchSession(req.session));
    if (!d.refresher) return fail(M().ctlRefreshRefused(h.id, "failed"));
    const refused = startRefresh(d.refresher, h.id, "coordinator", (m, e) => d.log?.(m, e));
    if (refused) return fail(M().ctlRefreshRefused(h.id, refused));
    d.log?.(`refresh_session ${h.id} by ${req.from ?? "?"}: started`);
    return ok({ started: true });
  };

  /** list_sessions 的可见行：/clear 之前的旧行和用户隐藏的不列。 */
  const visible = <T extends { replacedBy: string | null; dismissed: boolean }>(rows: T[]) => rows.filter((s) => !s.replacedBy && !s.dismissed);

  /** 一个 feature 的 session：feature 级的（总控、修复）和它每个 ticket 的。修复 session 的 fixes 沿链走到现在的 id，和列表里的 id 对得上。 */
  const featureSessionRows = (f: Feature, own: Ticket[]) => {
    const fixes = (s: Session) => (s.fixesSession ? (d.sessions.head(s.fixesSession)?.id ?? s.fixesSession) : null);
    return [
      ...visible(d.sessions.listByFeature(f.id)).map((s) => ({ ...sessionRow(null, s), ticket: null, fixes: fixes(s) })),
      ...own.flatMap((t) => visible(d.sessions.listByTicket(t.key)).map((s) => ({ ...sessionRow(t, s), ticket: t.key, fixes: null }))),
    ];
  };

  /**
   * 总控在 feature 下建 ticket：和界面上“新建 ticket”一样走 TicketService.create（worktree 模式，放进 feature 工作区）。
   * 仓库按名字或路径从 feature 的仓库里选；feature 只有一个仓库时可以不写。
   */
  const createTicket = async (f: Feature, req: Extract<FeatureControlRequest, { op: "create_ticket" }>): Promise<ControlResult> => {
    // 要放进的 feature（block）先核对：不对就什么都不建。
    let block: Block | null = null;
    if (req.feature !== undefined) {
      const b = findBlock(f, req.feature);
      if (typeof b === "string") return fail(b);
      block = b;
    }
    const names = f.repos.map(name).join(", ");
    if (f.repos.length === 0) return fail(M().ctlFeatureNoRepos);
    let picked: FeatureRepo[];
    if (req.repos === undefined || req.repos.length === 0) {
      if (f.repos.length > 1) return fail(M().ctlPickFeatureRepos(names));
      picked = f.repos;
    } else {
      picked = [];
      for (const wanted of req.repos) {
        const byPath = f.repos.find((r) => samePath(wanted, r.repoPath));
        const byName = f.repos.filter((r) => name(r).toLowerCase() === wanted.trim().toLowerCase());
        const r = byPath ?? (byName.length === 1 ? byName[0] : null);
        if (!r) return fail(byName.length > 1 ? M().ctlRepoAmbiguous(wanted, byName.map((x) => x.repoPath).join(", ")) : M().ctlNoSuchFeatureRepo(wanted, names));
        if (!picked.includes(r)) picked.push(r);
      }
    }
    // stack_on（工作流 K）：建 worktree 之前先核对能不能接，新分支从下面那层的分支开出来。
    let startPoints: { repoPath: string; ref: string }[] | undefined;
    if (req.stack_on !== undefined) {
      if (!d.stacks) return fail(M().ctlStacksOff);
      const prep = d.stacks.prepareStackOn(f.id, req.stack_on, picked.map((r) => r.repoPath));
      if ("error" in prep) return fail(prep.error);
      startPoints = prep.startPoints;
    }
    let t: Ticket;
    try {
      t = await d.ticketService.create({
        key: req.ticket, title: req.title, featureId: f.id, workMode: "worktree",
        repoPaths: picked.map((r) => r.repoPath), ...(req.branch !== undefined && { branch: req.branch }),
        ...(startPoints && { startPoints }),
      });
    } catch (e) {
      if (e instanceof TicketError && e.code === "invalid_key") return fail(M().ctlInvalidKey(req.ticket, d.ticketPattern?.() ?? DEFAULT_TICKET_PATTERN));
      if (e instanceof TicketError) return fail(e.message);
      d.log?.(`control: create_ticket ${req.ticket} failed`, e);
      return fail((e as Error).message);
    }
    if (block) d.tickets.setBlock(t.key, block.id);
    const stackProblems = startPoints && d.stacks ? await d.stacks.finishStackOn(f, t, startPoints).catch((e: unknown) => [(e as Error).message]) : [];
    d.notify();
    return ok({
      key: t.key, title: t.title,
      repos: t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), branch: r.branch })),
      ...(block && { feature: block.name }),
      note: M().ctlTicketCreated,
      ...(startPoints && { stacked: stackProblems.length === 0, ...(stackProblems.length > 0 && { stackProblems }) }),
    });
  };

  /** epic 里的 feature（block）：数字先当 id，再按名字（不分大小写）；找不到返回给总控看的原因。 */
  const findBlock = (f: Feature, wanted: string): Block | string => {
    if (!d.blocks) return M().ctlBlocksOff;
    const list = d.blocks.list(f.id);
    const hit = (/^\d+$/.test(wanted) ? list.find((b) => b.id === Number(wanted)) : undefined) ?? d.blocks.byName(f.id, wanted);
    return hit ?? M().ctlNoSuchBlock(wanted, list.map((b) => b.name).join(", ") || M().ctlNoBlocks);
  };

  /** list_features、create_feature、reorder_features、set_ticket_feature（BTL-246）。 */
  const blockRequest = (f: Feature, own: Ticket[], req: Extract<FeatureControlRequest, { op: "list_features" | "create_feature" | "reorder_features" | "set_ticket_feature" }>): ControlResult => {
    const blocks = d.blocks;
    if (!blocks) return fail(M().ctlBlocksOff);
    if (req.op === "list_features") {
      const row = (t: Ticket) => ({ key: t.key, title: t.title, status: effectiveStatus(t) });
      const features = blocks.list(f.id).map((b, i) => {
        const mine = own.filter((t) => t.blockId === b.id);
        return {
          id: b.id, name: b.name, description: b.description, position: i + 1,
          tickets: mine.map(row), merged: mine.filter((t) => effectiveStatus(t) === "done").length, total: mine.length,
        };
      });
      const known = new Set(features.map((b) => b.id));
      return ok({ features, notInAFeature: own.filter((t) => t.blockId == null || !known.has(t.blockId)).map(row) });
    }
    if (req.op === "create_feature") {
      const same = blocks.byName(f.id, req.name);
      if (same) return fail(M().ctlBlockExists(same.name));
      let before: number | null = null;
      if (req.before !== undefined) {
        const b = findBlock(f, req.before);
        if (typeof b === "string") return fail(b);
        before = b.id;
      }
      const id = blocks.insert({ featureId: f.id, name: req.name, description: req.description ?? null, createdAt: Date.now(), before });
      d.notify();
      return ok({ id, name: req.name });
    }
    if (req.op === "reorder_features") {
      const list = blocks.list(f.id);
      const picked: Block[] = [];
      for (const wanted of req.order) {
        const b = findBlock(f, wanted);
        if (typeof b === "string" || picked.some((p) => p.id === b.id)) return fail(M().ctlReorderMismatch(list.map((x) => x.name).join(", ") || M().ctlNoBlocks));
        picked.push(b);
      }
      if (picked.length !== list.length) return fail(M().ctlReorderMismatch(list.map((x) => x.name).join(", ")));
      blocks.reorder(picked.map((b) => b.id));
      d.notify();
      return ok({ order: picked.map((b) => b.name) });
    }
    const t = own.find((x) => x.key === req.ticket.trim().toUpperCase());
    if (!t) return fail(M().ctlNoSuchTicket(req.ticket, own.map((x) => x.key).join(", ") || M().ctlNoTickets));
    let block: Block | null = null;
    if (req.feature !== null) {
      const b = findBlock(f, req.feature);
      if (typeof b === "string") return fail(b);
      block = b;
    }
    d.tickets.setBlock(t.key, block?.id ?? null);
    d.notify();
    return ok({ ticket: t.key, feature: block?.name ?? null });
  };

  /** feature 总控（设计文档 2026-10-26）：feature 和 ticket 都在这里重新核对，ticket 必须属于这个 feature 且未归档。 */
  /**
   * feature 总控的 send_message（BTL-245）：只能发给这个 feature 的 ticket session 和修复 session，排进它的信箱。
   * 从不因为它在忙被拒；终端关着时排着，下次打开再送。from 必须是这个 feature 开着终端的总控。
   */
  const featureSend = async (f: Feature, own: Ticket[], req: Extract<FeatureControlRequest, { op: "send_message" }>): Promise<ControlResult> => {
    if (!d.mailbox) return fail(M().ctlStartUnavailable);
    const h = req.from ? d.sessions.head(req.from) : null;
    if (!h || h.featureId !== f.id || !h.coordinator || !d.sessionService.termIdOf(h.id)) return fail(M().ctlInboxNotYours);
    const keys = new Set(own.map((t) => t.key));
    const t = d.sessions.head(req.session);
    const belongs = !!t && !t.dismissed && (t.ticketKey !== null ? keys.has(t.ticketKey) : t.featureId === f.id && t.fixesSession !== null);
    if (!t || !belongs) return fail(M().mailboxNotYours(req.session));
    const interrupt = req.interrupt === true;
    const body = sanitizeTask(M().mailboxInstruction(M().shipherdTargetFeature(f.name), req.text, interrupt));
    const r = d.mailbox.send({ kind: "instruction", from: h.id, to: t.id, featureId: f.id, body, interrupt });
    // 终端关着（BTL-256）：信箱已经叫恢复了（同一个请求），这里等准入和打开的结果，告诉总控是在恢复、等内存还是用户结束了。
    const w = r.state === "closed" && d.resume ? await d.resume(t.id) : null;
    if (w && w.state !== "running") {
      const error = "error" in w ? w.error : undefined;
      return ok({
        queued: true, sessionId: t.id, requestId: r.id, state: r.state, wake: w.state, ...(error !== undefined && { wakeError: error }),
        note: `${M().mailboxWakeNote(w.state, error)}${M().mailboxReplyNote}`,
      });
    }
    const state = w?.state === "running" ? "idle" : r.state;
    return ok({ queued: true, sessionId: t.id, requestId: r.id, state, note: `${M().mailboxSendNote(state)}${M().mailboxReplyNote}` });
  };

  const featureRequest = async (req: NonInbox<FeatureControlRequest>): Promise<ControlResult> => {
    const f = d.features?.get(req.featureId);
    if (!f || f.archivedAt !== null) return fail(M().ctlFeatureGone);
    const own = d.tickets.listByFeature(f.id);

    if (req.op === "list_tickets") {
      const blockName = new Map((d.blocks?.list(f.id) ?? []).map((b) => [b.id, b.name]));
      return ok(own.map((t) => ({
        key: t.key, title: t.title, status: effectiveStatus(t), feature: (t.blockId != null && blockName.get(t.blockId)) || null,
        repos: t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), branch: r.branch })),
        ...(d.workflow && { workflow: d.workflow.summary(t.key) }),
      })));
    }

    if (req.op === "list_repos") {
      return ok(f.repos.map((r) => ({ name: name(r), path: r.repoPath })));
    }

    if (req.op === "create_ticket") return createTicket(f, req);
    if (req.op === "list_features" || req.op === "create_feature" || req.op === "reorder_features" || req.op === "set_ticket_feature") return blockRequest(f, own, req);
    if (req.op === "list_stacks" || req.op === "stack_define" || req.op === "stack_rebase" || req.op === "stack_layer_mode") {
      return d.stacks ? d.stacks.handle({ kind: "feature", featureId: f.id }, req) : fail(M().ctlStacksOff);
    }

    if (req.op === "session_activity") {
      const keys = new Set(own.map((t) => t.key));
      return sessionActivity(req.session, (s) => (s.ticketKey !== null ? keys.has(s.ticketKey) : s.featureId === f.id));
    }

    if (req.op === "list_sessions") return listed(featureSessionRows(f, own));

    if (req.op === "send_message") return featureSend(f, own, req);

    if (req.op === "end_session" || req.op === "refresh_session") {
      // ticket 的 session 和这个 feature 的修复 session；feature 的总控不归总控关，也不归它换新（修复 session 换新会被拒绝）。
      const keys = new Set(own.map((t) => t.key));
      const belongs = (s: Session) => (s.ticketKey !== null ? keys.has(s.ticketKey) : s.featureId === f.id && s.fixesSession !== null);
      return req.op === "end_session" ? endSession(req, belongs) : refreshSession(req, belongs);
    }

    const t = own.find((x) => x.key === req.ticket.trim().toUpperCase());
    if (!t) return fail(M().ctlNoSuchTicket(req.ticket, own.map((x) => x.key).join(", ") || M().ctlNoTickets));
    let repo: TicketRepo | string;
    if (req.repo !== undefined) repo = findRepo(t, req.repo);
    else if (t.repos.length === 1) repo = t.repos[0];
    else repo = t.repos.length === 0 ? M().ctlTicketNoRepo(t.key) : M().ctlPickRepo(t.key, t.repos.map(name).join(", "));
    if (typeof repo === "string") return fail(repo);
    // from 必须是这个 feature 的总控，才记成子 session 的开启者。
    const h = req.from ? d.sessions.head(req.from) : null;
    const spawnedBy = h && h.featureId === f.id && h.coordinator ? req.from : null;
    return start(t, repo, req.task, spawnedBy, req.model, "feature", { ticket: t.key });
  };

  /**
   * ask_user、report（BTL-190 第 2+3 点）：调用的 session 必须认得出来（from），而且属于请求的作用域（ticket、feature、Shipherd 总控），
   * 免得别的进程冒充一个 session 提问。
   */
  const inboxRequest = (req: ControlRequest & InboxControlOp): ControlResult => {
    if (!d.inbox) return fail(M().ctlInboxOff);
    const h = req.from ? d.sessions.head(req.from) : null;
    if (!h) return fail(M().ctlInboxNoSession);
    const mine = "shipherd" in req ? h.shipherd && h.ticketKey === null
      : "featureId" in req ? h.featureId === req.featureId && h.ticketKey === null
      : h.ticketKey === req.ticketKey;
    if (!mine) return fail(M().ctlInboxNotYours);
    // 归档了的 ticket、feature 不再收：归档时 Shipherd 已经把它们未决的条目收起来，新的没人会看。
    if ("featureId" in req) {
      const f = d.features?.get(req.featureId);
      if (!f || f.archivedAt !== null) return fail(M().ctlFeatureGone);
    } else if ("ticketKey" in req) {
      const t = d.tickets.get(req.ticketKey);
      if (!t || t.archivedAt !== null) return fail(M().ctlTicketGone(req.ticketKey));
    }
    if (req.op === "ask_user") {
      const id = d.inbox.ask(h, { question: req.question, options: req.options, context: req.context, recommended: req.recommended });
      return ok({ id, note: M().ctlAskNote });
    }
    const r = d.inbox.report(h, req.text, req.kind);
    return ok({ id: r.id, note: r.noCoordinator ? M().ctlReportNoCoordinator : r.queued ? M().ctlReportQueued : M().ctlReportStored });
  };

  /** 证据和预审结果（工作流 G）：调用的必须是这个 ticket 的 session（和 ask_user 一样核对 from），按它自己的 head 记。 */
  const preReviewRequest = async (req: Extract<ControlRequest, { op: "submit_evidence" | "pre_review_result" }>, t: Ticket): Promise<ControlResult> => {
    if (!d.preReview) return fail(M().ctlPreReviewUnavailable);
    const h = req.from ? d.sessions.head(req.from) : null;
    if (!h) return fail(M().ctlInboxNoSession);
    if (h.ticketKey !== t.key) return fail(M().ctlInboxNotYours);
    if (req.op === "pre_review_result") {
      const v = d.preReview.latest(h.id);
      return v ? ok(resultForSession(v, currentLang())) : fail(M().ctlNoPreReview);
    }
    const r = await d.preReview.submit(h.id, req.evidence);
    return r.ok ? ok({ note: r.message }) : fail(r.message);
  };

  // Shipherd 总控（BTL-190 第 5 点）。
  const shipherdRequest = shipherdControl(d, { sessionActivity, refreshSession, listedActivity, lastReply });

  /**
   * 工作流程（BTL-273）的总控工具：调用的必须是这个作用域的总控（核对 from，和 ask_user 一样），epic 还得没归档。
   */
  const workflowRequest = (req: Extract<ControlRequest, { op: WorkflowCoordinatorOp["op"] }>): ControlResult => {
    if (!d.workflow) return fail(WF().ctlOff);
    const h = req.from ? d.sessions.head(req.from) : null;
    if (!h) return fail(M().ctlInboxNoSession);
    if ("shipherd" in req) {
      if (!h.shipherd || h.ticketKey !== null) return fail(M().ctlInboxNotYours);
      return d.workflow.coordinator(req, { shipherd: true });
    }
    if (h.featureId !== req.featureId || h.ticketKey !== null) return fail(M().ctlInboxNotYours);
    // 改流程只有这个 epic 的总控本人能做（和 featureSend 一样）：修复 session 也挂在 epic 上、ticketKey 为空，但只能读。
    if (req.op === "set_workflow" && (!h.coordinator || h.fixesSession !== null)) return fail(M().ctlInboxNotYours);
    const f = d.features?.get(req.featureId);
    if (!f || f.archivedAt !== null) return fail(M().ctlFeatureGone);
    return d.workflow.coordinator(req, { featureId: f.id });
  };

  return async (req) => {
    if (req.op === "ask_user" || req.op === "report") return inboxRequest(req);
    if (isWorkflowCoordinatorOp(req.op) && !("ticketKey" in req)) return workflowRequest(req as Extract<ControlRequest, { op: WorkflowCoordinatorOp["op"] }>);
    if ("shipherd" in req) return shipherdRequest(req as NonInbox<typeof req>);
    if ("featureId" in req) return featureRequest(req as NonInbox<typeof req>);
    const t = d.tickets.get(req.ticketKey);
    if (!t || t.archivedAt !== null) return fail(M().ctlTicketGone(req.ticketKey));
    if (req.op === "workflow_step_done") return d.workflow ? d.workflow.ticketStep(req, t) : fail(WF().ctlOff);
    return preReviewRequest(req, t);
  };
}
