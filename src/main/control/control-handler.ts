import { basename } from "node:path";
import type { SessionActivity } from "../../shared/activity";
import {
  BRIEF_LIMIT, EPIC_PLAN_MAX_CHARS, MAX_RUNNING_PER_FEATURE, MAX_RUNNING_PER_TICKET, sanitizeTask, SUMMARY_LIMIT, taskMessage,
  type ControlRequest, type ControlResult, type EpicControlRequest, type FeatureControlRequest, type StartModel,
} from "../../shared/control";
import { effectiveStatus, type Epic, type EpicFeatureRow, type Feature, type FeatureRepo, type OpenSessionResult, type Session, type Ticket, type TicketRepo } from "../../shared/types";
import type { EpicsRepo } from "../db/epics-repo";
import type { FeaturesRepo } from "../db/features-repo";
import { currentLang } from "../i18n";
import { M } from "../strings";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { SessionService } from "../sessions/session-service";
import { startRefresh, type SessionRefresher } from "../sessions/session-refresher";
import { FEATURE_NAME_LIMIT, type FeatureService } from "../tickets/feature-service";
import { DEFAULT_TICKET_PATTERN } from "../tickets/ticket-key";
import { samePath, TicketError, type TicketService } from "../tickets/ticket-service";

export interface ControlHandlerDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  ticketService: Pick<TicketService, "workDir" | "create">;
  sessionService: Pick<SessionService, "open" | "openTerminalCount" | "isRunning" | "termIdOf"> & Partial<Pick<SessionService, "featureTerminalCount">>;
  /** feature 总控的请求（设计文档 2026-10-26）；不给就拒绝。 */
  features?: FeaturesRepo;
  /** epic session 的请求（设计文档 2026-11-01）和 feature 总控的 epic_context；不给就拒绝。 */
  epics?: Pick<EpicsRepo, "get" | "setPlan">;
  featureService?: Pick<FeatureService, "create">;
  /** epic 下每个 feature 的情况（含已归档），直接读库，不经过 epic 记忆。 */
  epicRows?: (epicId: number) => EpicFeatureRow[];
  /** 重新渲染 epic 的 handoff（排进记忆的同步队列，不等它）。 */
  syncEpic?: (epicId: number) => void;
  /** 后台给 epic 下有新活动的 feature 生成汇总（FeatureSummaryRunner.refreshEpic），不等它。这时打开总控，规划会等它（SessionService.sendBrief）。 */
  refreshEpic?: (epicId: number, exceptFeatureId?: number) => void;
  /** session 此刻的活动；监控还没看到它时为 null。 */
  activity?: (sessionId: string) => SessionActivity | null;
  /** session 当前命令输出的末尾（上限 4KB）。 */
  activityOutput?: (sessionId: string) => Promise<string>;
  /** end_session：关掉终端，和用户在界面上点 × 一样（pty.kill；session 留在列表里，之后能恢复）。 */
  kill: (termId: string) => void;
  /** refresh_session（计划 16）：先同步 precheck，能开始就在后台换新，不等它跑完。不给就拒绝。 */
  refresher?: Pick<SessionRefresher, "precheck" | "refresh">;
  /** 屏幕上有权限确认或启动对话框（PtyManager.screenNeedsUser）：这时不能结束。 */
  screenNeedsUser: (termId: string) => boolean;
  /** session 最后一条 assistant 文字回复的结尾（最多 500 字符）；读不到为 null。 */
  lastReply?: (sessionId: string) => string | null;
  /** 把任务作为第一条消息交给新 session（等启动对话框过去、输入框就绪、粘贴、回车）。 */
  submit: (termId: string, message: string) => Promise<"sent" | "exited" | "timeout">;
  notify: () => void;
  /** 设置里的 ticket 号格式：create_ticket 的号不对时告诉总控（不给用默认格式）。 */
  ticketPattern?: () => string;
  /** set_epic_plan 记下的时间（不给用 Date.now）。 */
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

