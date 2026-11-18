import type { BatchRecorder } from "../batches/batch-recorder";
import type { AdmissionPolicyService } from "../lessons/admission-policies";
import type { CheckDraftResult, CheckHitView, CheckScope, ChecksAction, ChecksActResult, ChecksView } from "../../shared/checks";
import type { ConfigIoFacade } from "../config-io/facade";
import type { BatchDetail, BatchView } from "../../shared/batches";
import type { AdmissionPolicyView } from "../../shared/admission-policy";
import type { ConfigIoStatus, ExportResult, ImportApplyResult, ImportPreviewResult } from "../../shared/config-io";
import type { MemoryHistoryPoint } from "../../shared/mem-usage";
import { clipboard, dialog, ipcMain, type BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc";
import {
  FOLLOWUP_STATUSES, type AutostartState, type ButlerMessageView, type CiItemRef, type FollowupStatus, type InboxView, type JobStateView, type McpProbe, type MergeEvent, type NowView, type OpenSessionRequest, type RefreshSessionResult, type TicketStatus, type WatchedPr,
} from "../../shared/types";
import type { AuditPage, LlmStatus, SensitiveTerm } from "../../shared/llm";
import type { ExternalActionEntry } from "../../shared/external";
import type { ProgressFilter, ProgressView } from "../../shared/progress";
import type { ExternalAuditRepo } from "../db/external-audit-repo";
import type { EpicService } from "../epics/epic-service";
import type { AuditRepo } from "../db/audit-repo";
import type { MemoryService } from "../memory/memory-service";
import { JOB_NIGHTLY, type JobsRepo } from "../db/jobs-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MergeGateRepo } from "../db/merge-gate-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { UsageRepo } from "../db/usage-repo";
import { summarizeUsage, USAGE_WINDOW_MS } from "../usage/usage-summary";
import type { TermsRepo } from "../db/terms-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { KeyStore } from "../gateway/key-store";
import { auditPage } from "../gateway/status";
import type { HandoffRunner } from "../handoff/runner";
import type { FeatureSummaryRunner } from "../handoff/feature-runner";
import type { HealthService } from "../hooks/health";
import type { PrStagesTicket } from "../../shared/pr-stages";
import type { LessonQueueRowView, LessonRunDetail, LessonsState } from "../../shared/lessons";
import type { LessonsService } from "../lessons/lessons-service";
import type { PrStagesService } from "../prwatch/pr-stages-service";
import type { PrOpenResult } from "../util/github-url";
import type { InboxService } from "../inbox/inbox-service";
import { addDays, localDate } from "../schedule/calendar";
import type { Scheduler } from "../schedule/scheduler";
import type { ActivityMonitor } from "../sessions/activity-monitor";
import type { PtyManager } from "../sessions/pty-manager";
import type { SessionService } from "../sessions/session-service";
import { memoryOn } from "../settings/settings-values";
import type { FeatureService } from "../tickets/feature-service";
import { scanRepos } from "../tickets/git";
import { TicketError, type TicketService } from "../tickets/ticket-service";
import type { CleanupOutcome } from "../tickets/worktree-cleanup";
import { currentLang } from "../i18n";
import { meteredIpcResult } from "./result";
import { memoryHandlers } from "./memory-handlers";
import { settingsHandlers } from "./settings-handlers";
import {
  addRepoArg, apiKeyArg, routingActionArg, switchModelArg, availabilityActionArg, auditCursorArg, boolArg, ciItemArg, clipboardTextArg, createEpicArg, createFeatureArg, createTicketArg, dirArg, epicIdArg, epicNameArg, featureIdArg, featureNameArg, progressFilterArg, inboxAnswerArg, inboxIdArg, inboxScopeArg, lessonActionArg, lessonRunIdArg, lessonSlugArg, moveTargetArg, prStagesScopeArg, prUrlArg,
  openButlerArg, openEpicArg, openFeatureArg, openFixArg, repoIdArg, sessionIdArg, sessionIdsArg, termsArg, ticketKeyArg, updateRepoArg, updateTicketArg, batchIdArg, batchListArg, exportRequestArg, importApplyArg, importRetargetArg, policyScopeArg, policySetArg, checkScopeArg, checkKeyArg, checksActionArg, checkLessonIdArg } from "./validate";
import { M } from "../strings";
import type { ClaudeAvailability } from "../claude/availability";
import type { AvailabilityView } from "../../shared/availability";
import type { RoutingAction, RoutingView, SessionLimitView } from "../../shared/model-routing";
import type { SwitchResult } from "../routing/session-switch";

export interface IpcDeps {
  tickets: TicketsRepo;
  ticketService: TicketService;
  featureService: FeatureService;
  epicService: EpicService;
  sessionService: SessionService;
  activity: Pick<ActivityMonitor, "dismiss">;
  usage: Pick<UsageRepo, "since">;
  sessions: Pick<SessionsRepo, "get">;
  pty: PtyManager;
  health: HealthService;
  followups: FollowupsRepo;
  handoffs: HandoffsRepo;
  settings: SettingsRepo;
  gateRepo: Pick<MergeGateRepo, "recentEvents">;
  /** PrWatcher 跟着的 PR 和 CI。 */
  prWatchList: () => WatchedPr[];
  /** PR 进度。 */
  prStages: Pick<PrStagesService, "view">;
  /** 在系统浏览器里打开 PR 链接：只开 ticket 链接过、主机允许的（openKnownPr）。 */
  prOpen: (url: string) => PrOpenResult;
  /** 复盘规矩页。 */
  lessons: Pick<LessonsService, "state" | "act" | "pendingCount" | "runs" | "run">;
  /** 批次历史（契约 4.4）。 */
  batches: Pick<BatchRecorder, "list" | "get">;
  /** 三层准入策略（契约 4.2）。 */
  policies: Pick<AdmissionPolicyService, "view" | "setLayer">;
  /** 导入导出（契约 4.3）。 */
  configIo: ConfigIoFacade;
  /** 确定性检查（契约 4.5）：检查页的读、写和从规矩生成草稿。 */
  checks: { act: (a: ChecksAction) => ChecksActResult; view: (scope: CheckScope) => ChecksView; hits: (key: string) => CheckHitView[]; draft: (lessonId: number) => Promise<CheckDraftResult> };
  /** Claude 可用状态；act 只有手动暂停 / 恢复复盘。 */
  availability: Pick<ClaudeAvailability, "view" | "pauseLessons" | "resumeLessons">;
  /** 模型路由（3.0）：设置页的整份数据和操作；act 返回错误文字，成功为 null。 */
  routing: { view(): RoutingView; act(a: RoutingAction): Promise<string | null> };
  /** session 撞限后换模型（SessionModelSwitcher）。 */
  switcher: { switch(sessionId: string, model?: string): Promise<SwitchResult>; dismiss(sessionId: string): void; views(): SessionLimitView[] };
  /** 用户在终端里打字（WS-M E：马上恢复优先级）。 */
  terminalInput?: (termId: string) => void;
  /** 度量（ws-h）：用户在终端里按的键（权限确认、选项、Esc 打断）。 */
  terminalKeys?: (termId: string, data: string) => void;
  /** 度量（ws-h）：一次成功的 invoke 和它的返回值（手动触发在这里记）。 */
  onInvoked?: (channel: string, args: readonly unknown[], result: unknown) => void;
  /** 渲染进程报的终端可见性（WS-M D、E）。 */
  terminalVisible?: (termId: string, visible: boolean) => void;
  /** 内存历史（WS-M A），since 以后的点。 */
  memoryHistory?: (since: number) => MemoryHistoryPoint[];
  /** 「现在」页：session、活动、PR、合并排队和「需要你」拼成的一份（buildNowView），merges 是“最近合并”。 */
  nowView: (merges: MergeEvent[]) => NowView;
  /** 重发一条递不出去的 CI 结论（工作流 W）。 */
  ciResend: (item: CiItemRef) => Promise<string>;
  /** 「待你决定」和汇报（BTL-190 第 2+3 点）。 */
  inbox: Pick<InboxService, "view" | "answer" | "dismiss">;
  /** 界面上的“换新”按钮（计划 16）：马上回答，换新在后台跑。 */
  refreshSession: (sessionId: string) => RefreshSessionResult;
  /** 「清理闲置」按钮（BTL-190 第 8 点）：把这些 session 里闲置的关掉，返回开始关的个数（关闭在后台跑）。 */
  closeIdleSessions: (sessionIds: string[]) => number;
  /** 隐藏列表里的「全部删除」（BTL-190 第 8 点）：返回删掉的个数。 */
  deleteHiddenSessions: (sessionIds: string[]) => number;
  /** 「钉住」（WS-M B）。 */
  pinSession: (sessionId: string, pinned: boolean) => void;
  /** 唤醒休眠的 session（用户点的：不管上次唤醒失败的冷却）。 */
  wakeSession: (sessionId: string) => Promise<string>;
  runner: HandoffRunner;
  featureRunner: Pick<FeatureSummaryRunner, "runManual">;
  scheduler: Scheduler;
  jobs: JobsRepo;
  keys: KeyStore;
  terms: TermsRepo;
  audit: AuditRepo;
  /** 对外动作的审计（契约 4.8，ws-b）。 */
  externalAudit: Pick<ExternalAuditRepo, "list">;
  /** 进度页（ws-b）：和总控 progress_overview 同一份聚合。 */
  progress: (filter: ProgressFilter) => ProgressView;
  /** Butler 页"回复"tab（ws-b）。 */
  butlerMessages: () => ButlerMessageView[];
  memory: Pick<MemoryService, "view" | "why">;
  autostart: { get(): AutostartState; set(on: boolean): AutostartState };
  /** 防休眠开关（只在内存里，启动时是关的）。 */
  keepAwake: { isOn(): boolean; set(on: boolean): void };
  llmStatus: () => LlmStatus;
  /** followup 状态变化后重新推导 ticket 状态。 */
  rederive: (ticketKey: string) => void;
  detectTrackerTools: () => Promise<McpProbe>;
  window: () => BrowserWindow | null;
  now: () => number;
  notify: () => void;
  /** 记忆开关真的变了之后调用（on 是新的状态）：通知记忆标签，打开时补同步一次。 */
  memoryToggled: (on: boolean) => void;
  /** 共享 MCP 开关变了（WS-M H）。 */
  sharedMcpChanged?: () => void;
  /** ticket 归档之后：清掉它留下的 MCP 配置文件。 */
  onArchived?: (ticketKey: string) => void;
  /** feature 归档之后：清掉 feature 总控的 MCP 配置文件。 */
  onFeatureArchived?: (featureId: number) => void;
  /** “重新检查”：PR 已合并时按规则再清理一次这个 ticket 的 worktree（设计文档 2026-10-26）。 */
  recheckCleanup: (ticketKey: string) => Promise<CleanupOutcome[]>;
  /** language 设置保存或恢复默认之后：重新解析当前语言（设计文档 2026-10-26）。 */
  languageChanged?: () => void;
  /** 任何设置保存或恢复默认之后（检查快照跟着重写）。 */
  settingChanged?: (key: import("../../shared/settings").EditableSettingKey) => void;
  /** 退出已开始：后台任务的 IPC 直接返回。 */
  aborted: () => boolean;
}

export function registerIpc(d: IpcDeps): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args: unknown[]) => meteredIpcResult(channel, args, () => fn(...args), d.onInvoked));

  const setFollowupStatus = (id: string, status: FollowupStatus) => {
    if (!(FOLLOWUP_STATUSES as readonly string[]).includes(status)) throw new Error(`unknown followup status: ${String(status)}`);
    const f = d.followups.get(id);
    if (!f) throw new TicketError("not_found", M().followupNotFound);
    const now = d.now();
    d.followups.setStatus(id, status, now, status === "snoozed" ? addDays(localDate(now), 1) : null);
    d.rederive(f.ticketKey);
  };

  handle(IPC.ticketsList, () => d.sessionService.ticketViews());
  handle(IPC.ticketsCreate, async (raw: unknown) => {
    const t = await d.ticketService.create(createTicketArg(raw));
    d.notify();
    return t;
  });
  handle(IPC.ticketsSetStatus, (key: string, status: TicketStatus | null) => {
    d.tickets.setStatusManual(key, status, d.now());
    d.notify();
  });
  handle(IPC.ticketsArchive, (key: string) => {
    d.tickets.archive(key, d.now());
    d.onArchived?.(key);
    d.notify();
  });
  handle(IPC.ticketsUpdate, (raw: unknown) => {
    const input = updateTicketArg(raw);
    const t = d.ticketService.setTitle(input.key, input.title);
    d.notify();
    return t;
  });
  handle(IPC.ticketsAddRepo, async (raw: unknown) => {
    const r = await d.ticketService.addRepo(addRepoArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.ticketsUpdateRepo, async (raw: unknown) => {
    const input = updateRepoArg(raw);
    const repo = d.ticketService.repo(input.repoId);
    const r = await d.ticketService.updateRepo(input, { terminalsOpen: d.sessionService.hasOpenTerminal(repo.ticketKey, repo.id) });
    d.notify();
    return r;
  });
  handle(IPC.ticketsRemoveRepo, (raw: unknown) => {
    const repo = d.ticketService.repo(repoIdArg(raw));
    d.ticketService.removeRepo(repo.id, { terminalsOpen: d.sessionService.hasOpenTerminal(repo.ticketKey, repo.id) });
    d.notify();
  });
  handle(IPC.ticketsArchived, () => d.tickets.listArchived());
  handle(IPC.ticketsUnarchive, (raw: unknown) => {
    const key = ticketKeyArg(raw);
    if (!d.tickets.get(key)) throw new TicketError("not_found", M().ticketNotFound(key));
    d.tickets.unarchive(key);
    d.notify();
  });
  handle(IPC.ticketsSwitchBranch, async (raw: unknown) => {
    await d.ticketService.switchBranch(d.ticketService.repo(repoIdArg(raw)));
  });

  handle(IPC.ticketsRecheckCleanup, async (raw: unknown) => {
    const out = await d.recheckCleanup(ticketKeyArg(raw));
    d.notify();
    return out;
  });

  // feature（设计文档 2026-10-26）
  handle(IPC.featuresList, () => d.sessionService.featureViews());
  handle(IPC.featuresCreate, async (raw: unknown) => {
    const f = await d.featureService.create(createFeatureArg(raw));
    d.notify();
    return f;
  });
  handle(IPC.featuresRename, (id: unknown, name: unknown) => {
    const f = d.featureService.rename(featureIdArg(id), featureNameArg(name));
    d.notify();
    return f;
  });
  handle(IPC.featuresAddRepo, async (id: unknown, path: unknown) => {
    const r = await d.featureService.addRepo(featureIdArg(id), dirArg(path));
    d.notify();
    return r;
  });
  handle(IPC.featuresRemoveRepo, (featureRepoId: unknown) => {
    d.featureService.removeRepo(repoIdArg(featureRepoId));
    d.notify();
  });
  handle(IPC.featuresArchive, async (raw: unknown) => {
    const id = featureIdArg(raw);
    // epic 下的 feature 要先生成汇总，最多等两分钟。
    await d.featureService.archive(id, { terminalsOpen: () => d.sessionService.hasFeatureTerminal(id) });
    d.onFeatureArchived?.(id);
    d.notify();
  });
  handle(IPC.featuresArchived, () => d.featureService.listArchived());
  handle(IPC.featuresUnarchive, (raw: unknown) => {
    d.featureService.unarchive(featureIdArg(raw));
    d.notify();
  });
  handle(IPC.featuresOpenSession, async (raw: unknown) => {
    const r = await d.sessionService.openFeature(openFeatureArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.featuresMove, (id: unknown, target: unknown) => {
    d.epicService.moveFeature(featureIdArg(id), moveTargetArg(target));
    d.notify();
  });

  // epic（设计文档 2026-11-01）
  handle(IPC.epicsList, () => d.sessionService.epicViews());
  handle(IPC.epicsCreate, async (raw: unknown) => {
    const e = await d.epicService.create(createEpicArg(raw));
    d.notify();
    return e;
  });
  handle(IPC.epicsRename, (id: unknown, name: unknown) => {
    const e = d.epicService.rename(epicIdArg(id), epicNameArg(name));
    d.notify();
    return e;
  });
  handle(IPC.epicsAddRepo, async (id: unknown, path: unknown) => {
    const r = await d.epicService.addRepo(epicIdArg(id), dirArg(path));
    d.notify();
    return r;
  });
  handle(IPC.epicsRemoveRepo, (epicRepoId: unknown) => {
    d.epicService.removeRepo(repoIdArg(epicRepoId));
    d.notify();
  });
  handle(IPC.epicsArchive, async (raw: unknown) => {
    const id = epicIdArg(raw);
    // 下面的 feature 要先生成汇总，最多等两分钟。终端查两次（等之前、等之后），所以传函数。
    await d.epicService.archive(id, {
      terminalsOpen: () => d.sessionService.hasEpicTerminal(id),
      featureTerminalsOpen: (featureId) => d.sessionService.hasFeatureTerminal(featureId),
    });
    d.notify();
  });
  handle(IPC.epicsArchived, () => d.epicService.listArchived());
  handle(IPC.epicsUnarchive, (raw: unknown) => {
    d.epicService.unarchive(epicIdArg(raw));
    d.notify();
  });
  handle(IPC.epicsOpenSession, async (raw: unknown) => {
    const r = await d.sessionService.openEpic(openEpicArg(raw));
    d.notify();
    return r;
  });

  handle(IPC.butlerView, () => d.sessionService.butlerView());
  handle(IPC.butlerMessages, (): ButlerMessageView[] => d.butlerMessages());
  handle(IPC.progressGet, (raw: unknown): ProgressView => d.progress(progressFilterArg(raw)));
  handle(IPC.butlerOpenSession, async (raw: unknown) => {
    const r = await d.sessionService.openButler(openButlerArg(raw));
    d.notify();
    return r;
  });

  handle(IPC.reposScan, (raw: unknown) => scanRepos(dirArg(raw)));

  handle(IPC.sessionsOpen, async (req: OpenSessionRequest) => {
    const r = await d.sessionService.open(req);
    d.notify();
    return r;
  });
  handle(IPC.sessionOpenFix, async (raw: unknown) => {
    const r = await d.sessionService.openFix(openFixArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.sessionsUnclaimed, () => d.sessionService.unclaimed());
  handle(IPC.sessionsClaim, (id: string, key: string) => {
    d.sessionService.claim(id, key);
    d.notify();
  });
  handle(IPC.sessionsHide, (raw: unknown) => {
    d.sessionService.hide(sessionIdArg(raw));
    d.notify();
  });
  handle(IPC.sessionsUnhide, (raw: unknown) => {
    d.sessionService.unhide(sessionIdArg(raw));
    d.notify();
  });
  handle(IPC.sessionsRefresh, (raw: unknown): RefreshSessionResult => {
    const r = d.refreshSession(sessionIdArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.sessionsCloseIdle, (raw: unknown): number => {
    const n = d.closeIdleSessions(sessionIdsArg(raw));
    d.notify();
    return n;
  });
  handle(IPC.sessionsDeleteHidden, (raw: unknown): number => {
    const n = d.deleteHiddenSessions(sessionIdsArg(raw));
    d.notify();
    return n;
  });
  handle(IPC.sessionsPin, (raw: unknown, on: unknown) => {
    d.pinSession(sessionIdArg(raw), boolArg(on));
    d.notify();
  });
  handle(IPC.sessionsWake, (raw: unknown): Promise<string> => d.wakeSession(sessionIdArg(raw)));
  handle(IPC.sessionsDismiss, (id: string) => {
    d.sessionService.dismiss(id);
    d.notify();
  });

  handle(IPC.usageSummary, () => {
    const since = Date.now() - USAGE_WINDOW_MS;
    return summarizeUsage(d.usage.since(since), (id) => (id && d.sessions.get(id)?.coordinator ? "coordinator" : "ticket"), since);
  });
  handle(IPC.activityDismiss, (raw: unknown) => d.activity.dismiss(sessionIdArg(raw)));

  handle(IPC.ptySnapshot, (id: string) => d.pty.snapshot(id));
  handle(IPC.ptyKill, (id: string) => d.pty.kill(id));
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => {
    d.pty.write(id, data);
    d.terminalInput?.(id);
    if (typeof id === "string" && typeof data === "string") d.terminalKeys?.(id, data);
  });
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => d.pty.resize(id, cols, rows));
  ipcMain.on(IPC.ptyVisible, (_e, id: unknown, visible: unknown) => {
    if (typeof id === "string") d.terminalVisible?.(id, visible === true);
  });

  handle(IPC.healthGet, () => d.health.refresh());
  handle(IPC.healthInstallHooks, () => d.health.installHooks());
  handle(IPC.healthUninstallHooks, () => d.health.uninstallHooks());

  // 终端的复制粘贴：xterm 在 Windows 上把 Ctrl+V 当成 ^V 发给 claude，渲染进程拦下按键后经这里读写系统剪贴板。
  handle(IPC.clipboardRead, () => clipboard.readText());
  handle(IPC.clipboardWrite, (text: unknown) => clipboard.writeText(clipboardTextArg(text)));

  handle(IPC.dialogPickDir, async () => {
    const w = d.window();
    const options = { properties: ["openDirectory" as const] };
    const r = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  // 「现在」页的“最近合并”：最近 7 天、最多 20 条。
  const recentMerges = (): MergeEvent[] => d.gateRepo.recentEvents(d.now() - 7 * 24 * 3600 * 1000, 20);
  handle(IPC.mergeEvents, recentMerges);
  handle(IPC.prWatchList, (): WatchedPr[] => d.prWatchList());
  handle(IPC.prStages, (raw: unknown): PrStagesTicket[] => d.prStages.view(prStagesScopeArg(raw)));
  handle(IPC.prOpen, (raw: unknown): PrOpenResult => d.prOpen(prUrlArg(raw)));
  handle(IPC.lessonsState, (): LessonsState => d.lessons.state());
  handle(IPC.lessonsAct, (raw: unknown) => d.lessons.act(lessonActionArg(raw)));
  handle(IPC.lessonsRuns, (raw: unknown): LessonQueueRowView[] => d.lessons.runs(lessonSlugArg(raw)));
  handle(IPC.lessonsRun, (raw: unknown): LessonRunDetail | null => d.lessons.run(lessonRunIdArg(raw)));
  handle(IPC.lessonsPending, (): number => d.lessons.pendingCount());
  handle(IPC.lessonsBatches, (raw: unknown): BatchView[] => d.batches.list(batchListArg(raw)));
  handle(IPC.lessonsBatch, (raw: unknown): BatchDetail | null => d.batches.get(batchIdArg(raw)));
  handle(IPC.policiesGet, (raw: unknown): AdmissionPolicyView => d.policies.view(policyScopeArg(raw)));
  handle(IPC.policiesSet, (raw: unknown) => {
    const { scope, overrides } = policySetArg(raw);
    const r = d.policies.setLayer(scope, overrides);
    d.notify();
    return r;
  });
  handle(IPC.checksView, (raw: unknown): ChecksView => d.checks.view(checkScopeArg(raw)));
  handle(IPC.checksHits, (raw: unknown): CheckHitView[] => d.checks.hits(checkKeyArg(raw)));
  handle(IPC.checksAct, (raw: unknown): ChecksActResult => {
    const r = d.checks.act(checksActionArg(raw));
    if (r.ok) d.notify();
    return r;
  });
  handle(IPC.checksDraft, (raw: unknown): Promise<CheckDraftResult> => d.checks.draft(checkLessonIdArg(raw)));
  handle(IPC.configStatus, (): ConfigIoStatus => d.configIo.status());
  handle(IPC.configExport, (raw: unknown): Promise<ExportResult> => d.configIo.exportTo(exportRequestArg(raw)));
  handle(IPC.configImportPreview, (): Promise<ImportPreviewResult> => d.configIo.importPreview());
  handle(IPC.configImportRetarget, (raw: unknown): Promise<ImportPreviewResult> => {
    const { token, target } = importRetargetArg(raw);
    return d.configIo.retarget(token, target);
  });
  handle(IPC.configImportApply, (raw: unknown): ImportApplyResult => d.configIo.apply(importApplyArg(raw)));
  handle(IPC.configBackupNow, () => d.configIo.backupNow());
  handle(IPC.configOpenBackups, () => d.configIo.openBackups());
  handle(IPC.availabilityGet, (): AvailabilityView => d.availability.view());
  handle(IPC.availabilityAct, (raw: unknown): void => {
    const a = availabilityActionArg(raw);
    if (a.op === "pauseLessons") d.availability.pauseLessons();
    else d.availability.resumeLessons();
  });
  handle(IPC.routingView, (): RoutingView => d.routing.view());
  handle(IPC.routingAct, async (raw: unknown): Promise<string | null> => {
    const r = await d.routing.act(routingActionArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.sessionsSwitchModel, async (id: unknown, model: unknown): Promise<SwitchResult> => {
    const r = await d.switcher.switch(sessionIdArg(id), switchModelArg(model));
    d.notify();
    return r;
  });
  handle(IPC.sessionsLimits, (): SessionLimitView[] => d.switcher.views());
  handle(IPC.sessionsDismissLimit, (id: unknown): void => {
    d.switcher.dismiss(sessionIdArg(id));
    d.notify();
  });
  handle(IPC.nowView, (): NowView => d.nowView(recentMerges()));
  handle(IPC.ciResend, (raw: unknown): Promise<string> => d.ciResend(ciItemArg(raw)));
  // 答了、不用了都由 InboxService 自己 notify。
  handle(IPC.inboxList, (raw: unknown): InboxView => d.inbox.view(inboxScopeArg(raw)));
  handle(IPC.inboxAnswer, (id: unknown, text: unknown): boolean => d.inbox.answer(inboxIdArg(id), inboxAnswerArg(text)));
  handle(IPC.inboxDismiss, (id: unknown): boolean => d.inbox.dismiss(inboxIdArg(id)));

  handle(IPC.followupsList, (ticketKey: string) => d.followups.listByTicket(ticketKey));
  handle(IPC.followupsSetStatus, (id: string, status: FollowupStatus) => {
    setFollowupStatus(id, status);
    d.notify();
  });

  handle(IPC.handoffsList, (ticketKey: string) => d.handoffs.listByTicket(ticketKey));
  handle(IPC.handoffsRun, async (ticketKey: string) => {
    const outcome = await d.runner.runManual(ticketKey);
    d.notify();
    return outcome;
  });
  // 手动“立即更新”feature 汇总：和 ticket 的手动 handoff 一样，跑完刷新界面。
  handle(IPC.featuresSummaryRun, async (raw: unknown) => {
    const outcome = await d.featureRunner.runManual(featureIdArg(raw));
    d.notify();
    return outcome;
  });
  handle(IPC.jobsRunNightly, async (): Promise<JobStateView | null> => {
    if (d.aborted()) return null;
    await d.scheduler.runNightlyNow();
    d.notify();
    return d.jobs.get(JOB_NIGHTLY);
  });

  const settingsIpc = settingsHandlers(d);
  handle(IPC.settingsGet, settingsIpc.get);
  handle(IPC.settingsSet, settingsIpc.set);
  handle(IPC.settingsReset, settingsIpc.reset);
  handle(IPC.settingsDetectTrackerTools, () => d.detectTrackerTools());

  // 个人 API：key 只进不出，界面只拿到打码后的 LlmStatus。参数一律在运行时检查（渲染进程不可信）。
  handle(IPC.llmStatus, (): LlmStatus => d.llmStatus());
  handle(IPC.llmKeySave, (key: unknown): LlmStatus => {
    d.keys.save(apiKeyArg(key));
    d.notify();
    return d.llmStatus();
  });
  handle(IPC.llmKeyClear, (): LlmStatus => {
    d.keys.clear();
    d.notify();
    return d.llmStatus();
  });
  handle(IPC.termsList, (): SensitiveTerm[] => d.terms.list());
  handle(IPC.termsSave, (terms: unknown): SensitiveTerm[] => {
    d.terms.replaceAll(termsArg(terms));
    d.notify();
    return d.terms.list();
  });
  handle(IPC.auditList, (beforeId: unknown): AuditPage =>
    auditPage({ settings: d.settings, keys: d.keys, audit: d.audit, now: d.now }, auditCursorArg(beforeId)));
  handle(IPC.externalAuditList, (): ExternalActionEntry[] => d.externalAudit.list({ limit: 200 }));

  // StateCore 记忆（设计文档 8.4）：只读。
  const mem = memoryHandlers({ tickets: d.tickets, memory: d.memory, enabled: () => memoryOn(d.settings) });
  handle(IPC.memoryView, mem.view);
  handle(IPC.memoryWhy, mem.why);
  // 内存历史（WS-M A）：最近 hours 小时（1 到 336），默认 24。
  handle(IPC.memUsageHistory, (hours: unknown): MemoryHistoryPoint[] => {
    const h = typeof hours === "number" && Number.isFinite(hours) ? Math.min(336, Math.max(1, hours)) : 24;
    return d.memoryHistory?.(d.now() - h * 3600_000) ?? [];
  });

  handle(IPC.appAutostartGet, () => d.autostart.get());
  handle(IPC.appLanguage, () => currentLang());
  handle(IPC.appAutostartSet, (on: unknown) => d.autostart.set(boolArg(on)));
  handle(IPC.appKeepAwakeGet, () => d.keepAwake.isOn());
  handle(IPC.appKeepAwakeSet, (on: unknown) => {
    d.keepAwake.set(boolArg(on));
    return d.keepAwake.isOn();
  });
}
