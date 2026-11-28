import type { FlowItemView, FlowScope, FlowTurnText } from "../../shared/infoflow";
import type { AutomationLevel, AutomationState } from "../../shared/automation";
import type { TicketGlance } from "../../shared/ticket-glance";
import type { CloseLeftoversResult, ClosePreview } from "./close-ticket-outcome";
import { normTurnFilter, type TurnBoard, type TurnFilter, type TurnSendReason } from "../../shared/turn";
import type { CheckDraftResult, CheckHitView, CheckScope, ChecksAction, ChecksActResult, ChecksView } from "../../shared/checks";
import type { BacktestActResult, BacktestAction, BacktestView } from "../../shared/backtest";
import type { IntakeActResult, IntakeAction, IntakeClassifyEdit, IntakeEffect, IntakePolicyOverrides, IntakePolicySetResult, IntakePolicyView, IntakeView } from "../../shared/intake";
import type { MemoryHistoryPoint } from "../../shared/mem-usage";
import type { ConvListOpts, ConvMessage, ConvPage } from "../../shared/conversation";
import type { DevSendResult, ForkView, RememberResult } from "../../shared/fork";
import type { BaselineSummary, BaselinesAction, BaselinesActResult, BaselinesView, CheckExportAction, CheckExportResult, CheckExportView, LegacyAction, LegacyScanView, LegacyViolation, RuleRowView } from "../../shared/baselines";
import type { ActivityEvent } from "../../shared/activity";
import type { Lang } from "../../shared/i18n";
import type { AppMenuAction, UpdateCheckResult, UpdateView } from "../../shared/update";
import type { FeedbackKind } from "../../shared/feedback";
import { createStateBus } from "./state-bus";
import type { StateScope } from "../../shared/state-scope";
import { IPC, type IpcResult } from "../../shared/ipc";
import type { PrStagesScope, PrStagesTicket } from "../../shared/pr-stages";
import type { AvailabilityAction, AvailabilityView } from "../../shared/availability";
import type { BatchDetail, BatchView } from "../../shared/batches";
import type { AdmissionPolicyOverrides, AdmissionPolicyView, PolicyScope } from "../../shared/admission-policy";
import type { LoopPolicyOverrides, LoopPolicyView, LoopScope } from "../../shared/loop-policy";
import type { PrPolicyOverrides, PrPolicyView, PrScope } from "../../shared/pr-policy";
import type {
  PreReviewQueueAction, PreReviewQueueActResult, PreReviewQueueView, PreReviewStatusBatch, PreReviewStatusRequest, ReviewActResult, ReviewQueueItem, TicketAssessmentView,
} from "../../shared/prereview";
import type { ReviewEffectView } from "../../shared/review-effect";
import type { CommentAction, CommentItemView, FlakyAction, FlakyEntry, LoopEffect, PrCommentsView } from "../../shared/loop";
import type { ConfigIoStatus, ExportRequest, ExportResult, ImportApplyRequest, ImportApplyResult, ImportPreviewResult, StarterTarget } from "../../shared/config-io";
import type {
  AdmissionPageState, AdmissionScope, CalibrationAction, CalibrationActResult, CalibrationSample, CalibrationStatsView, RegroupResult, WizardAction, WizardActResult, WizardEstimate,
} from "../../shared/lesson-admission";
import type { LessonAction, LessonActResult, LessonQueueRowView, LessonRunDetail, LessonsState } from "../../shared/lessons";
import type { MemoryView, WhyEntry } from "../../shared/memory";
import type { RoutingAction, RoutingView, SessionLimitView, SwitchModelResult } from "../../shared/model-routing";
import type { BackgroundAction, BackgroundStatusView } from "../../shared/background";
import type { CostBreakerView, CostPolicyOverrides, CostResumeResult, CostSetResult, CostSubjectKind, CostView } from "../../shared/cost";
import type { ExternalActionEntry } from "../../shared/external";
import type { MetricsOverview } from "../../shared/metrics";
import type { InterruptsAction, InterruptsActResult, InterruptsState, ProfileScan } from "../../shared/interrupts";
import type { StackActionResult, StackLayerMode, StackPolicyLayer, StackPolicyOverrides, StackPolicySetResult, StackPolicyView, StacksFilter, StacksView } from "../../shared/stacks";
import type { EditableSettingKey, EditableSettings } from "../../shared/settings";
import type { DiagSnapshot } from "../../shared/diag";
import type { LongTaskTotals } from "./diag";
import type { FeaturePolicyState, PolicyFamily } from "../../shared/feature-rows";
import type {
  AutostartState, CiItemRef, CreateTicketInput, Followup, FollowupStatus, HandoffOutcome, HandoffRecord, HealthReport, McpProbe, OpenSessionRequest,
  OpenSessionResult, Ticket, TicketRepo, TicketStatus, TicketView, UnclaimedSession, UpdateTicketInput, AddRepoInput, UpdateRepoInput,
  JobStateView, CreateFeatureInput, Feature, FeatureRepo, FeatureHandoffOutcome, FeatureView, OpenFeatureSessionRequest, OpenFixSessionRequest, ScanResult,
  OpenShipherdSessionRequest, ShipherdView, MessageScope, MessageView, DeliverNowResult, MergeEvent, NowView, UsageSummary, WatchedPr, RefreshSessionResult, InboxScope, InboxView, InboxItemView,
} from "../../shared/types";