const ok = (value: unknown): ControlResult => ({ v: 1, ok: true, value });
const fail = (error: string): ControlResult => ({ v: 1, ok: false, error });

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

  /** from 必须是这个 ticket 的总控 session，才记成子 session 的开启者。 */
  const spawner = (t: Ticket, from: string | null): string | null => {
    if (!from) return null;
    const h = d.sessions.head(from);
    return h && h.ticketKey === t.key && h.coordinator ? from : null;
  };

  /** 在 ticket 的这个仓库里开子 session，把任务交给它。上限已经由调用方检查过。 */
  const start = async (t: Ticket, repo: TicketRepo, rawTask: string, spawnedBy: string | null, model: StartModel | undefined, memory: "feature" | "ticket", extra: object = {}): Promise<ControlResult> => {
    const task = sanitizeTask(rawTask);
    if (!task) return fail(M().ctlEmptyTask);
    if (d.sessionService.openTerminalCount(t.key) >= MAX_RUNNING_PER_TICKET) {
      return fail(M().ctlTicketLimit(MAX_RUNNING_PER_TICKET));
    }
    const r = await d.sessionService.open({ ticketKey: t.key, repoId: repo.id }, { spawnedBy: spawnedBy ?? undefined, model });
    if (!r.ok) return fail(openError(r, repo));
    d.notify();
    // 不等任务写完：等输入框就绪可能要十几秒（用户还要处理信任文件夹之类的对话框），总控先拿到 session id。
    d.submit(r.termId, taskMessage(task, currentLang(), memory)).then(
      (res) => res === "sent" || d.log?.(`control: task for ${r.termId} not delivered (${res})`),
      (e: unknown) => d.log?.(`control: task for ${r.termId} failed`, e),
    );
    return ok({
      sessionId: r.termId, ...(model && { model }), ...extra, repo: name(repo), dir: d.ticketService.workDir(repo),
      note: M().ctlTaskNote,
    });
  };

  const lastReply = (id: string) => d.lastReply?.(id) ?? null;

  const sessionRow = (t: Ticket | null, s: { id: string; coordinator: boolean; repoId: number | null; firstPrompt: string | null; waitingForInput: boolean; lastActivityAt: number | null; spawnedBy: string | null }) => ({
    id: s.id,
    repo: s.coordinator ? M().ctlCoordinator : t ? repoNameOf(t, s.repoId) : null,
    firstPrompt: s.firstPrompt,
    running: d.sessionService.isRunning(s.id),
    waitingForInput: s.waitingForInput,
    lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : null,
    startedByCoordinator: s.spawnedBy !== null,
    activity: listedActivity(s.id),
    last_reply: lastReply(s.id),
  });

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
    if (!a) return ok({ sessionId: h.id, kind: null, detail: null, background: null, startedAt: null, lastOutputAt: null, stuck: null, reason: null, action: null, output: "", last_reply: lastReply(h.id) });
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
    let t: Ticket;
    try {
      t = await d.ticketService.create({
        key: req.ticket, title: req.title, featureId: f.id, workMode: "worktree",
        repoPaths: picked.map((r) => r.repoPath), ...(req.branch !== undefined && { branch: req.branch }),
      });
    } catch (e) {
      if (e instanceof TicketError && e.code === "invalid_key") return fail(M().ctlInvalidKey(req.ticket, d.ticketPattern?.() ?? DEFAULT_TICKET_PATTERN));
      if (e instanceof TicketError) return fail(e.message);
      d.log?.(`control: create_ticket ${req.ticket} failed`, e);
      return fail((e as Error).message);
    }
    d.notify();
    return ok({
      key: t.key, title: t.title,
      repos: t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), branch: r.branch })),
      note: M().ctlTicketCreated,
    });
  };

  /** 一个 feature 的情况交给模型：summary 超长时截断（汇总是数据，不是指令，这里只截长度）。 */
  const rowOut = (r: EpicFeatureRow): EpicFeatureRow => ({ ...r, summary: r.summary === null ? null : r.summary.slice(0, SUMMARY_LIMIT) });

  /**
   * epic session 在 epic 下建 feature：复用 FeatureService.create（工作区、仓库校验和界面上建一样），再写上 epic_id 和 brief。
   * 不开总控：用户点进 feature 自己开，开的时候 brief 才发出去。名字、仓库、brief 全部核对通过才建，出错什么都不留下。
   */
  const createFeature = async (e: Epic, req: Extract<EpicControlRequest, { op: "create_feature" }>): Promise<ControlResult> => {
    const featureName = req.name.trim();
    if (!featureName || featureName.length > FEATURE_NAME_LIMIT) return fail(M().featureNameInvalid(FEATURE_NAME_LIMIT));
    // 名字会变成工作区目录名：不能带路径分隔符，也不能是 . 或 ..
    if (/[\\/]/.test(featureName) || /^\.+$/.test(featureName)) return fail(M().ctlFeatureNameBad);
    const taken = (d.features?.list({ includeArchived: true }) ?? []).some((f) => f.name.trim().toLowerCase() === featureName.toLowerCase());
    if (taken) return fail(M().ctlFeatureNameTaken(featureName));
    const brief = req.brief.trim();
    if (!brief || req.brief.length > BRIEF_LIMIT) return fail(M().ctlBriefInvalid(BRIEF_LIMIT));

    const names = e.repos.map(name).join(", ");
    if (e.repos.length === 0) return fail(M().ctlEpicNoRepos);
    let picked: typeof e.repos;
    if (req.repos === undefined || req.repos.length === 0) {
      if (e.repos.length > 1) return fail(M().ctlPickEpicRepos(names));
      picked = e.repos;
    } else {
      picked = [];
      for (const wanted of req.repos) {
        const byPath = e.repos.find((r) => samePath(wanted, r.repoPath));
        const byName = e.repos.filter((r) => name(r).toLowerCase() === wanted.trim().toLowerCase());
        const r = byPath ?? (byName.length === 1 ? byName[0] : null);
        if (!r) return fail(byName.length > 1 ? M().ctlRepoAmbiguous(wanted, byName.map((x) => x.repoPath).join(", ")) : M().ctlNoSuchEpicRepo(wanted, names));
        if (!picked.includes(r)) picked.push(r);
      }
    }
    if (!d.featureService) return fail(M().ctlEpicGone);
    let f: Feature;
    try {
      f = await d.featureService.create({ name: featureName, repoPaths: picked.map((r) => r.repoPath), epicId: e.id, brief });
    } catch (err) {
      if (err instanceof TicketError) return fail(err.message);
      d.log?.(`control: create_feature ${featureName} failed`, err);
      return fail((err as Error).message);
    }
    d.notify();
    // 新 feature 要出现在 epic 的 handoff 里；其他 feature 趁这时更新汇总，下一个 feature 才读得到新鲜的进度。都不等，失败只记日志，不影响返回。
    try {
      d.syncEpic?.(e.id);
      d.refreshEpic?.(e.id, f.id);
    } catch (err) {
      d.log?.(`control: refreshing epic ${e.id} after create_feature ${featureName} failed`, err);
    }
    return ok({ id: f.id, name: f.name, repos: f.repos.map(name), note: M().ctlFeatureCreated });
  };

  /** epic session 定下或改了规划（计划 16）：整份换掉 epics.plan，再重新渲染 epic 的 handoff（不等它）。 */
  const setEpicPlan = (e: Epic, raw: string): ControlResult => {
    const plan = raw.trim();
    if (!plan || raw.length > EPIC_PLAN_MAX_CHARS) return fail(M().ctlPlanInvalid(EPIC_PLAN_MAX_CHARS));
    // e 就是从 d.epics 读出来的，这里一定有。
    d.epics?.setPlan(e.id, plan, (d.now ?? Date.now)());
    try {
      d.syncEpic?.(e.id);
    } catch (err) {
      d.log?.(`control: syncing epic ${e.id} after set_epic_plan failed`, err);
    }
    return ok({ note: M().ctlPlanSaved });
  };

  /** epic session（设计文档 2026-11-01）：epic 在这里重新核对，已归档的全部拒绝。 */
  const epicRequest = async (req: EpicControlRequest): Promise<ControlResult> => {
    const e = d.epics?.get(req.epicId);
    if (!e || e.archivedAt !== null) return fail(M().ctlEpicGone);
    if (req.op === "list_repos") return ok(e.repos.map((r) => ({ name: name(r), path: r.repoPath })));
    if (req.op === "list_features") return ok((d.epicRows?.(e.id) ?? []).map(rowOut));
    if (req.op === "create_feature") return createFeature(e, req);
    if (req.op === "set_epic_plan") return setEpicPlan(e, req.plan);
    // 下面这些只看未归档的 feature：feature 级的 session（总控、修复）和这些 feature 下 ticket 的 session。
    const own = (d.features?.listByEpic(e.id) ?? []).map((f) => ({ f, tickets: d.tickets.listByFeature(f.id) }));
    if (req.op === "list_sessions") return ok(own.flatMap(({ f, tickets }) => featureSessionRows(f, tickets).map((r) => ({ ...r, feature: f.name }))));
    const featureIds = new Set(own.map(({ f }) => f.id));
    const keys = new Set(own.flatMap(({ tickets }) => tickets.map((t) => t.key)));
    const belongs = (s: Session) => (s.ticketKey !== null ? keys.has(s.ticketKey) : s.featureId !== null && featureIds.has(s.featureId));
    if (req.op === "session_activity") return sessionActivity(req.session, belongs);
    if (req.op === "refresh_session") return refreshSession(req, belongs);
    return endSession(req, belongs);
  };

  /** feature 总控查同一 epic 下别的 feature：不含自己。 */
  const epicContext = (f: Feature): ControlResult => {
    const e = f.epicId === null ? null : d.epics?.get(f.epicId);
    if (!e) return fail(M().ctlNoEpic);
    if (e.archivedAt !== null) return fail(M().ctlEpicGone);
    return ok({ epic: e.name, features: (d.epicRows?.(e.id) ?? []).filter((r) => r.id !== f.id).map(rowOut) });
  };

  /** feature 总控（设计文档 2026-10-26）：feature 和 ticket 都在这里重新核对，ticket 必须属于这个 feature 且未归档。 */
  const featureRequest = async (req: FeatureControlRequest): Promise<ControlResult> => {
    const f = d.features?.get(req.featureId);
    if (!f || f.archivedAt !== null) return fail(M().ctlFeatureGone);
    if (req.op === "epic_context") return epicContext(f);
    const own = d.tickets.listByFeature(f.id);

    if (req.op === "list_tickets") {
      return ok(own.map((t) => ({
        key: t.key, title: t.title, status: effectiveStatus(t),
        repos: t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), branch: r.branch })),
      })));
    }

    if (req.op === "list_repos") {
      return ok(f.repos.map((r) => ({ name: name(r), path: r.repoPath })));
    }

    if (req.op === "create_ticket") return createTicket(f, req);

    if (req.op === "session_activity") {
      const keys = new Set(own.map((t) => t.key));
      return sessionActivity(req.session, (s) => (s.ticketKey !== null ? keys.has(s.ticketKey) : s.featureId === f.id));
    }

    if (req.op === "list_sessions") return ok(featureSessionRows(f, own));

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
    if ((d.sessionService.featureTerminalCount?.(f.id) ?? 0) >= MAX_RUNNING_PER_FEATURE) {
      return fail(M().ctlFeatureLimit(MAX_RUNNING_PER_FEATURE));
    }
    // from 必须是这个 feature 的总控，才记成子 session 的开启者。
    const h = req.from ? d.sessions.head(req.from) : null;
    const spawnedBy = h && h.featureId === f.id && h.coordinator ? req.from : null;
    return start(t, repo, req.task, spawnedBy, req.model, "feature", { ticket: t.key });
  };

  return async (req) => {
    if ("epicId" in req) return epicRequest(req);
    if ("featureId" in req) return featureRequest(req);
    const t = d.tickets.get(req.ticketKey);
    if (!t || t.archivedAt !== null) return fail(M().ctlTicketGone(req.ticketKey));

    if (req.op === "list_repos") {
      return ok(t.repos.map((r) => ({ name: name(r), dir: d.ticketService.workDir(r), workMode: r.workMode, branch: r.branch })));
    }

    if (req.op === "list_sessions") return ok(visible(d.sessions.listByTicket(t.key)).map((s) => sessionRow(t, s)));

    if (req.op === "session_activity") return sessionActivity(req.session, (s) => s.ticketKey === t.key);
    if (req.op === "end_session") return endSession(req, (s) => s.ticketKey === t.key);
    if (req.op === "refresh_session") return refreshSession(req, (s) => s.ticketKey === t.key);

    const repo = findRepo(t, req.repo);
    if (typeof repo === "string") return fail(repo);
    return start(t, repo, req.task, spawner(t, req.from), req.model, "ticket");
  };
}
