import type { TicketGlance } from "../../shared/ticket-glance";
import type { TurnBoard, TurnFilter, TurnSendReason } from "../../shared/turn";
import type { MetricsOverview } from "../../shared/metrics";
import type { BacktestActResult, BacktestAction, BacktestView } from "../../shared/backtest";
import type { IntakeActResult, IntakeAction, IntakeClassifyEdit, IntakeEffect, IntakePolicySetResult, IntakePolicyView, IntakeView } from "../../shared/intake";
import type { BatchRecorder } from "../batches/batch-recorder";
import type { AdmissionPolicyService } from "../lessons/admission-policies";
import type { CheckDraftResult, CheckHitView, CheckScope, ChecksAction, ChecksActResult, ChecksView } from "../../shared/checks";
import type { ConfigIoFacade } from "../config-io/facade";
import type { BatchDetail, BatchView } from "../../shared/batches";
import type { AdmissionPolicyView, PolicyScope } from "../../shared/admission-policy";
import type { BackgroundAction, BackgroundStatusView } from "../../shared/background";
import type { CostBreakerView, CostResumeResult, CostSetResult, CostSubjectKind, CostView } from "../../shared/cost";
import type {
  AdmissionPageState, AdmissionScope, CalibrationAction, CalibrationActResult, CalibrationSample, CalibrationStatsView, RegroupResult, WizardAction, WizardActResult, WizardEstimate,
} from "../../shared/lesson-admission";