declare global {
  interface Window {
    shipherd: {
      platform: string;
      /** 旧的 preload 没有这一项：当 webgl。 */
      terminalRenderer?: "webgl" | "dom";
      terminalCacheMax?: number | null;
      pathForFile(file: File): string;
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;
      send(channel: string, ...args: unknown[]): void;
      on(channel: string, cb: (...args: never[]) => void): () => void;
    };
  }
}

export class ShipherdError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await window.shipherd.invoke(channel, ...args)) as IpcResult<T>;
  if (!r.ok) throw new ShipherdError(r.code, r.message);
  return r.value;
}

export const platform = (): string => window.shipherd.platform;
export const terminalRendererPref = (): "webgl" | "dom" => window.shipherd.terminalRenderer ?? "webgl";
export const terminalCacheMaxPref = (): number | null => window.shipherd.terminalCacheMax ?? null;
export const pathForFile = (file: File): string => window.shipherd.pathForFile(file);

// 整个渲染进程只挂一个 state:changed 监听（BTL-242）。
const stateBus = createStateBus();
let stateBusOn = false;
function ensureStateBus(): void {
  if (stateBusOn) return;
  stateBusOn = true;
  window.shipherd.on(IPC.stateChanged, (payload) => stateBus.dispatch(payload));
}

/** 终端快照和它对应的输出位置（BTL-242，见主进程的 PtyManager.snapshotAt / since）。 */
export interface PtyMarked {
  data: string;
  exitCode: number | null;
  mark: { epoch: number; end: number };
}

export const api = {
  listTickets: () => call<TicketView[]>(IPC.ticketsList),
  ticketGlance: (key: string) => call<TicketGlance>(IPC.ticketsGlance, key),
  createTicket: (input: CreateTicketInput) => call<Ticket>(IPC.ticketsCreate, input),
  setStatus: (key: string, status: TicketStatus | null) => call<void>(IPC.ticketsSetStatus, key, status),
  /** 关闭框打开时：这个 ticket 开着的 PR 里能关的、关不了的和原因（BTL-270）。 */
  closePreview: (key: string) => call<ClosePreview>(IPC.ticketsClosePreview, key),
  closeTicket: (key: string, o: { reason: string; closePrs: boolean; endSessions: boolean; prUrls?: string[] }) =>
    call<CloseLeftoversResult & { ignoredFollowups: number }>(IPC.ticketsClose, key, o),
  /** 关闭以后重试上次没关成的 PR、没结束的 session（BTL-270）。 */
  retryClose: (key: string, o: { prUrls: string[]; sessionIds: string[] }) => call<CloseLeftoversResult>(IPC.ticketsCloseRetry, key, o),
  reopenTicket: (key: string) => call<{ restoredFollowups: number; status: TicketStatus }>(IPC.ticketsReopen, key),
  archive: (key: string) => call<void>(IPC.ticketsArchive, key),
  switchBranch: (repoId: number) => call<void>(IPC.ticketsSwitchBranch, repoId),
  addRepo: (input: AddRepoInput) => call<TicketRepo>(IPC.ticketsAddRepo, input),
  updateRepo: (input: UpdateRepoInput) => call<TicketRepo>(IPC.ticketsUpdateRepo, input),
  removeRepo: (repoId: number) => call<void>(IPC.ticketsRemoveRepo, repoId),
  updateTicket: (input: UpdateTicketInput) => call<Ticket>(IPC.ticketsUpdate, input),
  archivedTickets: () => call<Ticket[]>(IPC.ticketsArchived),
  unarchive: (key: string) => call<void>(IPC.ticketsUnarchive, key),
  clipboardRead: () => call<string>(IPC.clipboardRead),
  clipboardWrite: (text: string) => call<void>(IPC.clipboardWrite, text),
  openSession: (req: OpenSessionRequest) => call<OpenSessionResult>(IPC.sessionsOpen, req),
  recheckCleanup: (ticketKey: string) => call<unknown>(IPC.ticketsRecheckCleanup, ticketKey),
  listFeatures: () => call<FeatureView[]>(IPC.featuresList),
  createFeature: (input: CreateFeatureInput) => call<Feature>(IPC.featuresCreate, input),
  renameFeature: (id: number, name: string) => call<Feature>(IPC.featuresRename, id, name),
  addFeatureRepo: (id: number, repoPath: string) => call<FeatureRepo>(IPC.featuresAddRepo, id, repoPath),
  removeFeatureRepo: (featureRepoId: number) => call<void>(IPC.featuresRemoveRepo, featureRepoId),
  archiveFeature: (id: number) => call<void>(IPC.featuresArchive, id),
  archivedFeatures: () => call<Feature[]>(IPC.featuresArchived),
  unarchiveFeature: (id: number) => call<void>(IPC.featuresUnarchive, id),
  openFeatureSession: (req: OpenFeatureSessionRequest) => call<OpenSessionResult>(IPC.featuresOpenSession, req),
  /** epic 自己选的自动化档位（BTL-247）；null = 跟随全局。 */
  setFeatureAutomationLevel: (id: number, level: AutomationLevel | null) => call<void>(IPC.featuresSetAutomationLevel, id, level),
  automationState: () => call<AutomationState>(IPC.automationState),
  shipherdView: () => call<ShipherdView>(IPC.shipherdView),
  messages: (scope: MessageScope) => call<MessageView[]>(IPC.messagesList, scope),
  /** 「现在送进去」（BTL-269）。 */
  deliverNow: (id: string) => call<DeliverNowResult>(IPC.messagesDeliverNow, id),
  metrics: (days?: number) => call<MetricsOverview>(IPC.metricsView, days),
  openShipherdSession: (req: OpenShipherdSessionRequest) => call<OpenSessionResult>(IPC.shipherdOpenSession, req),
  openFixSession: (req: OpenFixSessionRequest) => call<OpenSessionResult>(IPC.sessionOpenFix, req),
  scanRepos: (dir: string) => call<ScanResult>(IPC.reposScan, dir),
  unclaimed: () => call<UnclaimedSession[]>(IPC.sessionsUnclaimed),
  unclaimedCount: () => call<number>(IPC.sessionsUnclaimedCount),
  claim: (sessionId: string, ticketKey: string) => call<void>(IPC.sessionsClaim, sessionId, ticketKey),
  dismiss: (sessionId: string) => call<void>(IPC.sessionsDismiss, sessionId),
  hideSession: (sessionId: string) => call<void>(IPC.sessionsHide, sessionId),
  unhideSession: (sessionId: string) => call<void>(IPC.sessionsUnhide, sessionId),
  refreshSession: (sessionId: string) => call<RefreshSessionResult>(IPC.sessionsRefresh, sessionId),
  closeIdleSessions: (sessionIds: string[]) => call<number>(IPC.sessionsCloseIdle, sessionIds),
  deleteHiddenSessions: (sessionIds: string[]) => call<number>(IPC.sessionsDeleteHidden, sessionIds),
  pinSession: (sessionId: string, pinned: boolean) => call<void>(IPC.sessionsPin, sessionId, pinned),
  wakeSession: (sessionId: string) => call<"woken" | "not_hibernated" | "cooldown" | "failed">(IPC.sessionsWake, sessionId),
  ptySnapshot: (termId: string) => call<PtyMarked>(IPC.ptySnapshot, termId),
  ptySince: (termId: string, mark: PtyMarked["mark"]) => call<PtyMarked & { reset: boolean }>(IPC.ptySince, termId, mark),
  ptyKill: (termId: string) => call<void>(IPC.ptyKill, termId),
  ptyWrite: (termId: string, data: string) => window.shipherd.send(IPC.ptyWrite, termId, data),
  ptyResize: (termId: string, cols: number, rows: number) => window.shipherd.send(IPC.ptyResize, termId, cols, rows),
  ptyVisible: (termId: string, visible: boolean) => window.shipherd.send(IPC.ptyVisible, termId, visible),
  /** 这个终端的 xterm 实例销毁了：主进程不再给它推 pty:data（BTL-242）。 */
  ptyDetach: (termId: string) => window.shipherd.send(IPC.ptyDetach, termId),
  /** 性能诊断（BTL-242）。 */
  diagReport: (totals: LongTaskTotals) => window.shipherd.send(IPC.diagRenderer, totals),
  diagSnapshot: (resetMeasure = false) => call<DiagSnapshot | null>(IPC.diagSnapshot, resetMeasure),
  /** 弹保存对话框写一份诊断文件；返回写到的路径，取消为 null。 */
  diagExport: () => call<string | null>(IPC.diagExport),
  /** 发送反馈（BTL-254）。 */
  feedbackOpen: (r: { kind: FeedbackKind; title: string; description: string; step?: string; attachDiagnostics: boolean }) =>
    call<{ url: string; truncated: boolean }>(IPC.feedbackOpen, r),
  feedbackDiagPreview: () => call<string>(IPC.feedbackDiagPreview),
  feedbackDiagSave: () => call<{ path: string; name: string }>(IPC.feedbackDiagSave),
  memUsageHistory: (hours = 24) => call<MemoryHistoryPoint[]>(IPC.memUsageHistory, hours),
  health: () => call<HealthReport>(IPC.healthGet),
  installHooks: () => call<HealthReport>(IPC.healthInstallHooks),
  uninstallHooks: () => call<HealthReport>(IPC.healthUninstallHooks),
  pickDirectory: () => call<string | null>(IPC.dialogPickDir),
  mergeEvents: () => call<MergeEvent[]>(IPC.mergeEvents),
  /** 后台监视的 PR；给了 ticketKey 只取这一个 ticket 的（BTL-270 审查：ticket 页不全量扫）。 */
  prWatchList: (ticketKey?: string) => call<WatchedPr[]>(IPC.prWatchList, ticketKey),
  prStages: (scope: PrStagesScope) => call<PrStagesTicket[]>(IPC.prStages, scope),
  prOpen: (url: string) => call<{ ok: true } | { ok: false; reason: "bad_url" }>(IPC.prOpen, url),
  /** 终端里点的链接（BTL-257）：主进程只放行 http / https，交给系统浏览器。 */
  linkOpen: (url: string) => call<{ ok: true } | { ok: false; reason: "bad_url" }>(IPC.linkOpen, url),
  lessonsState: () => call<LessonsState>(IPC.lessonsState),
  lessonsAct: (a: LessonAction) => call<LessonActResult>(IPC.lessonsAct, a),
  lessonsRuns: (slug: string) => call<LessonQueueRowView[]>(IPC.lessonsRuns, slug),
  lessonsRun: (id: number) => call<LessonRunDetail | null>(IPC.lessonsRun, id),
  lessonsPending: () => call<number>(IPC.lessonsPending),
  lessonsBatches: (opts?: { limit?: number; beforeId?: number }) => call<BatchView[]>(IPC.lessonsBatches, opts ?? {}),
  lessonsBatch: (id: number) => call<BatchDetail | null>(IPC.lessonsBatch, id),
  admissionState: () => call<AdmissionPageState>(IPC.admissionState),
  wizardEstimate: (scope: AdmissionScope) => call<WizardEstimate>(IPC.wizardEstimate, scope),
  wizardAct: (a: WizardAction) => call<WizardActResult>(IPC.wizardAct, a),
  calibrationSample: (scope: AdmissionScope) => call<CalibrationSample>(IPC.calibrationSample, scope),
  calibrationStats: (since: number | null) => call<CalibrationStatsView>(IPC.calibrationStats, since),
  calibrationAct: (a: CalibrationAction) => call<CalibrationActResult>(IPC.calibrationAct, a),
  principlesRegroup: () => call<RegroupResult>(IPC.principlesRegroup),
  policiesGet: (scope: PolicyScope) => call<AdmissionPolicyView>(IPC.policiesGet, scope),
  policiesSet: (scope: PolicyScope, overrides: AdmissionPolicyOverrides) => call<{ batchId: number | null; version: number }>(IPC.policiesSet, { scope, overrides }),
  loopPolicyGet: (scope: LoopScope) => call<LoopPolicyView>(IPC.loopPolicyGet, scope),
  loopPolicySet: (scope: LoopScope, overrides: LoopPolicyOverrides) => call<void>(IPC.loopPolicySet, { scope, overrides }),
  loopComments: (ticketKey: string) => call<PrCommentsView[]>(IPC.loopCommentsList, ticketKey),
  loopCommentsAct: (a: CommentAction) => call<CommentItemView | null>(IPC.loopCommentsAct, a),
  stacks: (filter: StacksFilter) => call<StacksView>(IPC.stacksList, filter),
  stacksRebase: (stackId: number) => call<StackActionResult>(IPC.stacksRebase, stackId),
  stacksLayerMode: (layerId: number, mode: StackLayerMode) => call<StackActionResult>(IPC.stacksLayerMode, { layerId, mode }),
  stacksRestore: (stackId: number) => call<StackActionResult>(IPC.stacksRestore, stackId),
  stacksRemove: (stackId: number) => call<StackActionResult>(IPC.stacksRemove, stackId),
  stacksPolicyGet: (scope: PolicyScope) => call<StackPolicyView>(IPC.stacksPolicyGet, scope),
  stacksPolicySet: (scope: PolicyScope, overrides: StackPolicyOverrides) => call<StackPolicySetResult>(IPC.stacksPolicySet, { scope, overrides }),
  stacksPolicyLayers: () => call<StackPolicyLayer[]>(IPC.stacksPolicyLayers),
  loopFlaky: () => call<FlakyEntry[]>(IPC.loopFlakyList),
  loopFlakyAct: (a: FlakyAction) => call<boolean>(IPC.loopFlakyAct, a),
  /** 给「效果」页（工作流 H）：最近 days 天（1–365，默认 30）评论闭环和 CI 分类做了什么。 */
  loopEffect: (days?: number) => call<LoopEffect>(IPC.loopEffect, days ?? 30),
  interruptsState: () => call<InterruptsState>(IPC.interruptsState),
  interruptsAct: (a: InterruptsAction) => call<InterruptsActResult>(IPC.interruptsAct, a),
  profilesGet: () => call<ProfileScan>(IPC.profilesGet),
  profilesScan: (explain = false) => call<ProfileScan>(IPC.profilesScan, { explain }),
  prAssessment: (ticketKey: string) => call<TicketAssessmentView>(IPC.prAssessment, ticketKey),
  preReviewRun: (prId: number) => call<ReviewActResult>(IPC.preReviewRun, prId),
  briefRegenerate: (prId: number) => call<ReviewActResult>(IPC.briefRegenerate, prId),
  briefPost: (prId: number) => call<ReviewActResult>(IPC.briefPost, prId),
  prPolicyGet: (scope: PrScope) => call<PrPolicyView>(IPC.prPolicyGet, scope),
  prPolicySet: (scope: PrScope, overrides: PrPolicyOverrides) => call<void>(IPC.prPolicySet, { scope, overrides }),
  reviewEffect: (days?: number) => call<ReviewEffectView>(IPC.reviewEffect, days ?? 30),
  reviewQueue: () => call<ReviewQueueItem[]>(IPC.reviewQueue),
  /** 预审看得见（BTL-271）：一批 ticket / session / PR 的徽标一次要。 */
  preReviewStatus: (req: PreReviewStatusRequest) => call<PreReviewStatusBatch>(IPC.preReviewStatus, req),
  preReviewQueue: () => call<PreReviewQueueView>(IPC.preReviewQueue),
  preReviewQueueAct: (a: PreReviewQueueAction) => call<PreReviewQueueActResult>(IPC.preReviewQueueAct, a),
  checksView: (scope: CheckScope) => call<ChecksView>(IPC.checksView, scope),
  checksHits: (key: string) => call<CheckHitView[]>(IPC.checksHits, key),
  checksAct: (a: ChecksAction) => call<ChecksActResult>(IPC.checksAct, a),
  checksDraft: (lessonId: number) => call<CheckDraftResult>(IPC.checksDraft, lessonId),
  backtestView: () => call<BacktestView>(IPC.backtestView),
  intakeView: () => call<IntakeView>(IPC.intakeView),
  intakeEffect: (days?: number) => call<IntakeEffect>(IPC.intakeEffect, days ?? 30),
  intakePolicyGet: (scope: PolicyScope) => call<IntakePolicyView>(IPC.intakePolicyGet, scope),
  intakePolicySet: (scope: PolicyScope, overrides: IntakePolicyOverrides) => call<IntakePolicySetResult>(IPC.intakePolicySet, { scope, overrides }),
  intakeClassify: (e: IntakeClassifyEdit) => call<IntakeActResult>(IPC.intakeClassify, e),
  intakePoll: () => call<IntakeActResult>(IPC.intakePoll),
  intakeAct: (a: IntakeAction) => call<IntakeActResult>(IPC.intakeAct, a),
  backtestAct: (a: BacktestAction) => call<BacktestActResult>(IPC.backtestAct, a),
  baselinesView: () => call<BaselinesView>(IPC.baselinesView),
  baselinesAct: (a: BaselinesAction) => call<BaselinesActResult>(IPC.baselinesAct, a),
  baselinesRules: (scope: CheckScope) => call<RuleRowView[]>(IPC.baselinesRules, scope),
  baselinesSummary: (scope: CheckScope) => call<BaselineSummary>(IPC.baselinesSummary, scope),
  legacyView: () => call<LegacyScanView[]>(IPC.legacyView),
  legacyAct: (a: LegacyAction) => call<{ ok: true } | { ok: false; message: string }>(IPC.legacyAct, a),
  legacyViolations: (scanId: number, offset = 0, limit = 200) => call<LegacyViolation[]>(IPC.legacyViolations, { scanId, offset, limit }),
  checkExportList: () => call<CheckExportView[]>(IPC.checkExportList),
  checkExportAct: (a: CheckExportAction) => call<CheckExportResult>(IPC.checkExportAct, a),
  configStatus: () => call<ConfigIoStatus>(IPC.configStatus),
  configExport: (req: ExportRequest) => call<ExportResult>(IPC.configExport, req),
  configImportPreview: () => call<ImportPreviewResult>(IPC.configImportPreview),
  configImportRetarget: (token: string, target: StarterTarget) => call<ImportPreviewResult>(IPC.configImportRetarget, { token, target }),
  configImportApply: (req: ImportApplyRequest) => call<ImportApplyResult>(IPC.configImportApply, req),
  configBackupNow: () => call<{ ok: true; name: string } | { ok: false }>(IPC.configBackupNow),
  configOpenBackups: () => call<void>(IPC.configOpenBackups),
  availability: () => call<AvailabilityView>(IPC.availabilityGet),
  availabilityAct: (a: AvailabilityAction) => call<void>(IPC.availabilityAct, a),
  /** 模型路由（3.0）：act 返回错误文字，成功为 null。 */
  routingView: () => call<RoutingView>(IPC.routingView),
  routingAct: (a: RoutingAction) => call<string | null>(IPC.routingAct, a),
  /** 花费上限和成本熔断（工作流 L）。 */
  costView: (scope: PolicyScope) => call<CostView>(IPC.costView, scope),
  costSet: (scope: PolicyScope, overrides: CostPolicyOverrides) => call<CostSetResult>(IPC.costSet, { scope, overrides }),
  costResume: (subjectKind: CostSubjectKind, subjectId: string) => call<CostResumeResult>(IPC.costResume, { subjectKind, subjectId }),
  costBreakers: () => call<CostBreakerView[]>(IPC.costBreakers),
  /** 后台调度（工作流 L）。 */
  backgroundStatus: () => call<BackgroundStatusView>(IPC.backgroundStatus),
  backgroundAct: (a: BackgroundAction) => call<void>(IPC.backgroundAct, a),
  switchModel: (sessionId: string, model?: string) => call<SwitchModelResult>(IPC.sessionsSwitchModel, sessionId, model ?? null),
  dismissSessionLimit: (sessionId: string) => call<void>(IPC.sessionsDismissLimit, sessionId),
  sessionLimits: () => call<SessionLimitView[]>(IPC.sessionsLimits),
  ciResend: (item: CiItemRef) => call<string>(IPC.ciResend, item),
  nowView: () => call<NowView>(IPC.nowView),
  /** 「谁该动」看板（UI 重做第 1 层）：不带 filter 是首页。 */
  // filter 先规整成一个键（ticketKey > featureId，值为 undefined 的不算），和主进程的校验一致。
  turnBoard: (filter?: TurnFilter) => call<TurnBoard>(IPC.turnBoard, normTurnFilter(filter)),
  /** 切到首页时调一次：补查请你 review 的 PR。turnBoard 本身不触发查询，收到 turn:changed 重取时不用管它。 */
  turnHomeOpened: () => call<void>(IPC.turnHomeOpened),
  // 可以直接传 TurnItem.pr（带 title、url）：只发 repo 和 number。
  turnSendToAgent: (item: { ticketKey: string; pr: { repo: string; number: number } }) =>
    call<{ ok: boolean; reason?: TurnSendReason }>(IPC.turnSendToAgent, { ticketKey: item.ticketKey, pr: { repo: item.pr.repo, number: item.pr.number } }),
  inbox: (scope: InboxScope) => call<InboxView>(IPC.inboxList, scope),
  answerInbox: (id: number, text: string) => call<boolean>(IPC.inboxAnswer, id, text),
  /** 「总控已代答」（BTL-269 A2）：改答案或者知道了；不能改了返回 false。 */
  inboxBehalf: (a: { op: "correct"; id: number; text: string } | { op: "dismiss"; id: number }) => call<boolean>(IPC.inboxBehalf, a),
  followups: (ticketKey: string) => call<Followup[]>(IPC.followupsList, ticketKey),
  setFollowupStatus: (id: string, status: FollowupStatus) => call<void>(IPC.followupsSetStatus, id, status),
  handoffs: (ticketKey: string) => call<HandoffRecord[]>(IPC.handoffsList, ticketKey),
  runHandoff: (ticketKey: string) => call<HandoffOutcome>(IPC.handoffsRun, ticketKey),
  runFeatureSummary: (featureId: number) => call<FeatureHandoffOutcome>(IPC.featuresSummaryRun, featureId),
  runNightly: () => call<JobStateView | null>(IPC.jobsRunNightly),
  settings: () => call<EditableSettings>(IPC.settingsGet),
  setSetting: (key: EditableSettingKey, value: string) => call<void>(IPC.settingsSet, key, value),
  resetSetting: (key: EditableSettingKey) => call<void>(IPC.settingsReset, key),
  detectTrackerTools: () => call<McpProbe>(IPC.settingsDetectTrackerTools),
  /** 设置 › 功能：全局策略值和仓库、产品层的覆盖（一次读完）。 */
  featurePolicy: () => call<FeaturePolicyState>(IPC.settingsFeaturePolicy),
  /** 改全局那一层的一个功能开关，同层其他覆盖保留。 */
  policyPatch: (p: { family: PolicyFamily; key: string; value: boolean }) => call<void>(IPC.settingsPolicyPatch, p),
  externalAudit: () => call<ExternalActionEntry[]>(IPC.externalAuditList),
  memoryView: (ticketKey: string) => call<MemoryView>(IPC.memoryView, ticketKey),
  autostart: () => call<AutostartState>(IPC.appAutostartGet),
  language: () => call<Lang>(IPC.appLanguage),
  setAutostart: (on: boolean) => call<AutostartState>(IPC.appAutostartSet, on),
  keepAwake: () => call<boolean>(IPC.appKeepAwakeGet),
  setKeepAwake: (on: boolean) => call<boolean>(IPC.appKeepAwakeSet, on),
  // 更新提示（BTL-253）
  updateState: () => call<UpdateView>(IPC.updateState),
  checkUpdates: () => call<UpdateCheckResult>(IPC.updateCheck),
  skipUpdate: (version: string) => call<void>(IPC.updateSkip, version),
  dismissUpdate: (version: string) => call<void>(IPC.updateDismiss, version),
  openRelease: () => call<void>(IPC.updateOpenRelease),
  /** 应用菜单点了要界面做的事（BTL-253 / 254）。 */
  onAppMenu: (cb: (action: AppMenuAction) => void) => window.shipherd.on(IPC.appMenu, cb),
  memoryWhy: (ticketKey: string, factId: string) => call<WhyEntry[] | null>(IPC.memoryWhy, ticketKey, factId),
  usageSummary: () => call<UsageSummary>(IPC.usageSummary),
  dismissActivity: (sessionId: string) => call<void>(IPC.activityDismiss, sessionId),
  onPtyData: (cb: (termId: string, data: string) => void) => window.shipherd.on(IPC.ptyData, cb),
  onPtyExit: (cb: (termId: string, code: number) => void) => window.shipherd.on(IPC.ptyExit, cb),
  /** 不给 scopes 只听 data；跟着 session 活动变的视图传 LIVE_SCOPES（BTL-242）。 */
  onStateChanged: (cb: (scopes: StateScope[]) => void, scopes?: readonly StateScope[]) => {
    ensureStateBus();
    return stateBus.subscribe(cb, scopes);
  },
  onTurnChanged: (cb: () => void) => window.shipherd.on(IPC.turnChanged, cb),
  onKeepAwakeChanged: (cb: (on: boolean) => void) => window.shipherd.on(IPC.appKeepAwakeChanged, cb),
  /** 实况窗口（BTL-190 第 7 点）：开着的 session 新的一次工具调用、记忆读写、回合开始 / 结束。 */
  onActivityEvent: (cb: (e: ActivityEvent) => void) => window.shipherd.on(IPC.activityEvent, cb),
  /** 记忆写进了 StateCore（ticketKey），或记忆开关变了（null：所有 ticket）。 */
  onMemoryChanged: (cb: (ticketKey: string | null) => void) => window.shipherd.on(IPC.memoryChanged, cb),
  /** 对话另存（UI 重做第 4 层）：sessionId 可以是链上任意一段；推送的永远是链根（拿 SessionView.rootId 比对）。 */
  convList: (sessionId: string, opts: ConvListOpts) => call<ConvPage>(IPC.convList, sessionId, opts),
  convSearch: (sessionId: string | null, query: string) => call<ConvMessage[]>(IPC.convSearch, sessionId, query),
  onConvAppended: (cb: (rootSessionId: string) => void) => window.shipherd.on(IPC.convAppended, cb),
  /** 对话 tab（UI 重做第 5 层）：forkId 为 null 开一个新的分叉讨论，数字接着问那个分叉。 */
  forkAsk: (rootSessionId: string, forkId: number | null, question: string) => call<{ forkId: number }>(IPC.forkAsk, rootSessionId, forkId, question),
  forkSendConclusion: (forkId: number) => call<DevSendResult>(IPC.forkSendConclusion, forkId),
  forkReaskFull: (forkId: number) => call<{ forkId: number }>(IPC.forkReaskFull, forkId),
  forkList: (anyId: string) => call<ForkView[]>(IPC.forkList, anyId),
  forkRemember: (forkId: number) => call<{ result: RememberResult }>(IPC.forkRemember, forkId),
  convSend: (anyId: string, text: string) => call<DevSendResult>(IPC.convSend, anyId, text),
  /** 总控对话区的汇报分页：before 是上一页最早一条汇报的 id（不是时间），不给是最新一页。 */
  inboxReports: (scope: InboxScope, o: { before?: number; limit: number }) => call<{ reports: InboxItemView[]; hasMore: boolean }>(IPC.inboxReports, scope, o),
  onForkChanged: (cb: (rootSessionId: string) => void) => window.shipherd.on(IPC.forkChanged, cb),
  /** 信息流转（BTL-272）：要点列表、那一轮的原话、对同步的状态变化照做 / 不用 / 撤销 / 知道了。 */
  infoflowList: (scope: FlowScope) => call<FlowItemView[]>(IPC.infoflowList, scope),
  infoflowTurn: (turnId: number) => call<FlowTurnText>(IPC.infoflowTurn, turnId),
  infoflowAct: (actionId: number, what: "apply" | "reject" | "undo" | "dismiss" | "retry" | "accept") => call<boolean>(IPC.infoflowAct, actionId, what),
};