/** 规矩准入的页面接口（index.ts 拼起来）。 */
export interface AdmissionFacade {
  state(): AdmissionPageState;
  estimate(scope: AdmissionScope): Promise<WizardEstimate>;
  wizardAct(a: WizardAction): Promise<WizardActResult>;
  calibrationSample(scope: AdmissionScope): CalibrationSample;
  calibrationStats(since: number | null): CalibrationStatsView;
  calibrationAct(a: CalibrationAction): CalibrationActResult;
  regroupPrinciples(): Promise<RegroupResult>;
}
import type { LoopPolicyOverrides, LoopPolicyView, LoopScope } from "../../shared/loop-policy";
import type { PrPolicyView, PrScope } from "../../shared/pr-policy";
import type {
  PreReviewQueueAction, PreReviewQueueActResult, PreReviewQueueView, PreReviewStatusBatch, PreReviewStatusRequest, ReviewActResult, ReviewQueueItem, TicketAssessmentView,
} from "../../shared/prereview";
import type { ReviewEffectView } from "../../shared/review-effect";
import type { CommentAction, CommentItemView, FlakyAction, FlakyEntry, LoopEffect, PrCommentsView } from "../../shared/loop";
import type { ConfigIoStatus, ExportResult, ImportApplyResult, ImportPreviewResult } from "../../shared/config-io";
import type { MemoryHistoryPoint } from "../../shared/mem-usage";
import type { StackActionResult, StackLayerMode, StackPolicyLayer, StackPolicySetResult, StackPolicyView, StacksFilter, StacksView } from "../../shared/stacks";
import { clipboard, dialog, ipcMain, type BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc";
import {
  FOLLOWUP_STATUSES, type AutostartState, type CiItemRef, type FollowupStatus, type InboxView, type JobStateView, type McpProbe, type MergeEvent, type DeliverNowResult, type MessageScope, type MessageView, type NowView, type OpenSessionRequest, type RefreshSessionResult, type TicketStatus, type ManualTicketStatus, type WatchedPr, type TicketView, type FeatureView,
} from "../../shared/types";
import type { ExternalActionEntry } from "../../shared/external";
import type { ExternalAuditRepo } from "../db/external-audit-repo";
import type { MemoryService } from "../memory/memory-service";
import { JOB_NIGHTLY, type JobsRepo } from "../db/jobs-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MergeGateRepo } from "../db/merge-gate-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { UsageRepo } from "../db/usage-repo";
import { summarizeUsage, USAGE_WINDOW_MS } from "../usage/usage-summary";
import type { TicketsRepo } from "../db/tickets-repo";
import type { CloseOptions, CloseResult, ClosePreview, ReopenResult, RetryCloseOptions, RetryCloseResult, SetStatusResult } from "../tickets/ticket-close";
import type { HandoffRunner } from "../handoff/runner";
import type { FeatureSummaryRunner } from "../handoff/feature-runner";
import type { HealthService } from "../hooks/health";
import type { PrStagesTicket } from "../../shared/pr-stages";
import type { LessonQueueRowView, LessonRunDetail, LessonsState } from "../../shared/lessons";
import type { LessonsService } from "../lessons/lessons-service";
import type { PrStagesService } from "../prwatch/pr-stages-service";
import type { PrOpenResult } from "../util/github-url";
import type { LinkOpenResult } from "../util/external-link";
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
import type { ConversationStore } from "../conversation/conversation-store";
import { memoryHandlers } from "./memory-handlers";
import { convHandlers } from "./conv-handlers";
import { forkHandlers } from "./fork-handlers";
import type { ForkService } from "../fork/fork-service";
import type { DevSender } from "../fork/dev-send";
import { settingsHandlers } from "./settings-handlers";
import { featurePolicyHandlers, featurePolicyLayers } from "./feature-policy-handlers";
import { isAutomationLevel, type AutomationLevel, type AutomationState } from "../../shared/automation";
import type { FeaturePolicyState } from "../../shared/feature-rows";
import { interruptsActionArg, type InterruptsFacade } from "../interrupts/facade";
import type { InterruptsActResult, InterruptsState, ProfileScan } from "../../shared/interrupts";
import {
  addRepoArg, automationLevelArg, closeRetryArg, closeTicketArg, backgroundActionArg, costSetArg, costSubjectArg, commentActionArg, flakyActionArg, loopSetArg, routingActionArg, switchModelArg, availabilityActionArg, boolArg, ciItemArg, turnFilterArg, turnSendArg, clipboardTextArg, createFeatureArg, createTicketArg, dirArg, featureIdArg, featureNameArg, inboxAnswerArg, inboxBehalfArg, inboxIdArg, inboxScopeArg, messageScopeArg, lessonActionArg, lessonRunIdArg, lessonSlugArg, prStagesScopeArg, prUrlArg,
  openShipherdArg, openFeatureArg, openFixArg, repoIdArg, sessionIdArg, sessionIdsArg, ticketKeyArg, updateRepoArg, updateTicketArg, batchIdArg, batchListArg, exportRequestArg, importApplyArg, importRetargetArg, policyScopeArg, policySetArg, checkScopeArg, checkKeyArg, checksActionArg, checkLessonIdArg, admissionScopeArg, wizardActionArg, calibrationSinceArg, calibrationActionArg, baselinesActionArg, legacyActionArg, legacyViolationsArg, checkExportActionArg,
  versionArg, stacksFilterArg, stackIdArg, stackLayerModeArg, stackPolicySetArg, backtestActionArg, prIdArg, prPolicySetArg, intakeActionArg, intakeClassifyArg, intakePolicySetArg, reportsPageArg, feedbackOpenArg, linkUrlArg, preReviewStatusArg, preReviewQueueActionArg, messageIdArg, flowScopeArg, flowIdArg, flowActArg } from "./validate";
import type { BaselineSummary, BaselinesAction, BaselinesActResult, BaselinesView, CheckExportAction, CheckExportResult, CheckExportView, LegacyScanView, LegacyViolation, RuleRowView } from "../../shared/baselines";
import { M } from "../strings";
import type { ClaudeAvailability } from "../claude/availability";
import type { AvailabilityView } from "../../shared/availability";
import type { RoutingAction, RoutingView, SessionLimitView } from "../../shared/model-routing";
import type { SwitchResult } from "../routing/session-switch";
import type { DiagService } from "../diag/diag-service";
import type { FeedbackService } from "../feedback/feedback-service";
import type { InfoflowService } from "../infoflow/infoflow-service";
import type { FlowItemView, FlowTurnText } from "../../shared/infoflow";
import { isReadChannel } from "./read-channels";
import type { UpdateCheckResult, UpdateView } from "../../shared/update";
import type { PtySubscriptions } from "../sessions/pty-subscriptions";
import { attachSince, attachSnapshot } from "../sessions/pty-attach";

export interface IpcDeps {
  tickets: TicketsRepo;
  ticketService: TicketService;
  featureService: FeatureService;
  sessionService: SessionService;
  activity: Pick<ActivityMonitor, "dismiss">;
  usage: Pick<UsageRepo, "since">;
  sessions: Pick<SessionsRepo, "get">;
  pty: PtyManager;
  /** 用户在界面上点 × 结束一个终端之前（BTL-256：记成用户结束，之后不自动恢复）。 */
  userEnded?: (termId: string) => void;
  health: HealthService;
  followups: FollowupsRepo;
  handoffs: HandoffsRepo;
  settings: SettingsRepo;
  gateRepo: Pick<MergeGateRepo, "recentEvents">;
  /** PrWatcher 跟着的 PR 和 CI：不带参数是全部，带了 ticketKey 只取这一个 ticket 的（prWatchListHandler，参数在里面校验）。 */
  prWatchList: (raw: unknown) => WatchedPr[];
  /** PR 进度。 */
  prStages: Pick<PrStagesService, "view">;
  /** 在系统浏览器里打开 PR 链接：只开 ticket 链接过、主机允许的（openKnownPr）。 */
  prOpen: (url: string) => PrOpenResult;
  /** 终端里点的链接（BTL-257）：在系统浏览器里打开，只放行 http / https（openExternalLink）。 */
  linkOpen: (url: string) => LinkOpenResult;
  /** 复盘规矩页。 */
  lessons: Pick<LessonsService, "state" | "warm" | "act" | "pendingCount" | "runs" | "run">;
  /** 批次历史（契约 4.4）。 */
  batches: Pick<BatchRecorder, "list" | "get">;
  /** 规矩准入（工作流 D）：向导、校准页、原则。 */
  admission: AdmissionFacade;
  /** 三层准入策略（契约 4.2）。 */
  policies: Pick<AdmissionPolicyService, "view" | "setLayer">;
  /** 评论闭环和 CI 分类（工作流 I）：策略、评论项、flaky 名单、效果。 */
  loop: {
    policyView(scope: LoopScope): LoopPolicyView;
    policySet(scope: LoopScope, overrides: LoopPolicyOverrides): void;
    comments(ticketKey: string): PrCommentsView[];
    act(a: CommentAction): Promise<CommentItemView | null>;
    flaky(): FlakyEntry[];
    flakyAct(a: FlakyAction): boolean;
    effect(days: unknown): LoopEffect;
  };
  /** 打断与通知（工作流 J）。 */
  interrupts: Pick<InterruptsFacade, "state" | "act" | "profiles" | "scan">;
  /** 栈式 PR（工作流 K）：全部工作页「更多」里的栈、手动操作和三层策略。 */
  stacks: {
    view(filter: StacksFilter): Promise<StacksView>;
    rebaseNow(stackId: number): Promise<StackActionResult>;
    setLayerMode(layerId: number, mode: StackLayerMode): Promise<StackActionResult>;
    restore(stackId: number): Promise<StackActionResult>;
    remove(stackId: number): StackActionResult;
    policyView(scope: PolicyScope): StackPolicyView;
    policySet(scope: PolicyScope, overrides: Record<string, unknown>): StackPolicySetResult;
    policyLayers(): StackPolicyLayer[];
  };
  /** 预审、就绪、风险、简报、review 效果（工作流 G）。 */
  review: {
    ticket(ticketKey: string): TicketAssessmentView;
    run(prId: number): ReviewActResult;
    regenerate(prId: number): Promise<ReviewActResult>;
    post(prId: number): Promise<ReviewActResult>;
    policyView(scope: PrScope): PrPolicyView;
    policySet(scope: PrScope, overrides: Record<string, unknown>): void;
    effect(days: unknown): ReviewEffectView;
    queue(): ReviewQueueItem[];
    /** 预审看得见（BTL-271）：一批徽标、整个预审队列、取消和插队。 */
    preReviewStatus(req: PreReviewStatusRequest): PreReviewStatusBatch;
    preReviewQueue(): PreReviewQueueView;
    preReviewQueueAct(a: PreReviewQueueAction): PreReviewQueueActResult;
  };
  /** 导入导出（契约 4.3）。 */
  configIo: ConfigIoFacade;
  /** 确定性检查（契约 4.5）：检查页的读、写和从规矩生成草稿。 */
  checks: { act: (a: ChecksAction) => ChecksActResult; view: (scope: CheckScope) => ChecksView; hits: (key: string) => CheckHitView[]; draft: (lessonId: number) => Promise<CheckDraftResult> };
  /** 仓库现状（工作流 E2）：扫描结果、标记文件表、摘要；存量扫描；导出成 lint。 */
  baselines: { view(): BaselinesView; act(a: BaselinesAction): BaselinesActResult; rulesView(scope: CheckScope): RuleRowView[]; summary(scope: CheckScope): BaselineSummary };
  legacy: { views(): LegacyScanView[]; start(checkId: number, slug: string): { ok: true } | { ok: false; message: string }; cancel(scanId: number): boolean; violations(scanId: number, offset: number, limit: number): LegacyViolation[] };
  checkExports: { list(): CheckExportView[]; act(a: CheckExportAction): Promise<CheckExportResult> };
  /** 回测和自动升降级（工作流 F）。 */
  backtest: { view(): BacktestView; act(a: BacktestAction): BacktestActResult };
  /** 自动接活（工作流 N）。 */
  intake: {
    view(): IntakeView;
    effect(days: number): IntakeEffect;
    policyView(scope: PolicyScope): IntakePolicyView;
    policySet(scope: PolicyScope, overrides: Record<string, unknown>): IntakePolicySetResult;
    classify(e: IntakeClassifyEdit): Promise<IntakeActResult>;
    poll(): Promise<IntakeActResult>;
    act(a: IntakeAction): Promise<IntakeActResult>;
  };
  /** Claude 可用状态；act 只有手动暂停 / 恢复复盘。 */
  availability: Pick<ClaudeAvailability, "view" | "pauseLessons" | "resumeLessons">;
  /** 模型路由（3.0）：设置页的整份数据和操作；act 返回错误文字，成功为 null。 */
  routing: { view(): RoutingView; act(a: RoutingAction): Promise<string | null> };
  /** 花费上限和成本熔断（工作流 L）。set 不合法时回错误文字（不抛）。 */
  cost: { breakers(): CostBreakerView[]; view(scope: PolicyScope): CostView; set(scope: PolicyScope, overrides: unknown): CostSetResult; resume(kind: CostSubjectKind, id: string): Promise<CostResumeResult> };
  /** 后台调度（工作流 L）。 */
  background: { status(): BackgroundStatusView; act(a: BackgroundAction): void };
  /** session 撞限后换模型（SessionModelSwitcher）。 */
  switcher: { switch(sessionId: string, model?: string): Promise<SwitchResult>; dismiss(sessionId: string): void; views(): SessionLimitView[] };
  /** 用户在终端里打字（WS-M E：马上恢复优先级）。 */
  terminalInput?: (termId: string) => void;
  /** 度量（ws-h）：用户在终端里按的键（权限确认、选项、Esc 打断）。 */
  terminalKeys?: (termId: string, data: string) => void;
  /** 度量（ws-h）：一次成功的 invoke 和它的返回值（手动触发在这里记）。 */
  onInvoked?: (channel: string, args: readonly unknown[], result: unknown) => void;
  /** 性能诊断（BTL-242）。 */
  diag?: Pick<DiagService, "report" | "snapshot" | "export" | "invoke">;
  /** 「发送反馈」（BTL-254）。 */
  feedback?: Pick<FeedbackService, "open" | "previewDiagnostics" | "saveDiagnostics">;
  /** 信息流转（BTL-272）。 */
  infoflow?: Pick<InfoflowService, "list" | "turnText" | "act">;
  /** 渲染进程挂着的终端（pty:snapshot 挂、pty:detach 摘）。 */
  ptySubs?: Pick<PtySubscriptions, "attach" | "detach">;
  /** 终端输出的攒批（BTL-277）：取快照、补段之前先把攒着的发出去，回包之后不会再重复到一次。 */
  ptyOutput?: { flush(termId: string): void };
  /** 写操作的 invoke 前后调（作废视图缓存）。 */
  onWrite?: () => void;
  /** 缓存过的视图（BTL-242）；不给就直接调 sessionService。 */
  views?: { tickets(): TicketView[]; features(): FeatureView[] };
  /** 渲染进程报的终端可见性（WS-M D、E）。 */
  terminalVisible?: (termId: string, visible: boolean) => void;
  /** 内存历史（WS-M A），since 以后的点。 */
  memoryHistory?: (since: number) => MemoryHistoryPoint[];
  /** 「现在」页：session、活动、PR、合并排队和「需要你」拼成的一份（buildNowView），merges 是“最近合并”。 */
  nowView: (merges: MergeEvent[]) => NowView;
  /** 「谁该动」看板（UI 重做第 1 层）；filter 为 null 是首页。 */
  turnBoard: (filter: TurnFilter | null) => TurnBoard;
  /** 单个 ticket 的概览（agent 最后说的话、上下文占用、链根）。 */
  ticketGlance: (ticketKey: string) => TicketGlance;
  /** 首页「发给 agent」：只有 you/unattended 且 canSend 时才走现有的递送路径。 */
  turnSendToAgent: (item: { ticketKey: string; pr: { repo: string; number: number } }) => Promise<{ ok: boolean; reason?: TurnSendReason }>;
  /** 切到首页：补查请你 review 的 PR（turn:board 本身不触发查询）。 */
  turnHomeOpened: () => void;
  /** 重发一条递不出去的 CI 结论（工作流 W）。 */
  ciResend: (item: CiItemRef) => Promise<string>;
  /** 「待你决定」和汇报（BTL-190 第 2+3 点）。 */
  inbox: Pick<InboxService, "view" | "answer" | "reportsPage" | "correctBehalf" | "dismissBehalf">;
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
  /** 对外动作的审计（契约 4.8，ws-b）。 */
  externalAudit: Pick<ExternalAuditRepo, "list">;
  /** 「效果」页（ws-h）：和总控 metrics_overview 同一份。 */
  metrics: (days: number | undefined) => MetricsOverview;
  /** Shipherd 页"回复"tab（ws-b）。 */
  /** 信箱（BTL-245）的消息：Shipherd 总控的或一个 feature 的。 */
  messages: (scope: MessageScope) => MessageView[];
  /** 用户点「现在送进去」（BTL-269）：不看在干活、需要你、刚打过字，草稿、确认框照样挡。 */
  deliverNow: (id: string) => Promise<DeliverNowResult>;
  memory: Pick<MemoryService, "view" | "why">;
  /** 对话另存（UI 重做第 4 层）：只读。 */
  conv: Pick<ConversationStore, "list" | "search">;
  /** 对话 tab 的分叉讨论（UI 重做第 5 层）。 */
  fork: Pick<ForkService, "ask" | "reaskFull" | "list" | "sendConclusion" | "remember">;
  /** 对话 tab 的输入框选「开发 session」时发进去（和送结论同一个 DevSender）。 */
  devSend: Pick<DevSender, "send">;
  /** 启动健康检查（healthReady）：分叉要用的 claude 路径和 shipherd-hook 在它之后才知道。 */
  forkReady: () => Promise<void>;
  autostart: { get(): AutostartState; set(on: boolean): AutostartState };
  /** 防休眠开关（只在内存里，启动时是关的）。 */
  keepAwake: { isOn(): boolean; set(on: boolean): void };
  /** 更新提示（BTL-253）。 */
  update: { view(): UpdateView; checkNow(): Promise<UpdateCheckResult>; skip(version: string): void; dismiss(version: string): void; openRelease(): void };
  /** followup 状态变化后重新推导 ticket 状态。 */
  rederive: (ticketKey: string) => void;
  /** 关掉 / 重新打开 ticket（tickets/ticket-close.ts，BTL-270）。来源记成 user。 */
  ticketClose?: {
    close(key: string, o: CloseOptions): Promise<CloseResult>;
    reopen(key: string, source: "user"): ReopenResult;
    retry(key: string, o: RetryCloseOptions): Promise<RetryCloseResult>;
    setStatus(key: string, status: Exclude<ManualTicketStatus, "closed"> | null, source: "user"): SetStatusResult;
    /** 关闭框里列的开着的 PR：能关的、关不了的和原因。 */
    preview(key: string): Promise<ClosePreview | null>;
  };
  detectTrackerTools: () => Promise<McpProbe>;
  /** 设置 › 功能：三张策略表各读一次（UI 重做第 6 层）。 */
  featurePolicy: () => FeaturePolicyState;
  /** 自动化档位（BTL-247）：设置页的显示、套用全局预设、epic 自己选的档位。 */
  automation: {
    state(): AutomationState;
    apply(level: AutomationLevel): void;
    setFeatureLevel(featureId: number, level: AutomationLevel | null): void;
  };
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
  // 计时的是 handler 同步跑的那一段（BTL-242）：它占着主进程的事件循环；异步等待（headless claude 等）不算。
  // 写操作（不是只读通道）调之前和调完都作废视图缓存（BTL-242）：handler 里先写后读、或者写了没 notify 的，都不会读到旧的。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, fn: (...args: any[]) => unknown) => {
    const write = !isReadChannel(channel);
    ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
      if (write) d.onWrite?.();
      try {
        return await meteredIpcResult(channel, args, () => {
          const t0 = performance.now();
          try {
            return fn(...args);
          } finally {
            d.diag?.invoke(channel, performance.now() - t0);
          }
        }, d.onInvoked);
      } finally {
        if (write) d.onWrite?.();
      }
    });
  };

  const setFollowupStatus = (id: string, status: FollowupStatus) => {
    if (!(FOLLOWUP_STATUSES as readonly string[]).includes(status)) throw new Error(`unknown followup status: ${String(status)}`);
    const f = d.followups.get(id);
    if (!f) throw new TicketError("not_found", M().followupNotFound);
    const now = d.now();
    d.followups.setStatus(id, status, now, status === "snoozed" ? addDays(localDate(now), 1) : null);
    d.rederive(f.ticketKey);
  };

  handle(IPC.ticketsList, () => (d.views ? d.views.tickets() : d.sessionService.ticketViews()));
  handle(IPC.ticketsCreate, async (raw: unknown) => {
    const t = await d.ticketService.create(createTicketArg(raw));
    d.notify();
    return t;
  });
  handle(IPC.ticketsSetStatus, (key: string, status: TicketStatus | null) => {
    // closed 要原因、要忽略后续事项，走 ticketsClose；needs_decision 只能自动得出。
    if (status === "closed" || status === "needs_decision") throw new TicketError("invalid_status", M().ticketStatusNotManual);
    // 和总控的 set_ticket_status 同一个函数：从「已关闭」换成别的，先撤销关闭（关闭时忽略的后续事项还原）。
    if (d.ticketClose) {
      if (!d.ticketClose.setStatus(key, status, "user").ok) throw new TicketError("not_found", M().ctlNoTicket(key));
      return;
    }
    d.tickets.setStatusManual(key, status, d.now());
    d.notify();
  });
  handle(IPC.ticketsClose, async (rawKey: unknown, raw: unknown) => {
    const key = ticketKeyArg(rawKey);
    if (!d.ticketClose) throw new TicketError("not_found", M().ticketCloseUnavailable);
    const o = closeTicketArg(raw);
    const r = await d.ticketClose.close(key, { ...o, source: "user" });
    if (!r.ok) {
      if (r.error === "no_ticket") throw new TicketError("not_found", M().ctlNoTicket(key));
      if (r.error === "already_closed") throw new TicketError("invalid_status", M().ticketAlreadyClosed(key));
      throw new TicketError("invalid_reason", M().ticketCloseNeedsReason);
    }
    return r;
  });
  handle(IPC.ticketsClosePreview, async (rawKey: unknown) => {
    const key = ticketKeyArg(rawKey);
    if (!d.ticketClose) throw new TicketError("not_found", M().ticketCloseUnavailable);
    const r = await d.ticketClose.preview(key);
    if (!r) throw new TicketError("not_found", M().ctlNoTicket(key));
    return r;
  });
  handle(IPC.ticketsCloseRetry, async (rawKey: unknown, raw: unknown) => {
    const key = ticketKeyArg(rawKey);
    if (!d.ticketClose) throw new TicketError("not_found", M().ticketCloseUnavailable);
    const r = await d.ticketClose.retry(key, { ...closeRetryArg(raw), source: "user" });
    if (!r.ok) throw new TicketError("not_found", r.error === "no_ticket" ? M().ctlNoTicket(key) : M().ctlTicketNotClosed(key));
    return r;
  });
  handle(IPC.ticketsReopen, (rawKey: unknown) => {
    const key = ticketKeyArg(rawKey);
    if (!d.ticketClose) throw new TicketError("not_found", M().ticketCloseUnavailable);
    const r = d.ticketClose.reopen(key, "user");
    if (!r.ok) throw new TicketError("not_found", r.error === "no_ticket" ? M().ctlNoTicket(key) : M().ctlTicketNotClosed(key));
    return r;
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
  handle(IPC.featuresList, () => (d.views ? d.views.features() : d.sessionService.featureViews()));
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
  handle(IPC.featuresArchive, (raw: unknown) => {
    const id = featureIdArg(raw);
    d.featureService.archive(id, { terminalsOpen: () => d.sessionService.hasFeatureTerminal(id) });
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
  // 自动化档位（BTL-247）
  handle(IPC.automationState, (): AutomationState => d.automation.state());
  handle(IPC.featuresSetAutomationLevel, (id: unknown, level: unknown) => {
    d.automation.setFeatureLevel(featureIdArg(id), automationLevelArg(level));
    d.notify();
  });
  handle(IPC.shipherdView, () => d.sessionService.shipherdView());
  handle(IPC.messagesList, (raw: unknown): MessageView[] => d.messages(messageScopeArg(raw)));
  handle(IPC.messagesDeliverNow, async (raw: unknown): Promise<DeliverNowResult> => {
    const r = await d.deliverNow(messageIdArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.metricsView, (raw: unknown): MetricsOverview => d.metrics(typeof raw === "number" ? raw : undefined));
  handle(IPC.shipherdOpenSession, async (raw: unknown) => {
    const r = await d.sessionService.openShipherd(openShipherdArg(raw));
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
  handle(IPC.sessionsUnclaimedCount, (): number => d.sessionService.unclaimedCount());
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

  // 取快照就是挂上这个终端（BTL-242）：之后它的输出才发过来；先挂再取，快照之后的数据一条不漏。攒着的输出先发（BTL-277）。
  handle(IPC.ptySnapshot, (id: string) => attachSnapshot(d, id));
  // 挂回摘下过的终端：同样先挂再取，mark 之后的数据一条不漏。补不上时回整份快照（reset：渲染进程先清屏再写）。
  handle(IPC.ptySince, (id: string, mark: unknown) => attachSince(d, id, mark));
  ipcMain.on(IPC.ptyDetach, (_e, id: unknown) => {
    if (typeof id === "string") d.ptySubs?.detach(id);
  });
  handle(IPC.ptyKill, (id: string) => {
    if (d.pty.isOpen(id)) d.userEnded?.(id);
    d.pty.kill(id);
  });
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => {
    d.pty.write(id, data);
    d.terminalInput?.(id);
    if (typeof id === "string" && typeof data === "string") d.terminalKeys?.(id, data);
  });
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => d.pty.resize(id, cols, rows));
  ipcMain.on(IPC.diagRenderer, (_e, report: unknown) => d.diag?.report(report));
  handle(IPC.diagSnapshot, (reset: unknown) => d.diag?.snapshot(reset === true) ?? null);
  handle(IPC.diagExport, () => d.diag?.export() ?? null);
  handle(IPC.feedbackOpen, (r: unknown) => {
    if (!d.feedback) throw new Error("feedback unavailable");
    return d.feedback.open(feedbackOpenArg(r));
  });
  handle(IPC.feedbackDiagPreview, () => {
    if (!d.feedback) throw new Error("feedback unavailable");
    return d.feedback.previewDiagnostics();
  });
  handle(IPC.infoflowList, (raw: unknown): FlowItemView[] => d.infoflow?.list(flowScopeArg(raw)) ?? []);
  handle(IPC.infoflowTurn, (raw: unknown): FlowTurnText => {
    const id = flowIdArg(raw);
    return d.infoflow?.turnText(id) ?? { turnId: id, messages: [] };
  });
  handle(IPC.infoflowAct, async (rawId: unknown, rawWhat: unknown): Promise<boolean> => {
    if (!d.infoflow) return false;
    const ok = await d.infoflow.act(flowIdArg(rawId), flowActArg(rawWhat));
    d.notify();
    return ok;
  });
  handle(IPC.feedbackDiagSave, () => {
    if (!d.feedback) throw new Error("feedback unavailable");
    return d.feedback.saveDiagnostics();
  });
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
  handle(IPC.prWatchList, (raw: unknown): WatchedPr[] => d.prWatchList(raw));
  handle(IPC.prStages, (raw: unknown): PrStagesTicket[] => d.prStages.view(prStagesScopeArg(raw)));
  handle(IPC.prOpen, (raw: unknown): PrOpenResult => d.prOpen(prUrlArg(raw)));
  handle(IPC.linkOpen, (raw: unknown): LinkOpenResult => d.linkOpen(linkUrlArg(raw)));
  // 仓库身份先在后台查好（BTL-275），state() 里不再同步起 git。
  handle(IPC.lessonsState, async (): Promise<LessonsState> => {
    await d.lessons.warm();
    return d.lessons.state();
  });
  handle(IPC.lessonsAct, (raw: unknown) => d.lessons.act(lessonActionArg(raw)));
  handle(IPC.lessonsRuns, (raw: unknown): LessonQueueRowView[] => d.lessons.runs(lessonSlugArg(raw)));
  handle(IPC.lessonsRun, (raw: unknown): LessonRunDetail | null => d.lessons.run(lessonRunIdArg(raw)));
  handle(IPC.lessonsPending, (): number => d.lessons.pendingCount());
  handle(IPC.lessonsBatches, (raw: unknown): BatchView[] => d.batches.list(batchListArg(raw)));
  handle(IPC.lessonsBatch, (raw: unknown): BatchDetail | null => d.batches.get(batchIdArg(raw)));
  handle(IPC.admissionState, (): AdmissionPageState => d.admission.state());
  handle(IPC.wizardEstimate, (raw: unknown): Promise<WizardEstimate> => d.admission.estimate(admissionScopeArg(raw)));
  handle(IPC.wizardAct, async (raw: unknown): Promise<WizardActResult> => {
    const r = await d.admission.wizardAct(wizardActionArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.calibrationSample, (raw: unknown): CalibrationSample => d.admission.calibrationSample(admissionScopeArg(raw)));
  handle(IPC.calibrationStats, (raw: unknown): CalibrationStatsView => d.admission.calibrationStats(calibrationSinceArg(raw)));
  handle(IPC.calibrationAct, (raw: unknown): CalibrationActResult => {
    const r = d.admission.calibrationAct(calibrationActionArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.principlesRegroup, async (): Promise<RegroupResult> => {
    const r = await d.admission.regroupPrinciples();
    d.notify();
    return r;
  });
  handle(IPC.policiesGet, (raw: unknown): AdmissionPolicyView => d.policies.view(policyScopeArg(raw)));
  handle(IPC.policiesSet, (raw: unknown) => {
    const { scope, overrides } = policySetArg(raw);
    const r = d.policies.setLayer(scope, overrides);
    d.notify();
    return r;
  });
  handle(IPC.loopPolicyGet, (raw: unknown): LoopPolicyView => d.loop.policyView(policyScopeArg(raw)));
  handle(IPC.loopPolicySet, (raw: unknown): void => {
    const { scope, overrides } = loopSetArg(raw);
    d.loop.policySet(scope, overrides);
    d.notify();
  });
  handle(IPC.loopCommentsList, (raw: unknown): PrCommentsView[] => d.loop.comments(ticketKeyArg(raw)));
  handle(IPC.loopCommentsAct, async (raw: unknown): Promise<CommentItemView | null> => {
    const r = await d.loop.act(commentActionArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.stacksList, (raw: unknown): Promise<StacksView> => d.stacks.view(stacksFilterArg(raw)));
  handle(IPC.stacksRebase, async (raw: unknown): Promise<StackActionResult> => {
    const r = await d.stacks.rebaseNow(stackIdArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.stacksLayerMode, async (raw: unknown): Promise<StackActionResult> => {
    const { layerId, mode } = stackLayerModeArg(raw);
    const r = await d.stacks.setLayerMode(layerId, mode);
    d.notify();
    return r;
  });
  handle(IPC.stacksRestore, async (raw: unknown): Promise<StackActionResult> => {
    const r = await d.stacks.restore(stackIdArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.stacksRemove, (raw: unknown): StackActionResult => {
    const r = d.stacks.remove(stackIdArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.stacksPolicyGet, (raw: unknown): StackPolicyView => d.stacks.policyView(policyScopeArg(raw)));
  handle(IPC.stacksPolicySet, (raw: unknown): StackPolicySetResult => {
    const { scope, overrides } = stackPolicySetArg(raw);
    const r = d.stacks.policySet(scope, overrides);
    if (r.ok) d.notify();
    return r;
  });
  handle(IPC.stacksPolicyLayers, (): StackPolicyLayer[] => d.stacks.policyLayers());
  handle(IPC.loopFlakyList, (): FlakyEntry[] => d.loop.flaky());
  handle(IPC.loopFlakyAct, (raw: unknown): boolean => {
    const r = d.loop.flakyAct(flakyActionArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.loopEffect, (raw: unknown): LoopEffect => d.loop.effect(raw));
  handle(IPC.interruptsState, (): InterruptsState => d.interrupts.state());
  handle(IPC.interruptsAct, async (raw: unknown): Promise<InterruptsActResult> => {
    const r = await d.interrupts.act(interruptsActionArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.profilesGet, (): ProfileScan => d.interrupts.profiles());
  handle(IPC.profilesScan, (raw: unknown): Promise<ProfileScan> => d.interrupts.scan(!!(raw && typeof raw === "object" && (raw as { explain?: unknown }).explain === true)));
  handle(IPC.prAssessment, (raw: unknown): TicketAssessmentView => d.review.ticket(ticketKeyArg(raw)));
  handle(IPC.preReviewRun, (raw: unknown): ReviewActResult => {
    const r = d.review.run(prIdArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.briefRegenerate, async (raw: unknown): Promise<ReviewActResult> => {
    const r = await d.review.regenerate(prIdArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.briefPost, async (raw: unknown): Promise<ReviewActResult> => {
    const r = await d.review.post(prIdArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.prPolicyGet, (raw: unknown): PrPolicyView => d.review.policyView(policyScopeArg(raw)));
  handle(IPC.prPolicySet, (raw: unknown): void => {
    const { scope, overrides } = prPolicySetArg(raw);
    d.review.policySet(scope, overrides);
    d.notify();
  });
  handle(IPC.reviewEffect, (raw: unknown): ReviewEffectView => d.review.effect(raw));
  handle(IPC.reviewQueue, (): ReviewQueueItem[] => d.review.queue());
  handle(IPC.preReviewStatus, (raw: unknown): PreReviewStatusBatch => d.review.preReviewStatus(preReviewStatusArg(raw)));
  handle(IPC.preReviewQueue, (): PreReviewQueueView => d.review.preReviewQueue());
  // 和 review:run 一样：动完通知界面（队列的 onChange 也会通知，这里保证改顺序这种不经过队列状态变化的也刷新）。
  handle(IPC.preReviewQueueAct, (raw: unknown): PreReviewQueueActResult => {
    const r = d.review.preReviewQueueAct(preReviewQueueActionArg(raw));
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
  handle(IPC.baselinesView, (): BaselinesView => d.baselines.view());
  handle(IPC.baselinesAct, (raw: unknown): BaselinesActResult => {
    const r = d.baselines.act(baselinesActionArg(raw));
    if (r.ok) d.notify();
    return r;
  });
  handle(IPC.baselinesRules, (raw: unknown): RuleRowView[] => d.baselines.rulesView(checkScopeArg(raw)));
  handle(IPC.baselinesSummary, (raw: unknown): BaselineSummary => d.baselines.summary(checkScopeArg(raw)));
  handle(IPC.legacyView, (): LegacyScanView[] => d.legacy.views());
  handle(IPC.legacyAct, (raw: unknown): { ok: true } | { ok: false; message: string } => {
    const a = legacyActionArg(raw);
    if (a.kind === "cancel") return d.legacy.cancel(a.scanId) ? { ok: true } : { ok: false, message: "not running" };
    const r = d.legacy.start(a.checkId, a.slug);
    if (r.ok) d.notify();
    return r;
  });
  handle(IPC.legacyViolations, (raw: unknown): LegacyViolation[] => {
    const q = legacyViolationsArg(raw);
    return d.legacy.violations(q.scanId, q.offset, q.limit);
  });
  handle(IPC.backtestView, (): BacktestView => d.backtest.view());
  handle(IPC.backtestAct, (raw: unknown): BacktestActResult => {
    const r = d.backtest.act(backtestActionArg(raw));
    if (r.ok) d.notify();
    return r;
  });
  handle(IPC.intakeView, (): IntakeView => d.intake.view());
  handle(IPC.intakeEffect, (raw: unknown): IntakeEffect => d.intake.effect(typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 365 ? raw : 30));
  handle(IPC.intakePolicyGet, (raw: unknown): IntakePolicyView => d.intake.policyView(policyScopeArg(raw)));
  handle(IPC.intakePolicySet, (raw: unknown): IntakePolicySetResult => {
    const { scope, overrides } = intakePolicySetArg(raw);
    const r = d.intake.policySet(scope, overrides);
    if (r.ok) d.notify();
    return r;
  });
  handle(IPC.intakeClassify, async (raw: unknown): Promise<IntakeActResult> => {
    const r = await d.intake.classify(intakeClassifyArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.intakePoll, async (): Promise<IntakeActResult> => {
    const r = await d.intake.poll();
    d.notify();
    return r;
  });
  handle(IPC.intakeAct, async (raw: unknown): Promise<IntakeActResult> => {
    const r = await d.intake.act(intakeActionArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.checkExportList, (): CheckExportView[] => d.checkExports.list());
  handle(IPC.checkExportAct, async (raw: unknown): Promise<CheckExportResult> => {
    const r = await d.checkExports.act(checkExportActionArg(raw));
    d.notify();
    return r;
  });
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
  handle(IPC.costBreakers, (): CostBreakerView[] => d.cost.breakers());
  handle(IPC.costView, (raw: unknown): CostView => d.cost.view(policyScopeArg(raw)));
  handle(IPC.costSet, (raw: unknown): CostSetResult => {
    const { scope, overrides } = costSetArg(raw);
    const r = d.cost.set(scope, overrides);
    d.notify();
    return r;
  });
  handle(IPC.costResume, async (raw: unknown): Promise<CostResumeResult> => {
    const { subjectKind, subjectId } = costSubjectArg(raw);
    const r = await d.cost.resume(subjectKind, subjectId);
    d.notify();
    return r;
  });
  handle(IPC.backgroundStatus, (): BackgroundStatusView => d.background.status());
  handle(IPC.backgroundAct, (raw: unknown): void => {
    d.background.act(backgroundActionArg(raw));
    d.notify();
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
  handle(IPC.ticketsGlance, (raw: unknown): TicketGlance => d.ticketGlance(ticketKeyArg(raw)));
  handle(IPC.turnBoard, (raw: unknown): TurnBoard => d.turnBoard(turnFilterArg(raw)));
  handle(IPC.turnSendToAgent, (raw: unknown) => d.turnSendToAgent(turnSendArg(raw)));
  handle(IPC.turnHomeOpened, (): void => d.turnHomeOpened());
  // 答了由 InboxService 自己 notify。
  handle(IPC.inboxList, (raw: unknown): InboxView => d.inbox.view(inboxScopeArg(raw)));
  handle(IPC.inboxAnswer, (id: unknown, text: unknown): boolean => d.inbox.answer(inboxIdArg(id), inboxAnswerArg(text)));
  handle(IPC.inboxBehalf, (v: unknown): boolean => {
    const a = inboxBehalfArg(v);
    return a.op === "correct" ? d.inbox.correctBehalf(a.id, a.text) : d.inbox.dismissBehalf(a.id);
  });
  handle(IPC.inboxReports, (scope: unknown, o: unknown) => d.inbox.reportsPage(inboxScopeArg(scope), reportsPageArg(o)));

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

  const settingsIpc = settingsHandlers({
    ...d,
    applyAutomationLevel: (level) => {
      if (isAutomationLevel(level)) d.automation.apply(level);
    },
  });
  handle(IPC.settingsGet, settingsIpc.get);
  handle(IPC.settingsSet, settingsIpc.set);
  handle(IPC.settingsReset, settingsIpc.reset);
  handle(IPC.settingsDetectTrackerTools, () => d.detectTrackerTools());
  // 设置 › 功能：只改全局那一层的一个功能开关，同层其他覆盖原样保留。
  const featureIpc = featurePolicyHandlers({
    read: () => d.featurePolicy(),
    ...featurePolicyLayers(d),
    notify: () => d.notify(),
  });
  handle(IPC.settingsFeaturePolicy, (): FeaturePolicyState => featureIpc.get());
  handle(IPC.settingsPolicyPatch, (raw: unknown): void => featureIpc.patch(raw));

  handle(IPC.externalAuditList, (): ExternalActionEntry[] => d.externalAudit.list({ limit: 200 }));

  // StateCore 记忆（设计文档 8.4）：只读。
  const mem = memoryHandlers({ tickets: d.tickets, memory: d.memory, enabled: () => memoryOn(d.settings) });
  handle(IPC.memoryView, mem.view);
  handle(IPC.memoryWhy, mem.why);
  // 对话另存（UI 重做第 4 层）：只读。
  const cv = convHandlers({ conv: d.conv });
  handle(IPC.convList, cv.list);
  handle(IPC.convSearch, cv.search);
  // 对话 tab（UI 重做第 5 层）：分叉讨论、送结论、发给开发 session。
  const fk = forkHandlers({ fork: d.fork, devSend: d.devSend, ready: d.forkReady });
  handle(IPC.forkAsk, fk.ask);
  handle(IPC.forkSendConclusion, fk.sendConclusion);
  handle(IPC.forkReaskFull, fk.reaskFull);
  handle(IPC.forkList, fk.list);
  handle(IPC.forkRemember, fk.remember);
  handle(IPC.convSend, fk.convSend);
  // 内存历史（WS-M A）：最近 hours 小时（1 到 336），默认 24。
  handle(IPC.memUsageHistory, (hours: unknown): MemoryHistoryPoint[] => {
    const h = typeof hours === "number" && Number.isFinite(hours) ? Math.min(336, Math.max(1, hours)) : 24;
    return d.memoryHistory?.(d.now() - h * 3600_000) ?? [];
  });

  handle(IPC.appAutostartGet, () => d.autostart.get());
  handle(IPC.appLanguage, () => currentLang());
  handle(IPC.appAutostartSet, (on: unknown) => d.autostart.set(boolArg(on)));
  handle(IPC.appKeepAwakeGet, () => d.keepAwake.isOn());
  // 更新提示（BTL-253）：只读的状态和手动检查；release 页只开缓存里那一条（openRelease 自己查链接）。
  handle(IPC.updateState, () => d.update.view());
  handle(IPC.updateCheck, () => d.update.checkNow());
  handle(IPC.updateSkip, (v: unknown) => d.update.skip(versionArg(v)));
  handle(IPC.updateDismiss, (v: unknown) => d.update.dismiss(versionArg(v)));
  handle(IPC.updateOpenRelease, () => d.update.openRelease());
  handle(IPC.appKeepAwakeSet, (on: unknown) => {
    d.keepAwake.set(boolArg(on));
    return d.keepAwake.isOn();
  });
}
