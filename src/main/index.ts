import { METRICS_DAYS_DEFAULT, type MetricsOverview } from "../shared/metrics";
import { execFile } from "node:child_process";
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, powerMonitor, powerSaveBlocker, shell, Tray } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { cpus, freemem, homedir, release as osRelease, tmpdir, totalmem, userInfo } from "node:os";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { DiagService } from "./diag/diag-service";
import { RELOAD_WINDOW_MS, RendererHealth } from "./diag/renderer-health";
import { collectRedactTerms } from "./diag/redact";
import { FeedbackService, osName } from "./feedback/feedback-service";
import { Invalidator } from "./diag/invalidator";
import { PtySubscriptions } from "./sessions/pty-subscriptions";
import { OutputBatcher } from "./sessions/output-batcher";
import { ViewCache } from "./diag/view-cache";
import { throttle } from "./diag/throttle";
import { isStateScope, type StateChangedPayload } from "../shared/state-scope";
import { diagMode, perfOp, perfParts } from "./diag/perf-stats";
import { ReadScope } from "./perf/read-scope";
import { SCOPE_INVALIDATES, VIEW_KEYS } from "./diag/view-scopes";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeTask, taskMessage } from "../shared/control";
import { parseGateRequest, type GateRequest, type GateResult } from "../shared/gate";
import { IPC } from "../shared/ipc";
import type { LimitHit } from "../shared/availability";
import { ClaudeAvailability } from "./claude/availability";
import { buildNotices, ciNotices, collectNotices, commentNotices, costNotices, intakeNotices, stackNotices } from "./now/notices";
import { BackgroundRepo } from "./db/background-repo";
import { CostRepo } from "./db/cost-repo";
import { readBgSettings } from "./background/bg-settings";
import { electronIdleSignal } from "./background/idle";
import { BackgroundQueue } from "./background/queue";
import { routingQuota } from "./background/routing-quota";
import { BackgroundScheduler } from "./background/scheduler";
import { CostBreaker, type CostSessionInfo } from "./cost/cost-breaker";
import { CostPolicyService } from "./cost/cost-policy";
import { backgroundMetricEvents, costMetricEvents } from "./cost/metric-events";
import { parseThresholds } from "./routing/spend";
import { CostPolicyError, type CostBreakerView } from "../shared/cost";
import type { NowNotice, NowTarget } from "../shared/types";
import { AvailabilityRepo } from "./db/availability-repo";
import type { Session, TicketCloseSource, TicketRepo, WatchedPr } from "../shared/types";
import { effectiveStatus } from "../shared/types";
import { StackPolicyError } from "../shared/stacks";
import { APP_ID, shouldSetAppId } from "./app-id";
import { runHeadless } from "./claude/headless";
import { probeMcpTools } from "./claude/mcp-probe";
import { projectMcpApprovalSettings, projectMcpConfigs } from "./claude/project-mcp";
import { MAILBOX_EVENT, mailboxHookCommand } from "../shared/mailbox";
import { headlessEnv } from "./claude/spawn";
import { DatabaseBackupError, openDatabase, startupErrorText, withTransaction } from "./db/database";
import { FollowupsRepo } from "./db/followups-repo";
import { HandoffsRepo } from "./db/handoffs-repo";
import { JobsRepo } from "./db/jobs-repo";
import { MemorySyncRepo } from "./db/memory-sync-repo";
import { MergeGateRepo } from "./db/merge-gate-repo";
import { PrStageRepo } from "./db/pr-stage-repo";
import { BranchOwnersRepo } from "./db/branch-owners-repo";
import { BranchWatchRepo } from "./db/branch-watch-repo";
import { linkedOpen as anyLinkedOpen, prGivenUp, TicketPrsRepo } from "./db/ticket-prs-repo";
import { SecretsRepo } from "./db/secrets-repo";
import { SessionsRepo } from "./db/sessions-repo";
import { SettingsRepo } from "./db/settings-repo";
import { TicketsRepo } from "./db/tickets-repo";
import { UsageRepo } from "./db/usage-repo";
import { execHeadlessJson } from "./handoff/headless-exec";
import { headlessUsageRow } from "./usage/headless-usage";
import { UsageScanner, usageScanMs } from "./usage/usage-scanner";
import { TranscriptHub } from "./sessions/transcript-hub";
import { HoldWatcher } from "./gate/hold-watcher";
import { HOLD_CHECK_MS, locateRepo, MergeGate } from "./gate/merge-gate";
import { BranchOwnership } from "./prwatch/branch-owners";
import { CiDelivery, ciRecipient, type RecipientCtx } from "./prwatch/ci-delivery";
import { prHandoff } from "./prwatch/pr-handoff";
import { runPrBackfill } from "./prwatch/pr-backfill";
import { ensureSkillTrackingSince, skillTrackingSince } from "./prwatch/skill-tracking";
import { PrLinker } from "./prwatch/pr-links";
import { PrWatcher } from "./prwatch/pr-watcher";
import { makeWhoOf } from "./gate/who";
import { autostartState } from "./autostart";
import { electronSecretBox } from "./notify/secret-box";
import { sendWebhook } from "./notify/webhook";
import { auditCutoff } from "./external/retention";
import { captureCommandHandoff, stopFromEnvelope } from "./handoff/capture";
import { handoffCommandPath, handoffCommandUsable } from "./handoff/command";
import { ingestFeatureHandoff, type FeatureIngestInput } from "./handoff/feature-ingest";
import { featureCommandFollowup, FeatureSummaryRunner } from "./handoff/feature-runner";
import { ingestHandoff, rederiveTicketStatus, type IngestInput } from "./handoff/ingest";
import { cleanupIfMerged } from "./tickets/worktree-cleanup";
import { FeatureHandoffsRepo } from "./db/feature-handoffs-repo";
import { SessionMessagesRepo, type SessionMessage } from "./db/session-messages-repo";
import { Mailbox, MAILBOX_BODY_LIMIT, type AwaitingUser } from "./mailbox/mailbox";
import { broadcastConvention } from "./mailbox/broadcast";
import { sessionName } from "./mailbox/names";
import { hasSessionMail as sessionMailWakes, headsWithWakingMail } from "./mailbox/wake";
import { ExternalAuditRepo } from "./db/external-audit-repo";
import { ExternalActions } from "./external/actions";
import { buildProgress } from "./progress/progress-view";
import type { ProgressFilter, ProgressView } from "../shared/progress";
import type { Turn } from "../shared/turn";
import { BlocksRepo } from "./db/blocks-repo";
import { EpicArchiveRepo } from "./db/epic-archive-repo";
import { FeaturesRepo } from "./db/features-repo";
import { currentLang, onLangChange, setLang } from "./i18n";
import { pruneSessionGuides, writeSessionGuide } from "./claude/session-guide";
import { planForSlug, safeGuidePlan } from "./lessons/select";
import { lookupLessons } from "./lessons/lookup";
import { LessonMergeService, type MergeLayer } from "./lessons/merge";
import { dripManifest, dripRoots, prepareSessionDrip, pruneDrip } from "./lessons/drip";
import { LessonUpkeep } from "./lessons/upkeep";
import { lessonsHookCommand, lessonsResetCommand } from "../shared/lesson-drip";
import { resolveLang } from "../shared/i18n";
import { FeatureService } from "./tickets/feature-service";
import { ticketGlance } from "./tickets/ticket-glance";
import { HandoffRunner } from "./handoff/runner";
import { hookCommand } from "./hooks/installer";
import { HealthService } from "./hooks/health";
import { applyHookEnvelope } from "./hooks/hook-events";
import { createFileLogger, type Logger } from "./logger";
import { hubRoutes, memoryServers, pruneTerminalMcpConfigs, writeForkMcpConfig, removeFeatureMcpConfig, removeTerminalMcpConfig, removeTicketMcpConfigs, SESSIONS_AUTO_ALLOW, sessionsServer, type StdioServerSpec, writeShipherdMcpConfig, writeFeatureMcpConfig, writeTerminalMcpConfig, writeTicketMcpConfig } from "./memory/mcp-config";
import { McpHub, spawnHub } from "./memory/mcp-hub";
import { MemoryService } from "./memory/memory-service";
import { admitOrRefuse } from "./control/admission";
import { controlHandler } from "./control/control-handler";
import { ControlInbox } from "./control/control-inbox";
import { HookInbox } from "./hooks/inbox";
import { stageEventFromHook } from "./hooks/stage-hook";
import { InboxRepo } from "./db/inbox-repo";
import { PrStagesService } from "./prwatch/pr-stages-service";
import { InboxService } from "./inbox/inbox-service";
import { MetricsRepo } from "./db/metrics-repo";
import { Metrics, type RecordEvent } from "./metrics/events";
import { AutoChoicesRepo, ChoiceDefaultsRepo, NotificationLogRepo, PermissionProfileRepo } from "./db/interrupts-repo";
import { ChoiceService } from "./interrupts/choices";
import { InterruptsFacade } from "./interrupts/facade";
import { interruptGuideLines } from "./interrupts/guide";
import { Notifier, notifyFromMetric } from "./notify/notifier";
import { WebhookStore } from "./notify/webhook-store";
import { ProfileHitCounter } from "./permissions/hits";
import { PermissionProfileService } from "./permissions/profile-service";
import { classifyQuestion, InterruptRecorder } from "./metrics/interrupts";
import { isDialogKey, promptOnTerminalChain, questionToolShowing, recordInvoke, TerminalInputMeter } from "./metrics/interventions";
import { MetricsGhJob } from "./metrics/gh-job";
import { buildOverview, clampDays, compareFromDay, overviewFromDay } from "./metrics/overview";
import { MetricsRollup } from "./metrics/rollup";
import { baselineCutoffOf, ensureMetricsSince, metricsSince } from "./metrics/since";
import { TOUCH_MS as WAIT_TOUCH_MS, WaitTracker, type WaitHead } from "./metrics/wait-tracker";
import { registerIpc } from "./ipc/register";
import { prWatchListHandler } from "./ipc/prwatch-handlers";
import { readFeaturePolicy, readGovernedLayers } from "./settings/feature-policy";
import { AutomationLevels } from "./automation/levels";
import { featurePolicyLayers, type FeaturePolicyDeps } from "./ipc/feature-policy-handlers";
import type { EditableSettingKey } from "../shared/settings";
import type { LoopPolicyOverrides, LoopScope } from "../shared/loop-policy";
import type { PolicyScope } from "../shared/admission-policy";
import type { StackPolicySetResult } from "../shared/stacks";
import type { IntakePolicySetResult } from "../shared/intake";
import { ensureDirs, refreshTailPath, resolvePaths } from "./paths";
import { finishLegacyHome } from "./migrate/legacy-finish";
import { migrateLegacyHome } from "./migrate/legacy-home";
import { legacyButlerHolder, legacyUserDataDir } from "./migrate/legacy-user-data";
import { envValue } from "../shared/legacy-env";
import { isWorkingDay, localDate } from "./schedule/calendar";
import { morningJob, nightlyJob, type DailyJobDeps } from "./schedule/daily-jobs";
import { PatrolTurns } from "./schedule/patrol-turns";
import { ShipherdPatrol } from "./schedule/shipherd-patrol";
import { Scheduler, TICK_MS, type ScheduleTrigger } from "./schedule/scheduler";
import { AdmissionPolicyService } from "./lessons/admission-policies";
import { ConfigIoService, defaultRegistry } from "./config-io";
import { ConfigBackups } from "./config-io/backup-job";
import { configIoFacade, defaultSavePath } from "./config-io/facade";
import { ActivityMonitor, activityIntervals } from "./sessions/activity-monitor";
import { sessionRegistryName } from "./sessions/activity-sources";
import { DeliveryGuard, USER_TYPING_QUIET_MS, type DeliveryGuardDeps } from "./sessions/delivery-guard";
import { writeRefreshTail } from "./sessions/refresh-tail";
import { ConvRepo } from "./db/conv-repo";
import { ConvIngester } from "./conversation/conv-ingester";
import { judgeConvQa } from "./conversation/conv-qa";
import { InfoflowRepo } from "./db/infoflow-repo";
import { extractTurn } from "./infoflow/extract";
import { InfoflowService } from "./infoflow/infoflow-service";
import { infoflowLookups, infoflowTicketActions } from "./infoflow/wiring";
import { ConversationStore, RECENT_QA_CHARS, withRecentQa } from "./conversation/conversation-store";
import { ForkDiscussionsRepo } from "./db/fork-discussions-repo";
import { DevSender } from "./fork/dev-send";
import type { DevLaunch } from "./fork/fork-args";
import { FULL_FORK } from "./fork/fork-cache";
import { ForkService, writeForkSettings } from "./fork/fork-service";
import { transcriptCostBase } from "./fork/cost-base";
import { autoRefreshNeedsYou, refreshKindOf, SessionRefresher, startRefresh } from "./sessions/session-refresher";
import { SessionCleanup, working } from "./sessions/session-cleanup";
import { Hibernator } from "./sessions/hibernator";
import { Resumer, controllerMailSince, restartOrder, resumable, wakeStateFor } from "./sessions/resumer";
import { childrenWorking } from "./sessions/managed-by";
import { needsDiscovery, scanClaudeProjects, syncDiscovered, TranscriptLocator, UNCLAIMED_WINDOW_MS, type HeadCache } from "./sessions/discovery";
import { fillBranchFromCwd, outsideSessionsOn } from "./sessions/outside-sessions";
import { defaultReadDeps, memorySnapshotLine, readAvailableMemory } from "./sessions/available-memory";
import { measuredOpenSessionsKb, MemoryAdmission } from "./sessions/memory-admission";
import { PtyManager } from "./sessions/pty-manager";
import { execText } from "./util/exec";
import { nodePtyFactory } from "./sessions/pty-node";
import { SessionService } from "./sessions/session-service";
import { judgeStuck } from "./sessions/stuck-judge";
import { markTurnEndedWithoutStop, onTurnEndedWithoutStop } from "./sessions/turn-end";
import { HealedTurns, IdleEvidence } from "./sessions/idle-evidence";
import { isControllerOf } from "./mailbox/controller";
import { deliveryNeedsYou, judgeNeedsYou, NeedsYouTracker, type NeedsYouHead } from "./sessions/needs-you";
import { buildNowView } from "./now/now-view";
import { TurnService } from "./turn/turn-service";
import { turnCoordinators as turnCoordinatorsOf } from "./turn/coordinators";
import { ReviewRequestsRepo } from "./db/review-requests-repo";
import { REVIEW_AWAY_IDLE_SECONDS, ReviewRequestPoller, bindFocusCatchUp } from "./prwatch/review-requests";
import {
  baselinesConfig, checksConfig, configBackupIntervalDays, configBackupKeep, configExportReminderDays, hibernateEndWatchersOn, hibernateMinutes, hibernateOn, idleCloseMinutes, sharedMcpOn, auditRetentionDays, memoryOn,
  flowDailyAsks, memoryPressureFreePercent, memoryPressureOn, refreshThreshold, scheduleConfig, sessionAdmission, SettingError, trackerTools,
} from "./settings/settings-values";
import { evidenceGuideLines, type GuideRepo } from "./prereview/guide-lines";
import { PreReviewService } from "./prereview/service";
import { makePreReviewHandler, type PreReviewPayload } from "./prereview/runner";
import { PreReviewStatusService, preReviewLockKey } from "./prereview/status";
import { defaultBase, fromCompare, prDiff } from "./prereview/diff";
import { relevantLessons } from "./prereview/lessons";
import type { ExecRun } from "./prereview/model";
import { PreReviewRepo } from "./db/prereview-repo";
import { AssessRepo } from "./db/assess-repo";
import { ReviewEffectRepo } from "./db/review-effect-repo";
import { PrPolicies } from "./assess/policies";
import { AssessmentService } from "./assess/assessment-service";
import { BriefService } from "./assess/brief-service";
import { setStackBriefProvider, stackBriefProvider } from "./assess/stack-brief";
import { ReviewEffectCollector } from "./review-effect/collector";
import { reviewEffect } from "./review-effect/stats";
import { readPreReviewConcurrency, type DiffFile, type ReviewTarget } from "../shared/prereview";
import type { RepoProfile } from "../shared/baselines";
import type { CheckHitView } from "../shared/checks";
import type { TicketPr } from "./db/ticket-prs-repo";
import { registryTier } from "./routing/router";
import { watcherGuideLines } from "./procs/watcher-policy";
import { createProcServices, type ProcServices } from "./procs/proc-services";
import { platformKill } from "./procs/orphans";
import { readProcTable, timedProcTable } from "./procs/proc-table";
import { procTreeFrom } from "./sessions/proc-tree";
import { minuteRefresh } from "./diag/change-watch";
import { MemorySamplesRepo } from "./db/memory-samples-repo";
import { runSmoke } from "./smoke";
import { M } from "./strings";
import { appMenuTemplate } from "./app-menu";
import { UpdateChecker } from "./update/update-checker";
import { latestRelease } from "./update/release-source";
import { isShipherdReleaseUrl, releasesLatestUrl } from "../shared/shipherd-repo";
import type { AppMenuAction } from "../shared/update";
import { pathKey } from "./util/env";
import { resolveGh } from "./util/gh-path";
import { applyGitResolution, resolveGit } from "./util/git-path";
import { knownPrLookup, openKnownPr } from "./util/github-url";
import { openExternalLink } from "./util/external-link";
import { TicketError, TicketService, samePath } from "./tickets/ticket-service";
import { repoLocks } from "./tickets/repo-lock";
import { isValidTicketKey } from "./tickets/ticket-key";
import type { IntakeSourceKind } from "../shared/intake";
import { defaultPrPolicy } from "../shared/pr-policy";
import { IntakeRepo } from "./db/intake-repo";
import { IntakePolicyService } from "./intake/policy";
import { IntakePolicyError } from "../shared/intake";
import { IntakeService } from "./intake/intake-service";
import { parseRepoMap } from "./intake/repo-map";
import { fileSource, trackerSource, type IntakeSource } from "./intake/sources";
import { classifyByModel } from "./intake/model";
import { activeInRepo, changedPaths } from "./intake/conflicts";
import { classifyCiByModel } from "./loop/ci-model";
import { CiTriage } from "./loop/ci-triage";
import { CommentLoop } from "./loop/comment-loop";
import { StacksRepo } from "./db/stacks-repo";
import { StackPolicyService } from "./stacks/stack-policy";
import { StackService, type OwnedBranch } from "./stacks/stack-service";
import { StackControl } from "./control/stack-control";
import { prStateFromEnvelope, ticketsForPrCommands, type PrCommandDeps } from "./prwatch/pr-command";
import { TicketControl } from "./control/ticket-control";
import { closeWiring } from "./tickets/ticket-close-wiring";
import { closePreview, closeTicket, prRefreshOptions, reopenTicket, retryClose, setTicketStatus, type TicketCloseDeps } from "./tickets/ticket-close";
import { prClose } from "./stacks/gh-stack";
import { classifyCommentsByModel } from "./loop/comment-model";
import { LoopPolicies } from "./loop/policies";
import { effectDays, LoopStats } from "./loop/stats";
import { CiTriageRepo } from "./db/ci-triage-repo";
import { CommentItemsRepo } from "./db/comment-items-repo";
import { commentOnPr, replyToReviewComment, rerunFailed, resolveReviewThread, reviewThreads, runInfo } from "./tickets/gh-loop";
import type { CiItem } from "./prwatch/ci-delivery";
import { applyGhResolution, branchRuns, ghAuthState, createPr, ghAvailable, probeGh, compareFiles, editPrBody, failedLog, failedLogDetail, mergedPrs, prBody, REVIEW_SEARCH_TIMEOUT_MS, reviewRequestedPrs, prFileNames, prHead, prInfo, prLessonDataDetail, prsForBranch, prRead, prStatus, repoCurrentSlug, prBatch, reviewAuthors, reviewComments, issueEvents, searchMergedPrs } from "./tickets/gh";
import { RepoRenamesRepo } from "./db/repo-renames-repo";
import { RENAME_RETRY_MS, RepoRenames } from "./tickets/repo-renames";
import { LessonsRepo } from "./db/lessons-repo";
import { LessonRunsRepo } from "./db/lesson-runs-repo";
import { RepoIdentity } from "./lessons/repo-identity";
import { readTailLines, TRANSCRIPT_TAIL_BYTES } from "./lessons/tail";
import { JudgmentCache } from "./lessons/admission/judgments";
import { LessonEnricher } from "./lessons/enrich";
import { AdmissionService } from "./lessons/admission/service";
import { importConflictDetector } from "./lessons/admission/import-conflicts";
import { WizardService } from "./lessons/admission/wizard";
import { CalibrationService } from "./lessons/admission/calibration";
import { PrinciplesService } from "./lessons/admission/principles";
import type { AdmissionFacade } from "./ipc/register";
import { OPEN_GATE } from "./lessons/admission/model-steps";
import { LessonRunner } from "./lessons/lesson-runner";
import { LessonsService } from "./lessons/lessons-service";
import { LessonBatchService } from "./lessons/lesson-batches";
import { BatchRecorder } from "./batches/batch-recorder";
import { baselineAdapter, baselineRuleAdapter, checkAdapter, lessonAdapter, lessonPrincipleAdapter, mergeProposalAdapter, policyAdapter, principleAdapter, productAdapter, stackPolicyAdapter } from "./batches/table-adapter";
import { BaselineService } from "./baselines/baselines-service";
import { LegacyScanService } from "./baselines/legacy-service";
import { baselineWorkerRunner } from "./baselines/worker-host";
import { BacktestRepo } from "./db/backtest-repo";
import { createBacktestStack } from "./backtest/stack";
import { realBacktestGh } from "./backtest/material";
import { backtestWorkerEvaluator } from "./backtest/eval-worker-host";
import { CheckExporter } from "./baselines/export/exporter";
import { BaselinesRepo } from "./db/baselines-repo";
import { ChecksService } from "./checks/checks-service";
import { SnapshotWriter, readSnapshotState } from "./checks/snapshot-writer";
import { HitIngest } from "./checks/hit-ingest";
import { CheckDrafter } from "./checks/draft";
import { HIT_RETENTION_MS } from "./db/checks-repo";
import { CHECKS_SNAPSHOT_VERSION, type CheckAbsenceReason } from "../shared/checks";
import { writeRunFile } from "./lessons/run-file";
import type { HeadlessExecDeps, UsageReport } from "./handoff/headless-exec";
import * as git from "./tickets/git";
import { canSend } from "./safe-send";
import { createQuitState } from "./quit-state";
import { KeepAwake } from "./keep-awake";
import { TRAY_ICONS } from "./tray-icons";
import { CSP_VIOLATION_LOG_PREFIX, isCspViolationMessage } from "./csp-log";
import { RoutingRepo } from "./db/routing-repo";
import { ModelDiscovery } from "./routing/discovery";
import { RoutedLessonsGate } from "./routing/lessons-gate";
import { DISCOVERY_USAGE_WINDOW_MS, MODEL_PROBE_TIMEOUT_MS, probeWithHeadless, readClaudeSettingsModel } from "./routing/probe";
import { RoutingService } from "./routing/routing-service";
import { SessionModelSwitcher } from "./routing/session-switch";
import { routingSettings } from "./routing/routing-settings";
import type { DiscoveryView, Tier } from "../shared/model-routing";

/** session 只是又有了输出时，最多隔这么久告诉界面一次（ticket 速览的上下文、最后一句）。 */
const OUTPUT_NOTIFY_MS = 5000;

const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** hook 发现没有 ticket 的 session 后，稍等片刻再扫描磁盘（合并连续事件）。 */
const HOOK_DISCOVERY_DEBOUNCE_MS = 3000;
/** 系统空闲超过这么多秒就不算“正在用电脑”（用于 tick 触发早间任务）。 */
const ACTIVE_IDLE_SECONDS = 120;
/** 熔断的「最近的记录」留多久；结束了的后台任务留多久（工作流 L）。启动时清一次。 */
const COST_EVENTS_RETENTION_MS = 180 * 24 * 3600_000;
const BG_FINISHED_RETENTION_MS = 30 * 24 * 3600_000;

let win: BrowserWindow | null = null;
/** 窗口 show / restore 时调（bootstrap 里接到 WS-M 的优先级上）。 */
let windowShownHook: () => void = () => undefined;
/** 窗口又看得见了（show / restore / focus）：补发藏着时攒下的 state:changed（BTL-275，bootstrap 里接到 invalidator.resume）。 */
let windowBackHook: () => void = () => undefined;
/** 窗口现在看得见：建好了、没藏到托盘、没最小化。 */
const windowVisible = (): boolean => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
let tray: Tray | null = null;
/** 启动时的第一个窗口建好以后为 true：之后窗口被关掉（崩溃对话框里选了关掉），showWindow 可以再建一个。 */
let windowReopenable = false;
/** e2e 设 SHIPHERD_BACKGROUND_WINDOWS=1：窗口不激活、macOS 上不进 Dock，测试跑起来不把焦点从别的程序抢过来。 */
const BACKGROUND_WINDOWS = process.env.SHIPHERD_BACKGROUND_WINDOWS === "1";
/** 防休眠开关（托盘菜单和侧边栏都能开关）；bootstrap 里建好。 */
let keepAwake: KeepAwake | null = null;
const quitState = createQuitState(() => app.quit());
let logger: Logger = () => undefined;
/** 把攒着的日志行同步写完（退出、崩溃时；BTL-242 起日志攒一会儿再异步写）。 */
let flushLogSync: () => void = () => undefined;
/** dev 控制台 tee：防止在 tee 里再次写日志造成递归，stderr 管道断开后停止 tee。 */
let teeing = false;
let teeBroken = false;
function teeToConsole(line: string): void {
  if (teeing || teeBroken) return;
  teeing = true;
  try {
    console.error(line);
  } finally {
    teeing = false;
  }
}
/** bootstrap 赋值：退出前在窗口还活着时先结束所有终端进程。 */
let shutdownSessions: () => void = () => undefined;
/** 所有 headless claude 运行（handoff、刷新、MCP 探测）共用：退出时一起取消，调度器也不再发起新任务。 */
const headlessAbort = new AbortController();

/** BTL-260：用的是改名前的 userData，单实例锁和旧版 Butler 共用。 */
let usingLegacyUserData = false;
// 隔离运行（SHIPHERD_HOME 指向别的目录）时也换一个 Electron 用户目录，否则单实例锁会和正在用的 Shipherd 冲突。
// 用 resolvePaths 解析：相对路径会变成绝对路径（setPath 只接受绝对路径）。
if (envValue(process.env, "HOME")?.trim()) app.setPath("userData", join(resolvePaths().home, "electron"));
else {
  // BTL-260：改名前的老用户接着用旧的 userData（<appData>/butler），见 legacyUserDataDir。必须在 ready、单实例锁之前。
  const legacy = legacyUserDataDir(app.getPath("appData"), existsSync);
  if (legacy) app.setPath("userData", legacy);
  usingLegacyUserData = legacy !== null;
}
// Windows 的通知要有 AppUserModelID，否则点击通知没有反应（计划 2 Task 13）。
if (shouldSetAppId(process.platform)) app.setAppUserModelId(APP_ID);

/** 性能诊断（BTL-242）：bootstrap 里装上。 */
let diag: DiagService | null = null;
/** 诊断导出里的信箱状态（BTL-279）：信箱建好之后才接上。 */
let mailboxDiagnostics: (() => unknown) | null = null;
/**
 * 渲染进程的健康（BTL-262）：崩了记原因和退出码、限频自动重新加载（5 分钟最多 3 次，超过就停下弹框）；
 * 卡住和恢复也记下来。这些都进导出诊断（BTL-242）。整个进程一份，换了窗口记录也还在。
 */
const rendererHealth = new RendererHealth({
  now: Date.now,
  log: (line) => logger(line),
  reload: () => {
    if (win && !win.isDestroyed()) win.webContents.reload();
  },
  quitting: () => quitState.quitting,
  gaveUp: (info) => void rendererGaveUp(info),
});

/**
 * 崩掉的窗口关掉（BTL-262 审查）：只销毁这个窗口，app 留在托盘里，session 和终端（PTY 在主进程里）照常跑。
 * 从托盘或 Dock 再打开时 showWindow 新建一个窗口。
 */
function closeBrokenWindow(why: string): void {
  logger(`renderer: closing the crashed window (${why}); Shipherd keeps running in the tray`);
  if (win && !win.isDestroyed()) win.destroy();
}

/**
 * 自动重新加载的次数用完了：界面已经没了，只能用主进程的对话框告诉用户，让用户选重新加载、导出诊断、关掉窗口或退出。
 * 只有明确点「退出」才退出：退出会结束所有在跑的 session，它们本来没受渲染进程崩溃的影响。
 */
async function rendererGaveUp(info: { reason: string; exitCode: number; reloads: number }): Promise<void> {
  const S = M().rendererGone;
  for (;;) {
    let choice: number;
    try {
      ({ response: choice } = await dialog.showMessageBox({
        type: "error", title: S.title, message: S.message(info.reloads, Math.round(RELOAD_WINDOW_MS / 60_000)), detail: S.detail(info.reason, info.exitCode),
        // Esc / 关掉对话框算「关掉窗口」：不重新加载（一加载就崩的界面，按一次 Esc 不该又白给三次自动重新加载），也不退出。
        buttons: [S.reload, S.exportDiag, S.closeWindow, S.quit], defaultId: 0, cancelId: 2, noLink: true,
      }));
    } catch (e) {
      // 连对话框都弹不出来：问不了用户，只关掉这个窗口，不留一个空白窗口，也不结束 session。
      logger("renderer: could not show the crash dialog", e);
      closeBrokenWindow("the crash dialog could not be shown");
      return;
    }
    if (quitState.quitting) return;
    if (choice === 1) {
      await diag?.export().catch((e: unknown) => logger("renderer: diagnostics export failed", e));
      continue;
    }
    if (choice === 3) app.quit();
    else if (choice === 2) closeBrokenWindow("chosen in the crash dialog");
    else rendererHealth.userReload();
    return;
  }
}
/** 渲染进程挂着的终端（BTL-242）：pty:data 只发给它们。 */
const ptySubs = new PtySubscriptions();
/** 终端输出攒一下再发（BTL-277）：每个终端最多每 OUTPUT_BATCH_MS 一条 pty:data。 */
const ptyOutput = new OutputBatcher((id, data) => safeSend(IPC.ptyData, id, data));

function safeSend(channel: string, ...args: unknown[]): void {
  if (win && canSend(win)) {
    diag?.send(channel, args);
    win.webContents.send(channel, ...args);
  }
}

/** 开发时仓库根目录下的 build/（out/main/index.js 往上两级）。 */
const devBuildDir = (): string => join(__dirname, "..", "..", "build");

function bundledHookPath(): string {
  const name = process.platform === "win32" ? "shipherd-hook.exe" : "shipherd-hook";
  return app.isPackaged ? join(process.resourcesPath, "hook", name) : join(devBuildDir(), "hook", name);
}

/** 打包好的 StateCore MCP（任务 7）：开发时在 build/ 下（pnpm dev / build 会先生成），安装包里在 resources 下。 */
function bundledMemoryMcpPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "memory-mcp", "statecore-mcp.cjs") : join(devBuildDir(), "memory-mcp", "statecore-mcp.cjs");
}

/** 共享 MCP 的 hub（WS-M H，和记忆 MCP 一起打包）。 */
function bundledHubPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "memory-mcp", "mcp-hub.cjs") : join(devBuildDir(), "memory-mcp", "mcp-hub.cjs");
}

/** 总控 session 的 shipherd-sessions MCP（和记忆 MCP 一起打包，放在同一个目录）。 */
function bundledSessionsMcpPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "memory-mcp", "shipherd-sessions-mcp.cjs") : join(devBuildDir(), "memory-mcp", "shipherd-sessions-mcp.cjs");
}

/** dev 模式下的渲染器地址；打包后永远不用环境变量。 */
function devRendererUrl(): string | null {
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null;
}

function isOwnUrl(url: string): boolean {
  const dev = devRendererUrl();
  try {
    if (dev) return new URL(url).origin === new URL(dev).origin;
    return url === pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Shipherd",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 自动化测试（e2e）在后台开窗口：不抢焦点，不打断用户在别的程序里打字。
  w.on("ready-to-show", () => (BACKGROUND_WINDOWS ? w.showInactive() : w.show()));
  w.on("closed", () => {
    if (win === w) win = null;
  });
  // 窗口又出现了：看得见的终端马上恢复优先级（WS-M E）。
  w.on("show", () => (windowShownHook(), windowBackHook()));
  w.on("restore", () => (windowShownHook(), windowBackHook()));
  w.on("focus", () => windowBackHook());
  // Windows 注销 / 关机：不能再把关窗口拦成“藏到托盘”，否则会挡住系统（计划 1 Task 12）。
  w.on("session-end", () => quitState.requestQuit());
  // 关窗口只是藏到托盘，终端进程继续运行。
  w.on("close", (e) => {
    if (!quitState.quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  // 拖入文件等导航不能替换界面（否则 preload 桥会暴露给任意页面）；也不允许新开窗口。
  w.webContents.on("will-navigate", (e, url) => {
    if (!isOwnUrl(url)) e.preventDefault();
  });
  // 新窗口一律不开；http / https 链接（比如漏网的 <a target=_blank> 或 window.open）改交给系统浏览器，和终端里点链接走同一个检查（BTL-257）。
  w.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url, { openExternal: (u) => shell.openExternal(u), log: logger });
    return { action: "deny" };
  });
  // 渲染进程整页重新加载（或者崩了）：之前挂的终端都不在了（BTL-242）。
  w.webContents.on("did-start-navigation", (e) => {
    if (e.isMainFrame && !e.isSameDocument) ptySubs.clear();
  });
  // 崩了：记下原因和退出码，限频自动重新加载（BTL-262）。卡住和恢复也记，Windows 卡顿（BTL-242）要看。
  w.webContents.on("render-process-gone", (_e, details) => {
    ptySubs.clear();
    rendererHealth.gone({ reason: details.reason, exitCode: details.exitCode });
  });
  w.on("unresponsive", () => rendererHealth.unresponsive());
  w.on("responsive", () => rendererHealth.responsive());
  // CSP 拦下了什么就记一笔（任务 6）：界面某处空白时先看这里。
  w.webContents.on("console-message", (e) => {
    if (isCspViolationMessage(e.message)) logger(`${CSP_VIOLATION_LOG_PREFIX} ${e.message}`);
  });
  const dev = devRendererUrl();
  const loaded = dev ? w.loadURL(dev) : w.loadFile(join(__dirname, "../renderer/index.html"));
  loaded.catch((e: unknown) => logger("renderer load failed", e));
  return w;
}

function showWindow(): void {
  // 崩掉的窗口被关掉了（closeBrokenWindow）：新建一个，自动重新加载重新计数。启动完成之前（win 还没建）什么也不做。
  if (!win && windowReopenable) {
    rendererHealth.windowReopened();
    win = createWindow();
    return;
  }
  if (!win) return;
  if (BACKGROUND_WINDOWS) {
    win.showInactive();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray(): Tray {
  const isMac = process.platform === "darwin";
  // 方向 E1 的托盘图标（scripts/render-icons.mjs 生成）：16 px 加高分屏用的 @2x（计划 1 Task 12）。
  const set = isMac ? TRAY_ICONS.macTemplate : TRAY_ICONS.win;
  const icon = nativeImage.createFromBuffer(Buffer.from(set[1], "base64"), { scaleFactor: 1 });
  icon.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(set[2], "base64") });
  // macOS 模板图：系统按菜单栏的深浅自动着色。
  if (isMac) icon.setTemplateImage(true);
  const t = new Tray(icon);
  t.setToolTip(trayTooltip());
  t.setContextMenu(trayMenu());
  // 改语言之后菜单换成新语言（设计文档 2026-10-26）。
  onLangChange(() => {
    t.setContextMenu(trayMenu());
    t.setToolTip(trayTooltip());
  });
  t.on("click", showWindow);
  return t;
}

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: M().trayOpen, click: showWindow },
    { label: M().trayKeepAwake, type: "checkbox", checked: keepAwake?.isOn() ?? false, click: (item) => keepAwake?.set(item.checked) },
    { type: "separator" },
    { label: M().trayQuit, click: () => app.quit() },
  ]);
}

/** 托盘提示的第二行：成本熔断暂停了几个（工作流 L）。 */
let costPausedCount = 0;

function trayTooltip(): string {
  const base = keepAwake?.isOn() ? M().trayTooltipKeepAwake : "Shipherd";
  return costPausedCount > 0 ? `${base}\n${M().cost.trayPaused(costPausedCount)}` : base;
}

async function bootstrap(): Promise<void> {
  // BTL-260：老用户的 ~/.butler 搬到 ~/.shipherd。在建目录、打开数据库之前（结果等日志建好再记）。
  const legacyHome = migrateLegacyHome({ env: process.env });
  // 没搬成：数据原样在旧目录，这次就用它（传给子进程的也是它），下次启动再搬。不能拿空的新目录启动，那样下次就当成已经搬过了。
  if (legacyHome.kind === "failed") process.env.SHIPHERD_HOME = legacyHome.legacy;
  const paths = resolvePaths();
  await ensureDirs(paths);
  const fileLog = createFileLogger(join(paths.logs, "main.log"), undefined, app.isPackaged ? undefined : teeToConsole);
  logger = fileLog;
  flushLogSync = fileLog.flushSync;
  diag = new DiagService({
    mode: diagMode(process.env),
    now: Date.now,
    log: (line) => logger(line),
    logFile: join(paths.logs, "main.log"),
    flushLog: () => fileLog.flush(),
    info: () => ({
      version: app.getVersion(),
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      platform: process.platform,
      arch: process.arch,
      osRelease: osRelease(),
      cpus: { model: cpus()[0]?.model ?? "", count: cpus().length },
      memory: { totalMb: Math.round(totalmem() / 1048576), freeMb: Math.round(freemem() / 1048576) },
      appMetrics: app.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage, memoryKb: m.memory.workingSetSize, peakKb: m.memory.peakWorkingSetSize })),
      mainMemory: { ...process.memoryUsage() },
    }),
    pickSavePath: async (defaultName) => {
      const opts = { defaultPath: defaultSavePath((n) => app.getPath(n), defaultName), filters: [{ name: "JSON", extensions: ["json"] }] };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    writeFile: (path, text) => writeFileAsync(path, text, "utf8"),
    rendererEvents: () => rendererHealth.events(),
    mailbox: () => mailboxDiagnostics?.() ?? null,
    cpuTimes: () => {
      const t: Record<string, number> = {};
      for (const m of app.getAppMetrics()) t[m.type] = (t[m.type] ?? 0) + (m.cpu.cumulativeCPUUsage ?? 0);
      return t;
    },
  });
  diag.start();
  if (!app.isPackaged) process.stderr.on("error", () => { teeBroken = true; });
  // 先用 Shipherd 自己的 PATH 定下 git 和 gh 的绝对路径；登录 shell 的 PATH 读到之后再更新一次。
  const ownPath = process.env[pathKey(process.env)] ?? "";
  applyGitResolution(resolveGit(ownPath, process.platform), process.platform, (m) => logger(m));
  applyGhResolution(resolveGh(ownPath, process.platform), process.platform, (m) => logger(m));
  void probeGh(5000);
  // 要迁移时先备份（BTL-262）；备份失败就问用户：默认退出（先腾空间），用户也可以选不备份继续。
  const db = openDatabase(paths.db, {
    log: (m) => logger(m),
    onBackupFailed: (f) => {
      const A = M().databaseBackupAsk;
      return dialog.showMessageBoxSync({
        type: "warning", title: A.title, message: A.title, detail: M().databaseBackupFailed(f.backup, f.reason, f.diskFull),
        buttons: [A.quit, A.continue], defaultId: 0, cancelId: 0, noLink: true,
      }) === 1;
    },
  });
  await finishLegacyHome(legacyHome, paths, db, (m) => logger(m));
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const blocks = new BlocksRepo(db);
  const featureForCwd = (cwd: string): number | null => features.byWorkspace(cwd)?.id ?? null;
  const settings = new SettingsRepo(db);
  /** 当前语言：SHIPHERD_LANG > 设置 > 系统首选语言（设计文档 2026-10-26）。 */
  const applyLanguage = () => setLang(resolveLang(settings.get("language"), app.getPreferredSystemLanguages(), envValue(process.env, "LANG")));
  applyLanguage();
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const jobs = new JobsRepo(db);
  const featureHandoffs = new FeatureHandoffsRepo(db);
  // PR 进度的原始事件：PR 监视和 hook 的 skill 事件共用这一个。
  const prStages = new PrStageRepo(db);
  const memory = new MemoryService({
    dataDir: paths.statecore,
    tickets,
    handoffs,
    followups,
    features,
    featureHandoffs,
    epicArchive: new EpicArchiveRepo(db),
    sync: new MemorySyncRepo(db),
    enabled: () => memoryOn(settings),
    now: Date.now,
    // 记忆标签开着时能看到新写入的内容：只发记忆专用的事件，标签不跟着每次 stateChanged 重新打开 StateCore（最终审查 4）。
    onSynced: (key) => safeSend(IPC.memoryChanged, key),
    log: logger,
  });
  // 等仓库锁太久（BTL-264）写进日志：在等谁、等了多久。
  repoLocks.log = (m) => logger(m);
  const ticketService = new TicketService({ tickets, features, settings, now: Date.now, workspacesDir: paths.workspaces, log: (m) => logger(m) });
  // hook 程序是当前版本（启动时刚换好或本来就是，或健康页刚装好）才看得到 skill 调用：从这时起记「开始记 skill 的时间」。幂等，不会往后移。
  const seedSkillTracking = () => {
    try {
      ensureSkillTrackingSince({ settings, firstSkillAt: () => prStages.firstSkillAt(), now: Date.now });
    } catch (e) {
      logger("skill tracking start not recorded", e);
    }
  };
  const health = new HealthService({
    paths, platform: process.platform, env: process.env, settings, bundledHookBin: bundledHookPath(), memoryMcpScript: bundledMemoryMcpPath(), log: logger, onHookBinCurrent: seedSkillTracking,
    // 先用登录 shell 的 PATH 重新找 gh，再看它登没登录（向导第 1 步、环境检查，BTL-249）。
    gh: (pathValue) => {
      applyGhResolution(resolveGh(pathValue, process.platform), process.platform, (m) => logger(m));
      return ghAuthState(3000);
    },
  });
  // 「谁该动」看板（UI 重做第 1 层）跟着 stateChanged 一起防抖推 turn:changed；TurnService 在下面才建好。
  let turnChanged: (() => void) | null = null;
  // 找对话记录文件（BTL-242）：记住找到过的路径，命中时只看那一个文件还在不在。
  // 还没有记录文件的 session 先看 cwd 推出的目录，整个目录 20 秒最多扫一次（BTL-275）；hook 说它起来了、收到输入时 forget。
  const transcriptLocator = new TranscriptLocator(paths.claudeProjects, undefined, undefined, undefined, undefined, { cwdOf: (id) => sessions.get(id)?.cwd ?? null });
  // 视图缓存（BTL-242）：界面那边的读（列表、首页、看板）在下一次 notify / 写操作 / 1 秒之前共用一份。主进程自己的逻辑不走它。
  const viewCache = new ViewCache({ now: Date.now });
  // notify 合并（BTL-242）：一小段时间里的多次 notify 合成一次 state:changed（带上范围），turn:changed 跟着同一次发。
  // 只是一次内存采样（procs）时看板不用重取。
  const invalidator = new Invalidator({
    emit: (scopes) => {
      safeSend(IPC.stateChanged, { scopes } satisfies StateChangedPayload);
      if (scopes.includes("data") || scopes.includes("activity")) turnChanged?.();
    },
    // 按范围作废（BTL-265）：哪种范围作废哪些视图见 view-scopes.ts。
    onChange: (scope) => viewCache.invalidate(SCOPE_INVALIDATES[scope]),
    // 窗口藏着时不推（BTL-275）：攒着，窗口回来时 windowBackHook 补发一次。
    visible: windowVisible,
  });
  windowBackHook = () => invalidator.resume();
  // 有些地方把 notify 直接当回调传（.then(notify)）：参数不是范围的一律当 data。
  const notify = (scope?: unknown) => invalidator.notify(isStateScope(scope) ? scope : "data");
  // session 只是又有了输出：隔 5 秒才告诉界面一次（只有 ticket 速览听 output）。
  const outputChanged = throttle(() => notify("output"), OUTPUT_NOTIFY_MS);
  // 健康探测可能很慢（登录 shell、claude --version）：后台进行，窗口先出来。
  // 同时把升级后还是旧版本的 shipherd-hook 换成新的（最终审查 1）：打开 session 要等 healthReady，gate 开不开在那之前就定了。syncHookBinary 不抛错。
  // Shipherd 旧版本装的 /handoff 也先换成当前版本再探测（C1），健康页报告的是换完的状态。syncHandoffCommand 不抛错。
  /** 登录 shell 的 PATH 下 gh 探测完（BTL-253 的更新检查等它，免得 gh 明明装了却被当成没装）。 */
  let ghProbed: Promise<void> = Promise.resolve();
  const healthReady: Promise<void> = Promise.all([health.syncHandoffCommand().then(() => health.refresh()), health.syncHookBinary()])
    // BTL-260：syncHookBinary 替用户换掉了改名前的 butler-hook 条目，上面那次 refresh 可能是换之前读的。
    .then(() => (health.takeLegacyHookMigrated() ? health.refresh().then(() => undefined) : undefined))
    .then(
    () => {
      if (health.hookBinCurrent() && existsSync(paths.hookBin)) seedSkillTracking();
      applyGitResolution(resolveGit(health.claude().pathValue, process.platform), process.platform, (m) => logger(m));
      applyGhResolution(resolveGh(health.claude().pathValue, process.platform), process.platform, (m) => logger(m));
      notify();
      ghProbed = probeGh(5000).then(() => notify()).catch((e: unknown) => logger("gh probe notify failed", e));
    },
    (e: unknown) => {
      logger("initial health refresh failed", e);
    },
  );
  const usageRepo = new UsageRepo(db);
  // 度量（ws-h，契约 4.7）：人介入、打断、等人时间记成事件和等待段，每小时汇总进 metrics_daily。
  const metricsRepo = new MetricsRepo(db);
  const recordMetric = new Metrics({ repo: metricsRepo, now: Date.now, log: logger }).recordEvent;
  // 外部通知（ws-j 设计 7）：熔断（L）、高风险 / 就绪的 PR（G）都是度量事件；记下了（去重后）才推。notifier 在后面建好后才有。
  let notifier: Notifier | null = null;
  const recordEvent: RecordEvent = (kind, refs) => {
    const recorded = recordMetric(kind, refs);
    if (recorded) {
      const n = notifyFromMetric(kind, refs);
      if (n) notifier?.emit(n.event, n.ref);
    }
    return recorded;
  };
  ensureMetricsSince(settings, Date.now());
  /** 某个 session（取 head）最近一轮的上下文大小：计划 16 的自动换新看它。 */
  const contextOf = (sessionId: string): number | null => usageRepo.latestContext(sessions.head(sessionId)?.id ?? sessionId);
  /** headless 运行（handoff、feature 汇总、卡住判断）的用量入库。 */
  // 成本熔断（工作流 L）：要等 switcher、guard 这些建好才装（见下面）；在那之前 gate 一律放行。
  let costBreaker: CostBreaker | null = null;
  let costCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** 用量变了：稍后让熔断看一遍（合并 2 秒内的多次）。 */
  const costCheckSoon = (): void => {
    if (costCheckTimer || !costBreaker) return;
    costCheckTimer = setTimeout(() => {
      costCheckTimer = null;
      if (!closing && !headlessAbort.signal.aborted) void costBreaker?.check().catch((e: unknown) => logger("cost: check failed", e));
    }, 2000);
    costCheckTimer.unref?.();
  };
  const recordHeadlessUsage = (r: UsageReport) => {
    try {
      usageRepo.record([headlessUsageRow(r)]);
      if (r.ticketKey) costCheckSoon();
    } catch (e) {
      logger("recording headless usage failed", e);
    }
  };
  // 每个 transcript 只读一次、只解析一次，交给用量、活动、对话另存三个消费者（BTL-276）。
  const transcriptHub = new TranscriptHub({ log: logger });
  const usageScanner = new UsageScanner({
    repo: usageRepo, hub: transcriptHub,
    sessionIds: () => pty.openIds().map((t) => sessions.head(t)).filter((s) => s?.origin === "shipherd").map((s) => s!.id),
    transcriptFile: (id) => transcriptLocator.find(id),
    // 扫完一遍：成本熔断按新用量看一遍（工作流 L）。
    onScanned: () => costCheckSoon(),
    log: logger,
  });
  /** will-quit 关数据库之前置位：之后才到的终端退出事件（killAll 是异步的）不再碰数据库。没处理的空 session 下次启动时清掉。 */
  let closing = false;
  // 内存、优先级、孤儿（WS-M）：要等 refresher 建好才装，终端退出事件在那之前到就跳过。
  let procs: ProcServices | null = null;
  // 休眠（WS-M B、C）：要等 procs 和下面的一堆服务建好才装，在那之前没有休眠这回事。
  let hibernator: Hibernator | null = null;
  // 内存准入（工作流 W）：要等 procs 建好才装（实测要 M 的内存采样）；后台队列在那之后才 start，用的时候一定装好了。
  let memoryAdmission: MemoryAdmission | null = null;
  // 后台恢复关着的 session（BTL-256）：和休眠一样，等下面的服务都建好才装。
  let resumer: Resumer | null = null;
  /** 休眠着的 head（Shipherd 结束了它的终端，等事情来了再 --resume）。 */
  const hibernatedHeads = (): Session[] => sessions.listHibernated();
  /** 这条链休眠着（正在休眠、正在唤醒的也算）。 */
  const isHibernated = (id: string): boolean => hibernator?.isHibernated(id) ?? false;
  /** 自动接活建好以后才接上（session 结束时让它再试排着的）。 */
  let intakeEnded: (() => void) | null = null;
  const pty = new PtyManager(nodePtyFactory, {
    // 攒 OUTPUT_BATCH_MS 再发（BTL-277）：只攒挂着的终端；发的时候已经摘下也照发，渲染进程那边不在 ready 状态会丢掉。
    data: (id, data) => {
      if (ptySubs.has(id)) ptyOutput.push(id, data);
    },
    opened: (id) => {
      procs?.terminalOpened(id);
      // 重启后自动恢复（BTL-256）：记下终端开着；Shipherd 运行时退出才清，退出 Shipherd 时留着，下次启动看得到。
      sessions.markTermOpen(id, Date.now());
    },
    exit: (id, code) => {
      // 攒着的输出先发：退出提示排在最后一段输出后面。
      ptyOutput.forget(id);
      safeSend(IPC.ptyExit, id, code);
      if (closing) return;
      if (!quitState.quitting) sessions.clearTermOpen(id);
      procs?.terminalExited(id);
      // 共享 MCP（WS-M H）：撤掉这个终端的路由，删掉它的配置文件。
      mcpHub.removeTerminal(id);
      removeTerminalMcpConfig(paths.mcp, id);
      // 度量（ws-h）：这个终端的按键去重记录不用留着。
      terminalMeter.forget(id);
      // 信箱（BTL-245）：hook 已经写出去的记成送达，排着的留在库里，等下次打开再送；投影删掉。
      mailbox.termExited(id);
      idleEvidence.forget(id);
      // 巡检那一轮跟着进程走（BTL-279 第四轮复核）：终端退出就不再算，停下的记录也不留着。
      patrolTurns.forget(sessions.head(id)?.id ?? id);
      // 合并后因为这个终端还在跑而没清理的 worktree：终端一退出就再试（设计文档 2026-10-26）。
      const exitedHead = sessions.head(id);
      const exitedTicket = exitedHead?.ticketKey ?? null;
      try {
        sessionService.handleExit(id);
      } catch (e) {
        logger("handleExit failed", e);
      }
      // 退出前最后一段 transcript 也要记上。
      if (exitedHead) void usageScanner.scanSession(exitedHead.id);
      if (exitedTicket) cleanupMerged(exitedTicket);
      // 自动接活（工作流 N）：名额可能空出来了、栈的下一层可能能开了。
      intakeEnded?.();
      notify();
    },
  }, Date.now, logger);
  // 共享 MCP（WS-M H）：上次留下的终端配置都失效了（token 是上一个 hub 的）。
  try {
    pruneTerminalMcpConfigs(paths.mcp);
  } catch (e) {
    logger("could not clear old shared MCP configs", e);
  }
  const mcpHub = new McpHub({ spawn: spawnHub(bundledHubPath(), (l) => logger(l)), dataDir: paths.statecore, log: logger, changed: () => notify() });
  const memoryMcpScript = bundledMemoryMcpPath();
  let memoryMcpMissingLogged = false;
  let sessionsMcpMissingLogged = false;
  /**
   * 记忆 server（记忆开着时）加上 shipherd-sessions（设计文档 2026-10-23 第二步，和记忆开关无关）。
   * mem 是要挂哪些记忆：ticket 的、feature 的（设计文档 2026-10-26）；scope 是总控管的 ticket 或 feature，
   * 普通 ticket session 是 member（只有 ask_user、report，BTL-190 第 2+3 点）。
   */
  const launcher = (script: string) => ({ command: process.execPath, script });
  const mcpServers = (mem: { ticketKey?: string; featureId?: number | null }, scope: { ticketKey: string } | { featureId: number } | { shipherd: true }) => {
    let servers = {};
    if (memoryOn(settings)) {
      if (existsSync(memoryMcpScript)) servers = memoryServers({ launcher: launcher(memoryMcpScript), statecoreDir: paths.statecore, ...mem });
      else if (!memoryMcpMissingLogged) {
        logger(`memory MCP bundle missing at ${memoryMcpScript}; sessions start without memory (run pnpm build:memory-mcp)`);
        memoryMcpMissingLogged = true;
      }
    }
    const script = bundledSessionsMcpPath();
    if (existsSync(script)) {
      servers = { ...servers, ...sessionsServer({ launcher: launcher(script), scope, requestsDir: paths.controlRequests, resultsDir: paths.controlResults }) };
    } else if (!sessionsMcpMissingLogged) {
      logger(`sessions MCP bundle missing at ${script}; sessions have no shipherd-sessions tools (run pnpm build:memory-mcp)`);
      sessionsMcpMissingLogged = true;
    }
    return servers as Record<string, StdioServerSpec>;
  };
  /**
   * 共享 MCP 开着、hub 在跑：这个终端的 server 换成 hub 上的路由，写进 mcp/terms/<终端>.json；否则 null，调用方写今天的 stdio 配置。
   * hub 还在启动、挂了、bundle 不在的时候都是 stdio，session 照样有 Shipherd 的 MCP。
   */
  let hubMissingLogged = false;
  const sharedMcpConfig = (termId: string, servers: Record<string, StdioServerSpec>): string | null => {
    if (!sharedMcpOn(settings)) return null;
    if (!existsSync(bundledHubPath())) {
      if (!hubMissingLogged) logger(`shared MCP hub bundle missing at ${bundledHubPath()}; sessions use their own MCP processes (run pnpm build:memory-mcp)`);
      hubMissingLogged = true;
      return null;
    }
    const routes = hubRoutes(servers, termId);
    const urls = routes && mcpHub.route(termId, routes);
    if (!urls) return null;
    try {
      return writeTerminalMcpConfig({ mcpDir: paths.mcp, termId, servers: Object.fromEntries(Object.entries(urls).map(([name, url]) => [name, { type: "http" as const, url }])) });
    } catch (e) {
      // 写不了这个终端的配置：撤掉刚登记的路由，这个 session 用 stdio。
      logger("could not write the shared MCP config; this session uses its own MCP processes", e);
      mcpHub.removeTerminal(termId);
      return null;
    }
  };
  /**
   * 这组 server 的 --mcp-config 写到哪。termId 是交互终端：共享 MCP 开着走 hub，否则写 stdio 文件（stdio()）。
   * termId 是 null（完整分叉，没有终端）：从不走 hub（没人撤它的路由、重启后 mcp/terms 也被清掉），写分叉自己的 stdio 文件，server 组一样。
   */
  const placeMcp = (termId: string | null, servers: Record<string, StdioServerSpec>, stdio: () => string): string =>
    termId === null ? writeForkMcpConfig({ mcpDir: paths.mcp, servers }) : (sharedMcpConfig(termId, servers) ?? stdio());
  /** 每次打开 session 时重写这个 ticket 的 --mcp-config 文件（设计文档 4.2、8.4）。什么都不挂时返回 null。termId null 见 placeMcp。 */
  const memoryMcpConfig = (ticketKey: string, opts: { featureId: number | null }, termId: string | null): string | null => {
    const servers = mcpServers({ ticketKey, featureId: opts.featureId }, { ticketKey });
    if (Object.keys(servers).length === 0) return null;
    return placeMcp(termId, servers, () => writeTicketMcpConfig({ mcpDir: paths.mcp, ticketKey, servers }));
  };
  /** feature 总控：feature 记忆、全局记忆和 feature 模式的 shipherd-sessions。 */
  const featureMcpConfig = (featureId: number, termId: string | null): string | null => {
    const servers = mcpServers({ featureId }, { featureId });
    if (Object.keys(servers).length === 0) return null;
    return placeMcp(termId, servers, () => writeFeatureMcpConfig({ mcpDir: paths.mcp, featureId, servers }));
  };
  /** Shipherd 总控（BTL-190 第 5 点）：只有全局记忆（shipherd-workspace）和 Shipherd 模式的 shipherd-sessions。 */
  const shipherdMcpConfig = (termId: string | null): string | null => {
    const servers = mcpServers({}, { shipherd: true });
    if (Object.keys(servers).length === 0) return null;
    return placeMcp(termId, servers, () => writeShipherdMcpConfig({ mcpDir: paths.mcp, servers }));
  };
  const availability = new ClaudeAvailability({ repo: new AvailabilityRepo(db, logger), now: Date.now, onChange: notify, log: logger });
  /** headless 运行报告限流 / 成功给可用状态。 */
  const availabilityHooks = {
    onLimit: (hit: LimitHit, job: string) => availability.report({ ...hit, source: "headless", job, sessionId: null }),
    onSuccess: (startedAt: number, job: string) => availability.noteSuccess(startedAt, job),
  };
  /** 没走路由的 headless 设置（模型探测用：只用指定的模型、不回报健康）。 */
  const probeDeps: HeadlessExecDeps = {
    run: runHeadless, ready: () => healthReady, claude: () => health.claude(), baseEnv: process.env, sessions, now: Date.now, newRunId: randomUUID,
    signal: headlessAbort.signal, onUsage: recordHeadlessUsage, timeoutMs: MODEL_PROBE_TIMEOUT_MS, log: logger,
  };
  const probeModel = (model: string) => probeWithHeadless(probeDeps, model);
  // 模型路由（3.0）：没有登记任何模型时每个调用点照旧用 2.1.0 的模型。
  const routingRepo = new RoutingRepo(db);
  const routing: RoutingService = new RoutingService({
    repo: routingRepo, usage: usageRepo, settings: () => routingSettings(settings), flags: () => health.claudeFlags(), now: Date.now,
    probe: probeModel,
    discovery: { view: (): DiscoveryView | null => discovery.view(), run: (): Promise<void> => discovery.run() },
    onChange: () => notify(), log: logger,
  });
  const discovery: ModelDiscovery = new ModelDiscovery({
    env: process.env,
    settingsModel: () => readClaudeSettingsModel(paths.claudeSettings),
    recentModels: () => usageRepo.modelsSince(Date.now() - DISCOVERY_USAGE_WINDOW_MS),
    registry: (): string[] => routing.config().registry.map((m) => m.name),
    probe: probeModel,
    onResult: (name, from, r) => {
      // 登记了却不存在 / 在限额里的：记到健康状态，路由跳过它。
      if (from !== "registry") return;
      if (r.ok) routing.health.probeResult(name, { ok: true });
      else if (r.hit) routing.onLimit(name, r.hit, { task: "model_probe", accountLevel: false });
    },
    now: Date.now, onChange: () => notify(), log: logger,
  });
  /** 卡住判断和「需要你」判断共用的 headless 设置。 */
  /** 成本熔断给 headless 调用的闸门（工作流 L）：ticket 的后台调用照常、降一档还是不跑；卡住判断不受影响。 */
  const costGate: HeadlessExecDeps["costGate"] = (o) => costBreaker?.gate(o) ?? "ok";
  const judgeDeps: HeadlessExecDeps = {
    run: runHeadless, ready: () => healthReady, claude: () => health.claude(), baseEnv: process.env, sessions, now: Date.now, newRunId: randomUUID,
    signal: headlessAbort.signal, onUsage: recordHeadlessUsage, ...availabilityHooks, routing, costGate, log: logger,
  };
  // 打断原因（7.4）：ask_user、需要你、卡住、权限确认和 AskUserQuestion 各记一条。inboxService、waitTracker 在下面才建好：调用时才用到。
  const interrupts = new InterruptRecorder({
    record: recordEvent,
    classify: (q) => classifyQuestion(judgeDeps, q.question, q.context, sessions.head(q.sessionId)?.cwd ?? homedir()),
    hasPendingDecision: (id) => inboxService.hasPendingDecision(id),
    ticketOf: (id) => sessions.head(id)?.ticketKey ?? null,
    log: logger,
  });
  // 后台调度（工作流 L，设计 addendum 第 3 节）：交互 session 优先；后台任务按优先级、时段（空闲 / 这些小时）、额度和熔断跑。
  const idleSignal = electronIdleSignal(powerMonitor, process.platform);
  const bgScheduler = new BackgroundScheduler({
    settings: () => readBgSettings(settings),
    setSetting: (key, value) => settings.set(key, value),
    idle: idleSignal,
    quota: () => routingQuota(routing),
    costBlocked: (key) => (costBreaker ? !costBreaker.allowBackground(key) : false),
    now: Date.now,
    // 让路和恢复记成 H 的度量事件（契约 4.7），日志照记。
    onEvent: backgroundMetricEvents(recordEvent, logger),
    log: logger,
  });
  bgScheduler.subscribe(() => notify());
  // 通用后台队列：D、F、G、N 的任务在这里登记处理函数。要开新 session 的任务先过 W 的内存准入（ctx.admitSession），不放行就延后。
  const bgRepo = new BackgroundRepo(db);
  try {
    const n = bgRepo.pruneFinished(Date.now() - BG_FINISHED_RETENTION_MS);
    if (n > 0) logger(`background: pruned ${n} finished job(s)`);
  } catch (e) {
    logger("background: pruning finished jobs failed", e);
  }
  const bgQueue = new BackgroundQueue({
    repo: bgRepo, scheduler: bgScheduler, now: Date.now, isHibernated, admission: () => memoryAdmission, onChange: () => notify(), log: logger,
    // BTL-271：预审的并发数是设置（默认 2）；别的种类用 BACKGROUND_KINDS 里的。
    concurrency: (kind) => (kind === "pre_review" ? readPreReviewConcurrency(settings.get("preReviewConcurrency")) : null),
  });
  /** 复盘的闸门：没配置路由时就是账号级的可用状态；配置了只在 lesson_analyze 哪个模型都用不了时停。 */
  const lessonsGate = new RoutedLessonsGate({ availability, routing, now: Date.now });
  // 复盘规矩：合并的 PR 排队，用用户自己的 claude 分析（最多 2 个同时）。
  const lessonsRepo = new LessonsRepo(db);
  // 规矩、产品和准入策略的改动都记成可撤销的批次（契约 4.4）。
  const batchRecorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db), principleAdapter(db), lessonPrincipleAdapter(db), mergeProposalAdapter(db), baselineRuleAdapter(db), baselineAdapter(db), stackPolicyAdapter(db)]);
  // 确定性检查（契约 4.5）：库里是三层的定义，hook 只读 Shipherd 写出来的快照（<SHIPHERD_HOME>/checks/snapshot.json）。
  // 检查、产品、设置、语言一变就重写快照（合并一小段时间里的改动）；内容没变不写。
  const checksService: ChecksService = new ChecksService({
    db, lessons: lessonsRepo, recorder: batchRecorder, now: Date.now, config: () => checksConfig(settings),
    onChanged: () => checkSnapshots.schedule(),
    snapshotStatus: () => checkSnapshots.lastStatus(),
  });
  const checkSnapshots = new SnapshotWriter({ file: paths.checksSnapshot, build: () => checksService.snapshot(), log: logger });
  checkSnapshots.start();
  // hook 一次运行写一个命中文件：读进 check_hits，「没有检查」记到 session 行上；绕过记录（工作流 F 的自动降级用）进 check_bypasses。
  const backtestRepo = new BacktestRepo(db);
  const checkHits = new HitIngest({
    dir: paths.checksHits,
    insertHits: (rows) => checksService.repo.insertHits(rows),
    insertBypasses: (rows) => backtestRepo.insertBypassLogs(rows),
    markAbsent: (session, reason) => sessions.setChecksAbsent(session, reason),
    onIngested: () => notify(),
    log: logger,
  });
  checkHits.start();
  try {
    checksService.prune(HIT_RETENTION_MS);
  } catch (e) {
    logger("checks: pruning old hits failed", e);
  }
  // admissionPolicies 在下面才建：回调到调用时才取它。
  const lessonBatches = new LessonBatchService({
    db, repo: lessonsRepo, recorder: batchRecorder, now: Date.now, onPolicyChanged: () => admissionPolicies.bumpVersion(), onChecksChanged: () => checkSnapshots.schedule(),
  });
  // 三层准入策略（契约 4.2）：版本存在设置 admissionPolicyVersion 里。
  const admissionPolicies = new AdmissionPolicyService({
    db, repo: lessonsRepo, recorder: batchRecorder, now: Date.now,
    // 校准页「标为已校准」之后，策略页不再说「未校准的默认值」（工作流 D）。
    calibrated: () => settings.get("admissionCalibratedAt") !== "",
    version: {
      get: () => Math.max(1, Number.parseInt(settings.get("admissionPolicyVersion"), 10) || 1),
      set: (v) => settings.set("admissionPolicyVersion", String(v)),
    },
  });
  // 导入导出（契约 4.3）：备份放在 <SHIPHERD_HOME>/backups。
  const configBackupDir = join(paths.home, "backups");
  const configRegistry = defaultRegistry();
  /** 导入配置之后（PR 策略可能变了）：工作流 G 接好以后换成重算就绪和风险。 */
  let afterConfigApplied = (): void => undefined;
  const configIo = new ConfigIoService({
    db, repo: lessonsRepo, policies: admissionPolicies, recorder: batchRecorder, registry: configRegistry, shipherdVersion: app.getVersion(),
    backupDir: configBackupDir, now: Date.now, onExported: (at) => settings.set("configLastExportAt", String(at)), onApplied: () => (checkSnapshots.schedule(), routing.reloadConfig(), afterConfigApplied()), log: logger,
  });
  // 仓库现状（工作流 E2）：扫描在 worker 线程里跑；模型补全走路由的 repo_scan_infer（中档，撞限换下一个）。
  const repoLocalPath = (slug: string): string | null => lessonsRepo.repo(slug)?.localPath ?? null;
  const baselineService = new BaselineService({
    db, lessons: lessonsRepo, checks: checksService, localPath: repoLocalPath, runner: baselineWorkerRunner,
    infer: (req) => execHeadlessJson(judgeDeps, req), config: () => baselinesConfig(settings), lang: () => currentLang(), now: Date.now,
    onChanged: () => notify(), log: logger,
  });
  // 存量扫描：整个仓库跑一条检查；上次没跑完的（应用退出时）标成失败。
  const baselinesRepo = new BaselinesRepo(db);
  const legacyScans = new LegacyScanService({
    repo: baselinesRepo, checks: checksService, localPath: repoLocalPath, runner: baselineWorkerRunner,
    config: () => ({ maxFiles: baselinesConfig(settings).legacyMaxFiles, ...checksConfig(settings) }), now: Date.now, onChanged: () => notify(), log: logger,
  });
  try {
    legacyScans.recover();
  } catch (e) {
    logger("legacy scan: recovering interrupted scans failed", e);
  }
  // 自动化档位（BTL-247）：全局档位套用时写受管开关；epic 自己选了档位时盖在原来的开关上。
  // 三族策略和「设置变了以后该跑的」在后面才建好，先占位，registerIpc 之前接上（只有选档位时才用到）。
  const automationHooks: { policy: Pick<FeaturePolicyDeps, "globalLayer" | "writeLayer"> | null; settingChanged: (key: EditableSettingKey) => void } = {
    policy: null,
    settingChanged: () => {},
  };
  const automation = new AutomationLevels({
    setting: (k) => settings.get(k),
    writeSetting: (k, v) => {
      settings.set(k, v);
      automationHooks.settingChanged(k);
    },
    globalLayer: (f) => {
      if (!automationHooks.policy) throw new Error("automation: policies are not ready");
      return automationHooks.policy.globalLayer(f);
    },
    writeLayer: (f, l) => {
      if (!automationHooks.policy) throw new Error("automation: policies are not ready");
      automationHooks.policy.writeLayer(f, l);
    },
    layers: () => readGovernedLayers(db, (id) => lessonsRepo.product(id)?.name ?? null),
    featureLevel: (id) => features.automationLevel(id),
    ticketFeature: (k) => tickets.get(k)?.featureId ?? null,
    log: logger,
  });
  // 对外动作（契约 4.8，ws-b）：开关和审计的框架；接入的 workstream 用 externalActions.attempt（现在是导出成 lint 的推送分支和开 PR）。
  const externalAudit = new ExternalAuditRepo(db);
  const externalActions = new ExternalActions({
    repo: externalAudit,
    setting: (key) => settings.get(key),
    // epic 自己选了档位：受管的对外开关按那一档（BTL-247）；其他照旧看全局设置。
    layered: (key, scope) => automation.external(key, scope.ticketKey),
    now: Date.now,
    cutoff: (now) => auditCutoff(now, auditRetentionDays(settings)),
    log: logger,
  });
  // 更新提示（BTL-253）：每天最多一次经你的 gh 查 GitHub 上的最新 release，只提示不下载。每次查询记进审计（只读，没有对外开关）。
  const updateChecker = new UpdateChecker({
    current: app.getVersion(),
    settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) },
    ghAvailable: () => ghAvailable(),
    fetchLatest: () => latestRelease(),
    audit: (e) => void externalActions.record("update_check", { target: e.target, summary: e.summary, outcome: e.outcome, error: e.error }),
    now: Date.now,
    notify: () => notify(),
    log: logger,
    ready: () => healthReady.then(() => ghProbed),
    text: () => ({ found: M().update.auditFound, failed: M().update.auditFailed, reasons: M().update.reasons }),
  });
  const openRelease = (): void => {
    const cached = updateChecker.latestUrl();
    void shell.openExternal(cached && isShipherdReleaseUrl(cached) ? cached : releasesLatestUrl());
  };
  // 应用菜单（BTL-253 / 254）：标准几项加「帮助」。「检查更新…」在主进程查，再让界面打开设置 › 关于看结果（不弹原生对话框）。
  const menuAction = (action: AppMenuAction): void => {
    showWindow();
    safeSend(IPC.appMenu, action);
  };
  const installAppMenu = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({
      platform: process.platform,
      help: [
        { label: M().menu.checkUpdates, click: () => { menuAction("checkUpdates"); void updateChecker.checkNow(); } },
        { type: "separator" },
        { label: M().menu.sendFeedback, click: () => menuAction("sendFeedback") },
      ],
    })));
  };
  installAppMenu();
  onLangChange(installAppMenu);
  // 导出成 lint：写进 <SHIPHERD_HOME>/exports/<id> 的 worktree 就停；推送和开 PR 只经对外动作开关（契约 4.8），做没做都记进审计。
  const checkExporter = new CheckExporter({
    repo: baselinesRepo,
    check: (slug, key) => {
      const c = checksService.resolvedFor(slug, key);
      return c ? { ...c, checkId: c.id } : null;
    },
    baseline: (slug) => baselineService.latest(slug), localPath: repoLocalPath, exportsDir: join(paths.home, "exports"),
    outward: externalActions, ticketPattern: () => checksConfig(settings).ticketPattern, now: Date.now,
    openPr: (req) => createPr(req), openPath: (dir) => void shell.openPath(dir), onChanged: () => notify(), log: logger,
  });
  // 上次跑到一半退出的导出：建了的 worktree 和分支收回去。
  void checkExporter.recover().catch((e) => logger("check export: recovering interrupted exports failed", e));
  /** 预审（工作流 G）开着吗；给了 ticket 时它所在的 epic 自己选的档位优先（BTL-247）。 */
  const preReviewActive = (ticketKey?: string | null): boolean => automation.preReview(ticketKey, settings.get("preReviewEnabled") === "1");
  /** 「完成前交证据」那一段的仓库：worktree 目录名和档案（导入的、没扫过的没有档案）。 */
  const guideRepos = (repoPaths: string[]): GuideRepo[] =>
    repoPaths.map((root) => {
      try {
        const slug = repoIdentity.slugOf(root);
        const b = slug ? baselineService.latest(slug) : null;
        return { name: basename(root), profile: b && b.origin !== "imported" ? b.profile : null };
      } catch (e) {
        logger("session guide: evidence profile failed", e);
        return { name: basename(root), profile: null };
      }
    });
  /** ticket session 的 guide 里的仓库档案：worktree 路径 → slug。 */
  const sessionProfile = (repoPaths: string[], hasLessons: boolean): string => {
    try {
      const repos = repoPaths.flatMap((root) => {
        const slug = repoIdentity.slugOf(root);
        return slug ? [{ slug, root }] : [];
      });
      return baselineService.guideProfile(repos, hasLessons);
    } catch (e) {
      logger("session guide: repo profile failed", e);
      return "";
    }
  };
  // 从规矩生成检查（任务 check_draft）：走模型路由（高档，撞限就等；没配置路由时和以前一样不带 --model）。提示里带上仓库现状（已有的命令和规则）。
  const checkDrafter = new CheckDrafter({
    lessons: lessonsRepo, checks: checksService, fallbackCwd: () => paths.home,
    run: (req) => execHeadlessJson(judgeDeps, req),
    baseline: (slugs) => baselineService.describeForPrompt(slugs),
  });
  const configBackups = new ConfigBackups({
    io: configIo, registry: configRegistry, jobs, repo: lessonsRepo, backupDir: configBackupDir, now: Date.now, log: logger,
    intervalDays: () => configBackupIntervalDays(settings), keep: () => configBackupKeep(settings), reminderDays: () => configExportReminderDays(settings),
    lastExportAt: () => {
      const v = Number(settings.get("configLastExportAt"));
      return Number.isFinite(v) && v > 0 ? v : null;
    },
  });
  const lessonRuns = new LessonRunsRepo(db);
  const repoIdentity = new RepoIdentity();
  // 带 hash 的 session 说明文件每次规矩变了就多一份，启动时清掉 30 天没用过的。
  pruneSessionGuides(paths.mcp, Date.now());
  pruneDrip(paths.lessonDrip, Date.now());
  const lessonRunner = new LessonRunner({
    repo: lessonsRepo, runs: lessonRuns, availability: lessonsGate, identity: repoIdentity, jobs,
    upgradeReady: () => routing.tierHealthy(routing.plan("lesson_analyze").route.tier as Tier),
    gh: { mergedPrs, prLessonDataDetail, compareFiles, available: () => ghAvailable() },
    headless: { ...judgeDeps },
    scheduler: bgScheduler,
    ticketForBranch: (slug, branch) => tickets.reposByBranch(branch).find((r) => repoIdentity.slugOf(r.repoPath) === slug)?.ticketKey ?? null,
    shipherdContext: async (key, wantTranscripts) => {
      const ps = handoffs.listByTicket(key, 20).flatMap((h) => (h.payload ? [h.payload] : []));
      const seen = new Set<string>();
      const transcripts: string[][] = [];
      if (wantTranscripts) {
        for (const s of sessions.listByTicket(key)) {
          for (const id of sessions.chainOf(s.id)) {
            if (seen.has(id)) continue;
            seen.add(id);
            const file = transcriptLocator.find(id);
            if (!file) continue;
            try {
              transcripts.push(await readTailLines(file, TRANSCRIPT_TAIL_BYTES));
            } catch {
              // 读不了的记录跳过。
            }
          }
        }
      }
      return { decisions: ps.flatMap((p) => p.decisions.map((d) => d.statement)), learnings: ps.flatMap((p) => p.learnings), transcripts };
    },
    lang: () => currentLang(), now: Date.now, notify: () => notify(), log: logger,
    // 复盘完了：review 效果里这个 PR 的评论来源归类（工作流 G）。reviewCollector 在下面才建好：回调里才用到。
    onRunDone: (slug, n) => void reviewCollector.retroDone(slug, n).catch((e: unknown) => logger("review effect: after a retro failed", e)),
    // lessonAdmission 在下面才建：分析完成时（启动之后）才用到。
    onLessonsChanged: (slug) => lessonAdmission.scheduleAuto(slug),
  });
  // 设置页「升级重跑」按钮；另外每小时看一次（档位恢复时路由的变化也会触发）。
  routing.rerunHook = () => void lessonRunner.requeueUpgrades(true);
  const upgradeTimer = setInterval(() => lessonRunner.requeueUpgrades(), 60 * 60_000);
  upgradeTimer.unref?.();
  // 规矩质量与自动准入（工作流 D）：模型判断的缓存，老规矩的补填。
  const lessonJudgments = new JudgmentCache(db);
  const lessonEnricher = new LessonEnricher({
    repo: lessonsRepo, runs: lessonRuns, recorder: batchRecorder, judgments: lessonJudgments,
    run: (req) => execHeadlessJson(judgeDeps, req),
    gh: { prLessonDataDetail, available: () => ghAvailable() },
    lang: () => currentLang(), now: Date.now, fallbackCwd: () => paths.home, log: logger,
  });
  // 回测、影子自动升级、自动降级、阈值复查（工作流 F）：后台队列的 backtest 任务；判误报走路由的 backtest_judge。
  const backtest = createBacktestStack({
    db, repo: backtestRepo, lessons: lessonsRepo, checks: checksService, batches: lessonBatches, policies: admissionPolicies,
    queue: bgQueue, jobs: bgRepo, gh: realBacktestGh(), evaluate: backtestWorkerEvaluator,
    run: (req) => execHeadlessJson(judgeDeps, req), judgments: lessonJudgments, lang: () => currentLang(),
    localPath: repoLocalPath, ticketPattern: () => checksConfig(settings).ticketPattern,
    legacy: { run: (checkId, slug) => legacyScans.run(checkId, slug) },
    lastReview: {
      get: () => Number.parseInt(settings.get("backtestThresholdReviewAt"), 10) || null,
      set: (at) => settings.set("backtestThresholdReviewAt", String(at)),
    },
    // 素材拿到了（或放弃了）：那个仓库排一次自动判，等接受的向导也重判（等着回测的规矩接着判）。两个都在下面才建，回调时才用。
    onMaterial: (slug) => {
      lessonAdmission.scheduleAuto(slug);
      lessonWizard.onMaterial();
    },
    record: (kind, data) => void recordEvent(kind, { data }),
    onChanged: () => notify(), onChecksChanged: () => checkSnapshots.schedule(),
    fallbackCwd: paths.home, now: Date.now, log: logger,
  });
  bgQueue.register("backtest", backtest.handler);
  // 准入流水线：判（四道闸门 + 打分 + 抽查 + 回测）、全部接受、改了分类以后重判；分析加了或命中了规矩时按设置自动判。
  const lessonAdmission = new AdmissionService({
    db, repo: lessonsRepo, recorder: batchRecorder, policies: admissionPolicies, judgments: lessonJudgments, runs: lessonRuns,
    checks: checksService, drafter: checkDrafter, batches: lessonBatches, run: (req) => execHeadlessJson(judgeDeps, req),
    backtest: backtest.service, metrics: backtest.metrics,
    // 仓库现有的检查（E2）：低置信的只算弱覆盖，不能单凭它搁置成「已覆盖」。
    coverage: {
      coveredBy: (q) => baselineService.coveredBy(q).map((c) => ({ label: `${c.slug}${c.dir ? `/${c.dir}` : ""}: ${c.check.tool}`, strength: c.check.confidence === "low" ? "weak" : c.strength })),
      describeForPrompt: (slugs, maxChars) => baselineService.describeForPrompt(slugs, maxChars),
    },
    lang: () => currentLang(), now: Date.now, fallbackCwd: () => paths.home, notify: () => notify(), log: logger,
    autoAdmitEnabled: () => settings.get("lessonsAutoAdmit") === "1",
    gateOpen: () => bgScheduler.gate("lesson_admission").run,
  });
  checksService.onLessonClassified((id, before, after, reason) => void lessonAdmission.onClassified(id, before, after, reason));
  const admissionCtx = () => ({ run: (req: Parameters<typeof execHeadlessJson>[1]) => execHeadlessJson(judgeDeps, req), judgments: lessonJudgments, lang: () => currentLang(), now: Date.now, cwd: paths.home, gate: OPEN_GATE });
  configIo.setLessonConflictDetector(importConflictDetector(admissionCtx, () => Number(admissionPolicies.resolve({ kind: "global" }).value["dedupe.maxGroup"])));
  // 初始化向导、校准页、原则（工作流 D 第 3 部分）。
  const lessonWizard = new WizardService({
    db, repo: lessonsRepo, admission: lessonAdmission, runner: lessonRunner, enricher: lessonEnricher, bulk: (verb, target) => lessonBatches.bulk(verb, target),
    backtest: backtest.service.wizardRunner,
    scanner: {
      scan: async (slug) => {
        const r = await baselineService.scan(slug, { infer: false });
        return r.status === "ok" || r.status === "partial" || r.status === "unchanged" ? { noLint: baselineService.checksByCategory(slug, "lint").length === 0 } : null;
      },
    },
    now: Date.now, notify: () => notify(), log: logger, policyVersion: () => admissionPolicies.version(),
  });
  const calibration = new CalibrationService({
    db, repo: lessonsRepo, policy: () => admissionPolicies.resolve({ kind: "global" }).value, now: Date.now,
    calibratedAt: () => settings.get("admissionCalibratedAt"), setCalibratedAt: (v) => settings.set("admissionCalibratedAt", v),
  });
  const principles = new PrinciplesService({ db, repo: lessonsRepo, recorder: batchRecorder, pipeline: lessonAdmission.pipeline, ctx: admissionCtx, now: Date.now, log: logger });
  let principlesRunning = false;
  const regroupPrinciples = async () => {
    principlesRunning = true;
    notify();
    try {
      return await principles.regroup();
    } finally {
      principlesRunning = false;
      notify();
    }
  };
  const admissionFacade: AdmissionFacade = {
    state: () => ({
      runs: lessonWizard.list(),
      principles: { count: Number((db.prepare(`SELECT COUNT(*) AS n FROM lesson_principles`).get() as { n: number }).n), running: principlesRunning },
    }),
    estimate: (scope) => lessonWizard.estimate(scope),
    wizardAct: (a) => lessonWizard.act(a),
    calibrationSample: (scope) => calibration.sample(scope),
    calibrationStats: (since) => ({ ...calibration.stats(since), marks: since === null ? {} : calibration.marks(since) }),
    calibrationAct: (a) => (a.op === "markCalibrated" ? { ok: true, calibratedAt: calibration.markCalibrated() } : calibration.mark(a.lessonId, a.mark, a.since)),
    regroupPrinciples,
  };
  /** session 说明怎么挑规矩（BTL-274）：检查引擎开着、hook 装着时已转成检查的由检查管，不占说明的位置。 */
  const guideLessonOptions = () => ({
    principles: settings.get("lessonsPrinciples") === "1",
    core: settings.get("lessonsCoreGuide") === "1",
    checksActive: checksConfig(settings).enabled && health.hookBinCurrent() && existsSync(paths.hookBin),
    enforcedIn: (slug: string) => checksService.enforcedLessonIds(slug),
  });
  /** 这一层所在的仓库里，有哪个单独开 session 时全文装不下（BTL-274）。 */
  const layerOverBudget = (layer: MergeLayer): boolean => {
    const slugs = layer.kind === "repo" ? [layer.slug] : (lessonsRepo.product(layer.productId)?.slugs ?? []);
    const opts = guideLessonOptions();
    return slugs.some((slug) => planForSlug(lessonsRepo, slug, opts).overBudget);
  };
  // 合并相似规矩（BTL-274）：便宜档模型提建议，默认等你点一下；接受是一个能撤销的批次。
  const lessonMerges = new LessonMergeService({
    db, repo: lessonsRepo, recorder: batchRecorder, ctx: admissionCtx, now: Date.now, overBudget: layerOverBudget,
    auto: () => settings.get("lessonsMergeAuto") === "1", onChanged: () => notify(), log: logger,
  });
  // 复盘规矩页：仓库路径直接查表（已归档的 ticket、feature 不算）；归组建议按 ticket 和 feature 各算一组。
  const repoPathRows = <T extends { repo_path: string }>(sql: string): T[] => db.prepare(sql).all() as unknown as T[];
  const lessonsService = new LessonsService({
    repo: lessonsRepo, batches: lessonBatches, runs: lessonRuns, availability: lessonsGate, identity: repoIdentity, runner: lessonRunner, enricher: lessonEnricher, admission: lessonAdmission,
    knownRepoPaths: () => [
      ...new Set(
        repoPathRows<{ repo_path: string }>(
          `SELECT tr.repo_path FROM ticket_repos tr JOIN tickets t ON t.key = tr.ticket_key WHERE t.archived_at IS NULL
           UNION SELECT fr.repo_path FROM feature_repos fr JOIN features f ON f.id = fr.feature_id WHERE f.archived_at IS NULL`,
        ).map((r) => r.repo_path),
      ),
    ],
    repoGroups: () => {
      const groups = new Map<string, Set<string>>();
      for (const [kind, sql] of [
        ["t", `SELECT tr.ticket_key AS k, tr.repo_path FROM ticket_repos tr JOIN tickets t ON t.key = tr.ticket_key WHERE t.archived_at IS NULL`],
        ["f", `SELECT fr.feature_id AS k, fr.repo_path FROM feature_repos fr JOIN features f ON f.id = fr.feature_id WHERE f.archived_at IS NULL`],
      ] as const) {
        for (const r of repoPathRows<{ k: number | string; repo_path: string }>(sql)) {
          const key = `${kind}:${r.k}`;
          (groups.get(key) ?? groups.set(key, new Set()).get(key)!).add(r.repo_path);
        }
      }
      return [...groups.values()].map((g) => [...g]);
    },
    ghAvailable: () => ghAvailable(), openExternal: (url) => void shell.openExternal(url), now: Date.now, notify: () => notify(), log: logger,
    guideOptions: guideLessonOptions,
    merges: {
      pending: () => lessonMerges.pending(),
      running: () => lessonMerges.running(),
      failed: () => lessonMerges.failed(),
      auto: () => settings.get("lessonsMergeAuto") === "1",
      accept: (id) => lessonMerges.accept(id),
      dismiss: (id) => lessonMerges.dismiss(id),
      // 规矩页的按钮：用户亲手点的，退避中的块也马上再问。
      suggest: (slug) => void lessonMerges.suggest(slug, { force: true }).catch((e: unknown) => logger("lessons: merge suggestion failed", e)),
    },
    // writeRunFile 写不了会同步抛出：LessonsService 接住，记日志，返回 write_failed。sessionService 在下面才建好：调用时才用到。
    openRun: (d, repoPath) => {
      const file = writeRunFile(paths.lessonsWorkspace, d, currentLang());
      return sessionService.openLessonRun({ runId: d.id, repoPath, file, label: `lesson run ${d.id}` });
    },
  });
  /** 休眠前最后一次看到的样子：休眠的 session 照样留在「需要你」里（活动监视只看开着的终端）。 */
  const needsYouFrozen = new Map<string, NeedsYouHead>();
  /** 开着终端的 Shipherd session 的 head（同一个 head 只算一次），带上活动和最后一条回复。activityMonitor 在下面才建好：调用时才用到。 */
  /** 靠屏幕证据校正成停着的（BTL-269 B）：「需要你」照样判断它最后那条回复。 */
  const healedTurns = new HealedTurns();
  const needsYouHeads = (): NeedsYouHead[] => {
    const heads = new Map<string, NeedsYouHead>();
    for (const termId of pty.openIds()) {
      const h = sessions.head(termId);
      // 复盘分析 session 只是用户来问问题的，不判断需要你。
      if (!h || h.origin !== "shipherd" || h.lessonRunId !== null || heads.has(h.id)) continue;
      heads.set(h.id, { id: h.id, cwd: h.cwd, waiting: h.waitingForInput, kind: healedTurns.kindFor(h.id, h.waitingForInput, activityMonitor.get(h.id)?.kind ?? null), reply: activityMonitor.lastReplyOf(h.id) });
    }
    const hibernated = new Set(hibernatedHeads().map((h) => h.id));
    for (const id of [...needsYouFrozen.keys()]) if (!hibernated.has(id) || heads.has(id)) needsYouFrozen.delete(id);
    for (const [id, h] of heads) if (h.kind !== null) needsYouFrozen.set(id, h);
    for (const id of hibernated) {
      const frozen = needsYouFrozen.get(id);
      if (frozen && !heads.has(id)) heads.set(id, frozen);
    }
    return [...heads.values()];
  };
  // 「需要你」（计划 14）：停下来的 session 是不是在等用户。判断最多等 1 分钟（默认的 5 分钟会一直占着名额）。
  // 判断完只发 stateChanged（不经过下面 activityMonitor 的 notify），所以 update → notify 不会再回到 update。
  const needsYou = new NeedsYouTracker({
    // 判断的花费算到这个 session 的 ticket 上（工作流 L）。
    judge: (reply, cwd, sessionId) => judgeNeedsYou({ ...judgeDeps, timeoutMs: 60_000 }, reply, cwd, sessions.head(sessionId)?.ticketKey ?? null),
    sessions: needsYouHeads,
    notify,
    onNeedsYou: (id, replyId, category) => {
      try {
        interrupts.needsYou(id, replyId, category);
      } catch (e) {
        logger("metrics: recording a needs-you interrupt failed", e);
      }
      waitTracker.sync();
    },
    log: logger,
  });
  const activityMonitor = new ActivityMonitor({
    sessions, tickets, features, pty, hub: transcriptHub,
    transcriptFile: (id) => transcriptLocator.find(id),
    // 子孙进程的 CPU 从和内存采样共用的进程表里读（BTL-275）：原来每个 session 每次探测各起一个 ps。
    procTree: (() => {
      const freshTable = timedProcTable(() => readProcTable(process.platform), Date.now);
      return procTreeFrom(() => (procs ? procs.table() : freshTable()), process.platform, freshTable);
    })(),
    judge: (input) => judgeStuck(judgeDeps, input, input.sessionId ? (sessions.head(input.sessionId)?.ticketKey ?? null) : null),
    // 活动变了：先看停下来的 session 有没有新回复要判断、有没有该自动换新的，再刷新界面。
    // 换新自己的 notify 只发 stateChanged（不回到这里），所以 autoCheck → notify 不会再回到 autoCheck。
    // 只是输出、工具调用变了（quiet）时只发限频的 output（BTL-242）：ticket 速览跟着它刷新，别的界面不重取；工具调用另外推给实况窗口；主进程里的后续照常跑。
    notify: (change) => {
      needsYou.update();
      refresher.autoCheck();
      waitTracker.sync();
      if (change === "visible") notify("activity");
      else outputChanged();
    },
    // 卡住不再弹系统通知（之后在「现在」页里显示）：只刷新界面，记一次打断（ws-h）。
    onStuck: (info) => {
      interrupts.stuck(info.sessionId, info.ticketKey);
      notify("activity");
    },
    now: Date.now,
    intervals: activityIntervals(process.env),
    // 实况窗口（BTL-190 第 7 点）：新的工具调用、记忆读写直接推给界面。
    onEvent: (e) => safeSend(IPC.activityEvent, e),
    // transcript 显示这一轮没经过 Stop 就结束了（Esc 打断、API / 限额错误）：Claude Code 不触发 Stop，不记成在等输入的话，
    // 之后往里发消息、闲置自动关闭都认为它还在忙。at 之后已经有输入（UserPromptSubmit）就不动。
    onTurnEnd: (id, at) => onTurnEndedWithoutStop({ sessions, notify, stopped: sessionStopped }, id, at),
    onLimit: (id, hit, at) => {
      availability.report({ ...hit, at, source: "session", job: null, sessionId: id });
      // 配置了路由：把撞限记到这个 session 的模型上（usage_limit 一般是整个账号的）。
      try {
        // 换模型之前的那条报错（恢复后又被读到）不再记到新模型上。
        if (!switcher.staleHit(id, at)) {
          routing.onSessionLimit(sessions.head(id)?.model ?? null, hit, hit.kind === "usage_limit");
          switcher.noteLimit(id, hit, at);
        }
      } catch (e) {
        logger("routing: recording a session limit failed", e);
      }
    },
    log: logger,
  });
  /**
   * 把任务作为第一条消息交给新 session：总控开的子 session 和修复 session 都走这里。
   * 启动对话框（比如新 worktree 里的「New MCP server found」）没人回答时一直等（waitOutDialogs），任务不丢；
   * 这期间「轮到你」页面上有这个 session 的「等你回答启动询问」（activity 的 prompt: "startup"）。
   */
  const submitTask = (termId: string, message: string) => pty.deliver(termId, message, { singleLine: process.platform === "win32", waitOutDialogs: true });
  /** 装着的 shipherd-hook 是当前版本：只有这时才挂 gate / check hook。 */
  const hookInstalled = () => health.hookBinCurrent() && existsSync(paths.hookBin);
  /** 这次启动的 session 为什么跑不了检查（addendum 第 7 节）；没有打开的检查就不算缺。 */
  const checksAbsence = (): CheckAbsenceReason | null => {
    if (!checksService.anyEnabled()) return null;
    if (!checksConfig(settings).enabled) return "disabled";
    if (!hookInstalled()) return "hook_outdated";
    const st = readSnapshotState(paths.checksSnapshot, CHECKS_SNAPSHOT_VERSION);
    return st === "ok" ? null : st === "version" ? "snapshot_version" : "no_snapshot";
  };
  // 打断减少（ws-j）：第一次有功能生效的时间，Effect 页前后对比的分界。只写一次。
  const markInterruptEffective = (at: number): void => {
    if (!settings.get("interruptReductionSince").trim()) settings.set("interruptReductionSince", String(at));
  };
  // 权限档案（ws-j 设计 2）：从本机的 transcript 算候选，确认过的只读规则写进 session 的 --settings。
  const profiles = new PermissionProfileService({
    repo: new PermissionProfileRepo(db), projectsDir: paths.claudeProjects, slugOf: (p) => repoIdentity.slugOf(p), exec: judgeDeps,
    workDir: () => paths.home, setting: (k) => settings.get(k), now: Date.now, markEffective: markInterruptEffective, log: logger,
  });
  const profileHits = new ProfileHitCounter({
    transcriptOf: (id) => transcriptLocator.find(id),
    builtIn: SESSIONS_AUTO_ALLOW,
    recordEvent,
  });
  /** 这个 session 有 transcript（SessionService 判断能不能 --resume、ForkService 判断能不能完整分叉共用）。 */
  const transcriptExists = (id: string): boolean => transcriptLocator.state(id) !== "absent";
  const sessionService = new SessionService({
    knownModel: routing.registered,
    tickets, sessions, settings, ticketService, pty, blocks,
    activity: (id) => activityMonitor.get(id),
    sessionName: (id) => sessionRegistryName(paths.claudeSessions, id),
    submit: submitTask,
    // mergeGate 也在后面才建好。
    dirBusy: (repo): Promise<{ ticket: string; branch: string } | null> => mergeGate.dirBusy(repo),
    ready: () => healthReady,
    transcriptExists,
    transcriptState: (id) => transcriptLocator.state(id),
    claude: () => health.claude(),
    newId: randomUUID,
    now: Date.now,
    platform: process.platform,
    baseEnv: process.env,
    mcpConfig: memoryMcpConfig,
    // 装着的 shipherd-hook 是旧版本（不认 gate）时不挂 gate hook：旧程序会把每条 Bash 命令当成普通 hook 事件写进收件箱。
    mcpSettings: (dirs, sessionId) => {
      const cc = checksConfig(settings);
      // 给这个 session 的档案规则记下来：省掉了几次确认只按这些、只从现在起算。
      const profileRules = profiles.rulesForDirs(dirs);
      profileHits.spawned(sessionId, profileRules, Date.now());
      return projectMcpApprovalSettings(dirs, {
        claudeJson: paths.claudeJson, claudeSettings: paths.claudeSettings, mcpDir: paths.mcp, log: logger, allowTools: SESSIONS_AUTO_ALLOW,
        profileRules,
        gateCommand: hookInstalled() ? hookCommand(paths.hookBin, process.platform) : undefined,
        mailboxCommand: hookInstalled() ? mailboxHookCommand(hookCommand(paths.hookBin, process.platform), paths.mailbox, process.platform) : undefined,
        lessons: hookInstalled()
          ? { command: lessonsHookCommand(hookCommand(paths.hookBin, process.platform), paths.lessonDrip, process.platform), resetCommand: lessonsResetCommand(hookCommand(paths.hookBin, process.platform), paths.lessonDrip, process.platform) }
          : undefined,
        checks: cc.enabled ? { editTimeoutSec: cc.editTimeoutSec, pushTimeoutSec: cc.pushTimeoutSec } : undefined,
      });
    },
    checksAbsence,
    guidePath: (kind, repoPaths, ticketKey, session) => {
      // 规矩按大小装（BTL-274）：全文写得下的写全文，其余列索引、写进旁边的全文文件、编辑时补送；已转成检查的由检查管。
      const plan = kind === "ticket" ? safeGuidePlan(lessonsRepo, repoIdentity, repoPaths, logger, guideLessonOptions()) : null;
      const lessons = plan?.full ?? [];
      // 说明里写不写「编辑时补送」，看清单是不是真的写出来了。
      const drip = session
        ? prepareSessionDrip({
            hookInstalled: hookInstalled(), dir: paths.lessonDrip, sessionId: session.termId, log: logger,
            manifest: () => (plan ? dripManifest(lessonsRepo, plan, dripRoots(repoIdentity, session.editDirs), currentLang()) : null),
          })
        : false;
      const preReview = kind === "ticket" && preReviewActive(ticketKey);
      return writeSessionGuide(paths.mcp, currentLang(), kind, lessons, {
        index: plan ? { rows: plan.index, more: plan.indexMore, rest: plan.rest } : undefined,
        lessonsTool: kind === "ticket" && !!ticketKey,
        drip,
        // 预审（工作流 G）打开时：规矩段那句「PR 前会自动预审」，加上「完成前交证据」一段（按仓库档案列命令）。
        preReview,
        extra: [
          ...(kind === "ticket" ? watcherGuideLines(currentLang(), repoPaths) : []),
          ...(kind === "ticket" && preReview ? evidenceGuideLines(currentLang(), guideRepos(repoPaths)) : []),
          ...interruptGuideLines(currentLang(), kind, { choiceRule: settings.get("interruptChoiceRule") === "1", selfServe: settings.get("interruptSelfServe") === "1" }),
        ],
        profile: kind === "ticket" ? sessionProfile(repoPaths, lessons.length > 0 || (plan?.rest.length ?? 0) > 0) : "",
      });
    },
    featureMcpConfig,
    shipherdWorkspace: paths.shipherdWorkspace,
    shipherdMcpConfig,
    lessonsWorkspace: paths.lessonsWorkspace,
    features, featureHandoffs, handoffs,
    // 打开 session 时补同步这个 ticket（最终审查 6）：上次同步失败、或记忆刚打开过，claude 不会读到旧的记忆。走同步队列，失败只写日志。
    syncMemory: (key) => void memory.syncTicket(key),
    opened: (termId) => {
      hibernator?.opened(termId);
      // 又打开了（用户点开、总控、后台恢复）：不再算用户结束，恢复失败的记录也清掉（BTL-256）。
      const h = sessions.head(termId);
      if (h?.userEndedAt != null) sessions.setUserEnded(h.id, null);
      resumer?.opened(termId);
    },
    hidden: (id) => {
      hibernator?.forget(id);
      // 移走的 session 不再留巡检的记录（BTL-279 第四轮复核）。
      patrolTurns.forget(sessions.head(id)?.id ?? id);
    },
    recordEvent,
    log: logger,
  });
  // 交互 session 撞限后「换下一档继续」（3.0 模型路由）：按 session 的种类用 --resume 重新打开。
  const switcher = new SessionModelSwitcher({
    head: (id) => sessions.head(id),
    setModel: (id, model) => sessions.setModel(id, model),
    termIdOf: (id) => sessionService.termIdOf(id),
    kill: (termId) => pty.kill(termId),
    running: (termId) => pty.isOpen(termId),
    reopen: (h) => {
      if (h.shipherd) return sessionService.openShipherd({ sessionId: h.id });
      if (h.ticketKey) return sessionService.open({ ticketKey: h.ticketKey, sessionId: h.id });
      if (h.featureId !== null) return sessionService.openFeature({ featureId: h.featureId, sessionId: h.id });
      return Promise.resolve({ ok: false, reason: "no_session" } as const);
    },
    nextModel: (m) => routing.nextModel(m),
    autoSwitch: () => routing.autoSwitch(),
    now: Date.now, onChange: () => notify(), log: logger,
    onSwitched: (id, from, to) => routing.event("session_switch", { model: from, toModel: to, detail: id }),
  });
  // 上次退出时终端还开着（退出事件来得比关数据库晚）：那时没删掉的空 session 在这里补删。
  try {
    const pruned = sessionService.pruneEmptySessions();
    if (pruned > 0) logger(`pruned ${pruned} empty session(s) left from the last quit`);
  } catch (e) {
    logger("pruning empty sessions failed", e);
  }
  // 上次退出（或崩溃）时开着终端的 session（BTL-256）：读完清掉，「重启后自动恢复」开着时启动完再恢复它们。
  const openAtLastQuit = sessions.takeTermOpen();

  const transcriptMtime = (id: string): number | null => {
    const file = transcriptLocator.find(id);
    if (!file) return null;
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };
  const cleanupDeps = { tickets, ticketService, repoBusy: (k: string, id: number) => sessionService.hasRepoTerminal(k, id), now: Date.now };
  /** PR 合并后清理 ticket 的 worktree（设计文档 2026-10-26）：不阻塞调用方，结果只影响 ticket 页的显示。 */
  function cleanupMerged(ticketKey: string): void {
    cleanupIfMerged(cleanupDeps, handoffs, ticketKey).then(
      (out) => {
        if (out.some((o) => o.result !== "skipped")) {
          logger(`worktree cleanup for ${ticketKey}: ${out.map((o) => `${o.repoId}=${o.result}`).join(", ")}`);
          notify();
        }
      },
      (e: unknown) => logger(`worktree cleanup for ${ticketKey} failed`, e),
    );
  }
  const ingest = (input: IngestInput) => {
    const r = ingestHandoff(
      { db, tickets, handoffs, followups, now: Date.now, newFollowupId: () => `f_${randomBytes(4).toString("hex")}`, linkPrs: (k, prs) => void prLinker.linkHandoffPrs(k, prs), linkedOpen, givenUpPrs, shipherdClosedPrs, foreignPr },
      input,
    );
    // 设计文档 5.4：入库后同步写入 StateCore（异步，失败只记日志）。
    if (r.stored && !r.degraded) {
      void memory.syncTicket(input.ticketKey);
      cleanupMerged(input.ticketKey);
    }
    return r;
  };
  // 升级前就已经合并的 ticket（包括已归档的：堆在磁盘上的大多是它们）：启动时补清理一次。
  // 等登录 shell 的 PATH 生效之后再跑，否则 GUI 进程的 PATH 里找不到 git，每个 ticket 都会被记成“git 操作失败”。
  void healthReady.then(() => {
    for (const t of tickets.list({ includeArchived: true })) cleanupMerged(t.key);
  });
  const projectMcp = (cwd: string): string[] =>
    projectMcpConfigs(cwd, { claudeJson: paths.claudeJson, claudeSettings: paths.claudeSettings, mcpDir: paths.mcp, log: logger });
  /** 一个 session 存下的累计花费（BTL-239）：分叉讨论的第一轮、handoff、feature 汇总都是从开发 session 分出来的，记 T1 − 它。 */
  const costBase = (id: string) => transcriptCostBase(paths.claudeProjects, id);
  const runner = new HandoffRunner({
    tickets, sessions, handoffs, followups, settings, ingest,
    // ticketPrs 在后面才建；早间刷新时早就有了。
    ticketPrs: { byTicket: (key) => ticketPrs.byTicket(key) },
    dirs: (t) => ticketService.headlessDirs(t),
    run: runHeadless,
    ready: () => healthReady,
    claude: () => health.claude(),
    baseEnv: process.env,
    transcriptMtime,
    now: Date.now,
    newRunId: randomUUID,
    projectMcp,
    signal: headlessAbort.signal,
    onUsage: recordHeadlessUsage,
    ...availabilityHooks,
    routing,
    costGate,
    costBase,
    log: logger,
  });
  /** feature 汇总入库（设计文档 2026-10-28）：存下有效的汇总后写进 feature 的记忆（异步，失败只记日志），界面刷新。 */
  const ingestFeature = (input: FeatureIngestInput) => {
    const r = ingestFeatureHandoff({ features, tickets, featureHandoffs, now: Date.now }, input);
    if (r.stored && !r.degraded) void memory.syncFeature(input.featureId);
    if (r.stored) notify();
    return r;
  };
  const featureRunner = new FeatureSummaryRunner({
    features, tickets, handoffs, featureHandoffs, settings, sessions,
    ingest: ingestFeature,
    ticketRunner: runner,
    dirs: (id) => ticketService.featureHeadlessDirs(id),
    run: runHeadless,
    ready: () => healthReady,
    claude: () => health.claude(),
    baseEnv: process.env,
    transcriptMtime,
    // prWatcher、turnService 在下面才建：只在生成汇总、判断过期时（启动之后）才调。
    livePrs: (key): WatchedPr[] => prWatcher.statusOf(key),
    prTurns: (): ((url: string, ticketKey?: string) => Turn | null) => turnService.prTurns(),
    now: Date.now,
    newRunId: randomUUID,
    projectMcp,
    signal: headlessAbort.signal,
    onUsage: recordHeadlessUsage,
    ...availabilityHooks,
    routing,
    costBase,
    log: logger,
  });
  /**
   * 总控里的 /handoff 之后（后台）：存下了汇总就给子 ticket 跑 handoff；没存下（用户自己开的总控没有 Shipherd 的 MCP，
   * 输出了 ticket 代码块或没有代码块）就由 Shipherd 从那个 session fork 出来自己生成汇总。见 featureCommandFollowup。
   */
  const featureFollowup = featureCommandFollowup(featureRunner, { notify, log: logger });
  /** 换新时 feature 总控的 /handoff 只收总控自己的汇总，不往下带动 ticket，也不 fork 总控（计划 16）。refresher 在后面才建好。 */
  const afterFeatureCommand = (featureId: number, handoffId: number | null, sessionId: string): void => {
    if (refresher.isRefreshing(sessionId)) {
      logger(`/handoff in feature ${featureId} coordinator session ${sessionId} during a refresh: no ticket handoffs, no fallback summary`);
      return;
    }
    featureFollowup(featureId, handoffId, sessionId);
  };
  // 外部通知（ws-j 设计 7）：开关是对外动作 push_notification，默认关；地址加密存，只有 notify/webhook.ts 发。
  const webhookStore = new WebhookStore({ secrets: new SecretsRepo(db), box: electronSecretBox, now: Date.now, log: logger });
  const notificationLog = new NotificationLogRepo(db);
  // 审计页两张表的启动收尾：按保留期各清理一次（之后有新记录写入时也会清理）。
  try {
    const cutoff = auditCutoff(Date.now(), auditRetentionDays(settings));
    externalAudit.prune(cutoff);
    notificationLog.prune(cutoff);
  } catch (e) {
    logger("audit housekeeping at startup failed", e);
  }
  notifier = new Notifier({
    actions: externalActions, log: notificationLog, webhook: webhookStore, post: (r) => sendWebhook(r),
    setting: (k) => settings.get(k), now: Date.now, cutoff: (now) => auditCutoff(now, auditRetentionDays(settings)),
    changed: notify, logError: logger,
  });
  // 选择（ws-j 设计 3）：session 按规则自己做的选择、按默认答案替你答的，都存着等你事后看。
  const choices = new ChoiceService({
    choices: new AutoChoicesRepo(db), defaults: new ChoiceDefaultsRepo(db), setting: (k) => settings.get(k), recordEvent, now: Date.now,
    markEffective: markInterruptEffective, notify,
  });
  const interruptsFacade = new InterruptsFacade({ profiles, choices, webhook: webhookStore, notifier, log: notificationLog });
  const dailyDeps: DailyJobDeps = {
    runner,
    features: featureRunner,
    isWorkingDay: () => isWorkingDay(localDate(Date.now()), scheduleConfig(settings).workingDays),
    hasTrackerTools: () => trackerTools(settings).length > 0,
    aborted: () => headlessAbort.signal.aborted,
    log: logger,
  };
  const scheduler = new Scheduler({
    jobs,
    config: () => scheduleConfig(settings),
    now: Date.now,
    userActive: () => powerMonitor.getSystemIdleTime() < ACTIVE_IDLE_SECONDS,
    nightly: () => nightlyJob(dailyDeps),
    morning: () => morningJob(dailyDeps),
    onChange: notify,
    log: logger,
  });
  /**
   * 退出开始后不再发起新的调度任务。Shipherd 总控的每日巡检（BTL-190 第 5 点）用同样的触发时机，但不排进 Scheduler 的链：
   * 它可能要等 session 停下来，不能挡住晚间 handoff。shipherdPatrol 在下面才建好：调用时才用到。
   */
  /** 度量的每日 gh 任务（ws-h）：要等 ticketPrs 建好，在下面赋值。 */
  let metricsGhJob: MetricsGhJob | null = null;
  const upkeepKey = { regroup: "lessonsPrinciplesRegroupedAt", merge: "lessonsMergeSuggestedAt" } as const;
  const upkeep = new LessonUpkeep({
    gateOpen: () => bgScheduler.gate("lesson_admission").run,
    tight: () => {
      const opts = guideLessonOptions();
      return lessonsRepo.repos().some((r) => planForSlug(lessonsRepo, r.slug, opts).overBudget);
    },
    principlesOn: () => settings.get("lessonsPrinciples") === "1",
    lastAt: (job) => Number(settings.get(upkeepKey[job])) || 0,
    setLastAt: (job, at) => settings.set(upkeepKey[job], String(at)),
    regroup: () => regroupPrinciples(),
    mergeRunning: () => lessonMerges.running(),
    suggest: () => lessonMerges.suggest(),
    log: logger,
  });
  const lessonUpkeep = () => upkeep.tick(Date.now());
  const checkSchedule = (trigger: ScheduleTrigger) => {
    if (headlessAbort.signal.aborted) return Promise.resolve();
    void shipherdPatrol.check();
    void lessonRunner.daily().catch((e: unknown) => logger("lessons: daily pull failed", e));
    void metricsGhJob?.daily().catch((e: unknown) => logger("metrics: daily gh job failed", e));
    // 栈（工作流 K）：每分钟看一遍要不要 fetch、rebase；每天一次清备份、对总览。
    void stackService.tick().catch((e: unknown) => logger("stacks: tick failed", e));
    void stackService.dailyJob().catch((e: unknown) => logger("stacks: daily job failed", e));
    // 原则重新分组、找相似规矩（BTL-274）：设置 lessonsPrinciples 开着时每天一次；有仓库单独开 session 全文装不下时，不管设置开没开，每小时看一次。
    // 规矩没变时读缓存，不调模型。走「规矩准入」的后台闸门：闸门关着这次不做，下一轮再看。
    lessonUpkeep();
    if (configBackups.tick()) notify();
    return scheduler.check(trigger);
  };

  const detectTrackerTools = async () => {
    await healthReady;
    const { path, pathValue } = health.claude();
    if (!path) throw new Error(M().claudeMissingCheck);
    // MCP 可以按项目配置：有 ticket 时在第一个 ticket 的目录里探测。
    const first = tickets.list().find((t) => t.repos.length > 0)?.repos[0];
    const cwd = first ? ticketService.workDir(first) : homedir();
    return probeMcpTools({
      claudePath: path,
      cwd,
      env: headlessEnv(process.env, { pathValue, runId: randomUUID() }),
      signal: headlessAbort.signal,
      mcpConfigs: settings.get("headlessProjectMcp") === "1" ? projectMcp(cwd) : [],
    });
  };

  /** 已经读齐的 transcript 开头（见 scanClaudeProjects）。 */
  const discoveryHeads: HeadCache = new Map();
  const discoverOnce = async () => {
    try {
      const found = await scanClaudeProjects(paths.claudeProjects, Date.now() - UNCLAIMED_WINDOW_MS, discoveryHeads);
      syncDiscovered(found, sessions, Date.now(), featureForCwd);
      // 只有扫描真的找到了某个待补全 session 的 transcript，才记为本次运行已扫描过。
      for (const f of found) if (discoveryPending.delete(f.id)) discoveryRequested.add(f.id);
      notify();
    } catch (e) {
      logger("discovery failed", e);
    }
  };
  let discovering = false;
  let discoverAgain = false;
  /** 同一时间只有一次扫描；扫描中又被触发（hook、定时器）就在结束后再扫一次。 */
  const runDiscovery = async (): Promise<void> => {
    // 「显示 Shipherd 之外开的 session」关着（默认）：完全不扫 ~/.claude/projects（BTL-244）。
    if (!outsideSessionsOn(settings)) return;
    if (discovering) {
      discoverAgain = true;
      return;
    }
    discovering = true;
    try {
      do {
        discoverAgain = false;
        await discoverOnce();
      } while (discoverAgain);
    } finally {
      discovering = false;
    }
  };

  /** 已由扫描补全过的 session（每次运行最多触发一次）。 */
  const discoveryRequested = new Set<string>();
  /** hook 触发、等待下一次扫描确认的 session。 */
  const discoveryPending = new Set<string>();
  /** 已经从目录读过分支的 session（每次运行最多一次，BTL-244）。 */
  const branchTried = new Set<string>();
  let hookDiscoveryTimer: NodeJS.Timeout | null = null;
  const scheduleDiscovery = () => {
    if (hookDiscoveryTimer || !outsideSessionsOn(settings)) return;
    hookDiscoveryTimer = setTimeout(() => {
      hookDiscoveryTimer = null;
      void runDiscovery();
    }, HOOK_DISCOVERY_DEBOUNCE_MS);
  };

  // 合并总控（设计文档 2026-11-04）。等待者记的是 SHIPHERD_SESSION（打开终端时的 id = termId）；Shipherd 重开过的终端用链上最新的 id，按 head 找回来。
  const gateRepo = new MergeGateRepo(db);
  const whoOf = makeWhoOf({ tickets, features });
  const gateTerm = (sessionId: string): string | null => {
    if (pty.isOpen(sessionId)) return sessionId;
    const head = sessions.head(sessionId)?.id;
    return head ? (pty.openIds().find((t) => sessions.head(t)?.id === head) ?? null) : null;
  };
  // BTL-269 B：记录说在干活（Stop hook 没来、transcript 没写结束）、屏幕上看已经停着的，凭屏幕、输出、transcript 的证据放行。
  const idleEvidence = new IdleEvidence({
    screen: (termId) => pty.screenLines(termId, { dropDim: true }),
    // 输入框空不空和草稿保护同一个判断（听写的暗字、NO_COLOR 的提示，审查疑点 i/ii）。
    boxEmpty: (termId, lines) => pty.inputBoxEmpty(termId, lines),
    lastOutputAt: (termId) => pty.lastOutputAt(termId),
    // 这一轮自己的输出（BTL-279）：后台任务的输出不算（dev server 一直在写日志，轮次早结束了）。
    // 活动没读到（没找到 transcript、没在跟踪）就只看屏幕和终端输出：之前当它「刚动过」，这样的 session 永远送不进去。
    // 刚打开的终端不怕：终端输出也要安静 45 秒，启动画面一直在画。
    transcriptGrewAt: (headId) => activityMonitor.turnOutputAt(headId),
    // SHIPHERD_IDLE_QUIET_MS 只给 e2e 用（丢了 Stop 的 session 要安静 45 秒才算停了，e2e 不想等）。
    quietMs: Number(process.env.SHIPHERD_IDLE_QUIET_MS) || undefined,
    now: Date.now,
  });
  // 所有自动输入共用的一道检查（计划 13）：停着等输入、屏幕上没有要回答的、用户没在打字、没有草稿才贴。
  const guardDeps: DeliveryGuardDeps = {
    // 成本熔断暂停着的不往里递，也不为了递东西叫醒它（工作流 L）。
    costPaused: (id) => costBreaker?.sessionPaused(id) ?? false,
    termOf: gateTerm,
    head: (id) => sessions.head(id),
    activity: (id) => activityMonitor.get(id),
    pty,
    // SHIPHERD_GATE_TYPING_QUIET_MS 只给 e2e 用（它刚在终端里打过字，不想多等 30 秒）。
    typingQuietMs: Number(process.env.SHIPHERD_GATE_TYPING_QUIET_MS) || undefined,
    // 休眠着的：叫它醒，醒来以后 sessionStopped 再递（WS-M B）。
    wakeIfHibernated: (id) => {
      if (!hibernator || !isHibernated(id)) return false;
      void hibernator.wake(id, "delivery");
      return true;
    },
    idle: (headId, termId) => idleEvidence.check(headId, termId),
    // 凭证据放行：记成在等输入（和没有 Stop 的轮次结束一样），通知界面；停下的后续（sessionStopped）放到这次检查之后，
    // 免得在 guard 里面又开始往同一个终端送别的。
    // 记录没动返回 false：guard 这一次直接放行，不再每次校正、每次 unsure（BTL-279；兜底，只在 head 对不上、时钟回拨时发生）。
    healed: (headId) => {
      if (!markTurnEndedWithoutStop(sessions, headId, Date.now())) return false;
      healedTurns.add(headId);
      logger(`delivery: ${headId} looked stopped on screen for a while though no Stop came; marking it waiting for input`);
      notify("data");
      setTimeout(() => sessionStopped(headId), 0);
      return true;
    },
    now: Date.now,
  };
  // 合并通知和 CI 结果用的：在等用户回答的 session 不往里贴东西（计划 14），「需要你」还没判断完的也先不贴（I1），
  // 正在换新的也不贴（计划 16）。refresher 在下面才建好：回调里才用到。
  /** 自动输入眼里的「需要你」：判断出来需要你、还没判断完，或者有未决的 ask_user。inboxService 在下面才建好：回调里才用到。 */
  const deliveryNeedsYouOf = (id: string): boolean => deliveryNeedsYou(needsYou, id) || inboxService.hasPendingDecision(id);
  /**
   * 它在等用户回答什么（BTL-269 A1/A2）：未答的 ask_user、判断出来的「需要你」（理由和那条回复的时间）。
   * 只是刚停下、还没判断完（undecided）、也没有未答 ask_user 的返回 null：不知道它是不是在问用户，总控的消息不当作回答。
   */
  const awaitingUserOf = (head: string): AwaitingUser | null => {
    const asks = inboxService.unansweredAsks(head);
    const reason = needsYou.reasonOf(head);
    if (asks.length === 0 && reason === null && needsYou.undecided(head)) return null;
    return { asks, text: reason === null ? null : { reason, at: activityMonitor.lastReplyOf(head)?.at ?? null } };
  };
  const deliveryGuard = new DeliveryGuard({
    ...guardDeps,
    // 有未决 ask_user 的也算在等用户（BTL-190 第 2+3 点）。inboxService 在下面才建好：回调里才用到。
    needsYou: (id): boolean => deliveryNeedsYouOf(id),
    refreshing: (id) => refresher.isRefreshing(id),
  });
  // 成本熔断（工作流 L，设计 addendum 第 4 节）。上限经三层配置；没设上限时什么都不做。
  const costPolicy = new CostPolicyService({
    db, now: Date.now,
    productsOf: (slug) => lessonsRepo.productsOf(slug),
    productName: (id) => lessonsRepo.product(id)?.name ?? null,
    onChange: () => costCheckSoon(),
  });
  const ticketRepoSlugs = (key: string): string[] =>
    tickets.listRepos(key).flatMap((r) => {
      const slug = repoIdentity.slugOf(r.repoPath);
      return slug ? [slug] : [];
    });
  const costTitleOf = (h: Session): string => {
    if (h.ticketKey) return `${h.ticketKey} ${tickets.get(h.ticketKey)?.title ?? ""}`.trim();
    if (h.featureId !== null) return features.get(h.featureId)?.name ?? `feature ${h.featureId}`;
    return "Shipherd";
  };
  const costSession = (root: string): CostSessionInfo | null => {
    const h = sessions.head(root);
    if (!h) return null;
    return {
      rootId: root, headId: h.id, ticketKey: h.ticketKey, title: costTitleOf(h), chainIds: sessions.chainOf(h.id),
      repos: h.ticketKey ? ticketRepoSlugs(h.ticketKey) : [], model: h.model, open: gateTerm(h.id) !== null,
    };
  };
  const costRepoInst = new CostRepo(db);
  try {
    const n = costRepoInst.pruneEvents(Date.now() - COST_EVENTS_RETENTION_MS);
    if (n > 0) logger(`cost: pruned ${n} old breaker event(s)`);
  } catch (e) {
    logger("cost: pruning old events failed", e);
  }
  const costBreakerInst = new CostBreaker({
    repo: costRepoInst, policy: costPolicy, usage: usageRepo, registry: () => routing.config().registry,
    warnPercent: () => Math.round(parseThresholds(settings.get("routingThresholds"))[0] * 100),
    rootOf: (id) => sessions.rootOf(id),
    session: costSession,
    ticket: (key) => {
      const t = tickets.get(key);
      if (!t) return null;
      const ids = new Set<string>();
      const open = new Set<string>();
      for (const s of sessions.listByTicket(key)) {
        for (const id of sessions.chainOf(sessions.head(s.id)?.id ?? s.id)) ids.add(id);
        const root = sessions.rootOf(s.id);
        if (root && gateTerm(s.id) !== null) open.add(root);
      }
      return { key, title: `${key} ${t.title ?? ""}`.trim(), repos: ticketRepoSlugs(key), sessionIds: [...ids], openRoots: [...open] };
    },
    active: () => {
      const roots = new Set<string>();
      const keys = new Set<string>();
      for (const termId of pty.openIds()) {
        const h = sessions.head(termId);
        if (!h || h.origin !== "shipherd") continue;
        const root = sessions.rootOf(h.id);
        if (root) roots.add(root);
        if (h.ticketKey) keys.add(h.ticketKey);
      }
      return { sessions: [...roots], tickets: [...keys] };
    },
    nextModel: (m) => routing.nextModel(m),
    switchModel: async (headId, model) => {
      const r = await switcher.switch(headId, model);
      return r.ok ? { ok: true, model: r.model } : { ok: false, reason: r.reason };
    },
    busy: (headId) => sessions.head(headId)?.waitingForInput === false,
    interrupt: (headId) => {
      const t = gateTerm(headId);
      // 不经 pty.write：那是用户输入的路，会把这次 Esc 记成用户接手了。
      if (t) pty.interrupt(t);
    },
    // 和休眠一样结束终端：之后点开会 --resume 接上。
    kill: (headId) => {
      const t = gateTerm(headId);
      if (t) pty.kill(t);
    },
    lastUserInputAt: (headId) => {
      const t = gateTerm(headId);
      return t ? pty.lastUserInputAt(t) : 0;
    },
    // 排进信箱（BTL-248）：同一条链新的一句换掉还没送的旧的。暂停中的 deliveryGuard 照样挡（cost_paused），也不叫醒。
    nudge: async (headId, text) => {
      mailbox.send({ kind: "cost", from: null, to: headId, featureId: null, body: sanitizeTask(text), ref: `cost:${sessions.rootOf(headId) ?? headId}` });
      return true;
    },
    scheduler: bgScheduler,
    texts: () => ({ continueAfterDowngrade: M().cost.continueAfterDowngrade, continueAfterRaise: M().cost.continueAfterRaise }),
    now: Date.now,
    onChange: () => costChanged(),
    // 每一步也记成 H 的度量事件（契约 4.7）；cost_events 表和日志照记。
    onEvent: costMetricEvents(recordEvent),
    log: logger,
  });
  costBreaker = costBreakerInst;
  /** 托盘的暂停数和界面跟着熔断状态走；启动时也算一次（上次停着的，check 不会报「变了」）。 */
  function costChanged(): void {
    costPausedCount = costBreakerInst.views().filter((v) => v.state === "paused").length;
    tray?.setToolTip(trayTooltip());
    notify();
  }
  /** 「现在」页的熔断提醒「打开」去哪儿。 */
  const costTargetOf = (v: CostBreakerView): NowTarget | null => {
    const h = v.sessionId ? sessions.head(v.sessionId) : null;
    if (h?.ticketKey) return { page: "ticket", key: h.ticketKey, sessionId: h.id };
    if (h && h.featureId !== null) return { page: "feature", id: h.featureId, sessionId: h.id };
    if (h?.shipherd) return { page: "shipherd", sessionId: h.id };
    return v.ticketKey ? { page: "ticket", key: v.ticketKey, sessionId: null } : null;
  };
  /** Stop 到的时候先重读这个 session 的活动（guard 看的是上一次刷新的）。活动按 head 的 id 跟踪；Stop 带来的可能是链上的旧 id。 */
  const refreshActivityOf = async (id: string): Promise<void> => {
    const head = sessions.head(id)?.id;
    if (head) await activityMonitor.refreshSession(head);
  };
  /** 开着终端的 Shipherd session 的 head（同一个 head 只算一次）。 */
  const openShipherdHeads = (): Session[] => {
    const heads = new Map<string, Session>();
    for (const termId of pty.openIds()) {
      const h = sessions.head(termId);
      if (h && h.origin === "shipherd") heads.set(h.id, h);
    }
    return [...heads.values()];
  };
  /** 开着终端的加上休眠着的 Shipherd session 的 head：汇报找总控时休眠的总控也算（送的时候叫它醒）。 */
  const liveShipherdHeads = (): Session[] => {
    const heads = new Map(openShipherdHeads().map((h) => [h.id, h]));
    for (const h of hibernatedHeads()) if (h.origin === "shipherd" && !heads.has(h.id)) heads.set(h.id, h);
    return [...heads.values()];
  };
  // 对话另存（UI 重做第 4 层）：只存双方说的话，按 replaced_by 链根存；问答规则判不了的交给低档模型（conv_qa）。
  // 判断在 session 的目录里跑；worktree 已经清掉时用 Shipherd 自己的数据目录（headless 不能在不存在的 cwd 里启动）。
  const convRepo = new ConvRepo(db);
  const convAppended = (root: string): void => safeSend(IPC.convAppended, root);
  const conv = new ConversationStore({ repo: convRepo, sessions, onAppended: convAppended, now: Date.now });
  const convIngester = new ConvIngester({
    repo: convRepo, sessions, onAppended: convAppended, now: Date.now, log: (m) => logger(m), hub: transcriptHub,
    transcriptOf: (id) => transcriptLocator.find(id),
    // 开着终端的 head；不是对话另存 target 的（没认领的外部 session）由 ConvIngester 自己跳过。
    openHeads: () => [...new Set(pty.openIds().map((t) => sessions.head(t)?.id).filter((id): id is string => !!id))],
    judge: (turn, s) => judgeConvQa({ ...judgeDeps, timeoutMs: 60_000 }, turn, existsSync(s.cwd) ? s.cwd : paths.home, s.ticketKey),
  });
  // 上下文换新（计划 16）。它自己的两道 guard 不带 refreshing（R25），否则换新会挡住自己的下一步。
  // 自动换新还要等「需要你」的判断出结论：刚停下来问了问题的 session，结论出来之前不能当作不需要你。
  // 已经在换新的不等（R33）：/handoff 的回复还没判断完时照样往下走，真判断出需要你才停。
  const refresher = new SessionRefresher({
    guard: new DeliveryGuard({
      ...guardDeps,
      needsYou: (id): boolean =>
        autoRefreshNeedsYou({ reason: needsYou.reasonOf(id), undecided: needsYou.undecided(id), refreshing: refresher.isRefreshing(id) }) || inboxService.hasPendingDecision(id),
    }),
    guardIgnoringNeedsYou: new DeliveryGuard(guardDeps),
    head: (id) => sessions.head(id),
    activity: (id) => activityMonitor.get(id),
    kindOf: (s) => refreshKindOf(s, gateTerm(s.id) !== null),
    contextOf,
    threshold: () => refreshThreshold(settings),
    // 和 HealthService 装命令的是同一个文件；Shipherd 的旧版本也算（C1）。读不了当作不是 Shipherd 的（不换新）。
    handoffCommandReady: () =>
      handoffCommandUsable(handoffCommandPath(paths.claudeCommands)).catch((e: unknown) => {
        logger("refresh: reading the /handoff command file failed", e);
        return false;
      }),
    memoryEnabled: () => memoryOn(settings),
    // /handoff 和 /clear：最多等 1 分钟，session 是停着的，输入框应该很快就绪。斜杠命令粘贴进去照样会执行（R26 用真的 claude 验证过）。
    deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
    // 「接着做」排进新 head 的信箱（BTL-248）；换新期间信箱不投影（held），开始和结束时让它重新看这个终端。
    queueResume: (headId, text) => void mailbox.send({ kind: "refresh", from: null, to: headId, featureId: sessions.head(headId)?.featureId ?? null, body: text }),
    mailboxSync: (termId) => {
      mailbox.syncTerm(termId);
      const h = sessions.head(termId);
      if (h) void mailbox.flush(h.id);
    },
    sessions: openShipherdHeads,
    lastUserInputAt: (termId) => pty.lastUserInputAt(termId),
    openedAt: (termId) => pty.openedAt(termId),
    // SHIPHERD_REFRESH_OPEN_QUIET_MS 只给 e2e 用（后台窗口模式下才算数）：它刚打开终端就要看自动换新，不想多等 1 分钟。
    openQuietMs: process.env.SHIPHERD_BACKGROUND_WINDOWS === "1" ? Number(process.env.SHIPHERD_REFRESH_OPEN_QUIET_MS) || undefined : undefined,
    // handoff 收进来时 ingest 已经把记忆同步排进队列（syncTicket / syncFeature）：/clear 之前等它写完（BTL-190 第 6 点）。
    memoryIdle: () => memory.idle(),
    // 换新前的对话尾巴：读旧 head 的 transcript，按终端的 id 存（同一个终端下一次换新覆盖它）。
    // 后面再追加 Shipherd 存下的最近问答（UI 重做第 4 层）：换新前先把旧 session 读到最新，最多等 3 秒（不能让换新卡住）。
    // 只有问答、没有尾巴时文件里就只有问答；refreshResume 的「再读一下这个文件」照样成立。
    writeTail: async (oldHeadId, termId) => {
      await Promise.race([convIngester.syncNow(oldHeadId), delay(3000, undefined, { ref: false })]).catch(() => undefined);
      const out = refreshTailPath(paths, termId);
      const tail = await writeRefreshTail({ transcript: transcriptLocator.find(oldHeadId), out, sessionId: oldHeadId });
      return withRecentQa(out, tail, conv.recentQa(oldHeadId, RECENT_QA_CHARS));
    },
    notify,
    now: Date.now,
    // /clear 之后没有 Stop：每一步输入之前先重读活动（R28）。
    refreshActivity: refreshActivityOf,
    // 闲置关闭（BTL-190 第 8 点）：和 end_session 一样只关终端（之后能恢复）。不隐藏：总控的 list_sessions、夜里的 handoff
    // 和 feature 汇总都跳过隐藏的 session。
    endTerminal: (termId) => pty.kill(termId),
    needsYouUndecided: (id) => needsYou.undecided(id),
    // 总控不能给在等用户拍板的 session 换新（BTL-190 第 2+3 点）。
    pendingDecision: (id) => inboxService.hasPendingDecision(id),
    log: logger,
  });
  // 信箱直接输入 ask_user 的回答用这一道（BTL-190 第 2+3 点）：未决的 ask_user 本身就算「需要你」，所以不看它；在换新的照样挡。
  const answerGuard = new DeliveryGuard({ ...guardDeps, refreshing: (id) => refresher.isRefreshing(id) });
  // 信箱（BTL-245）：session 之间的消息一律排队存库；在忙的下一次工具调用时由 PostToolUse hook 带进去，停着的直接输入。
  // 回答（ask_user 的）过 answerGuard（不看「需要你」），别的过 deliveryGuard。inboxService 在下面才建好：回调里才用到。
  const mailboxName = (id: string | null): string =>
    sessionName({ head: (x) => sessions.head(x), featureName: (f) => features.get(f)?.name ?? null }, id);
  const messagesRepo = new SessionMessagesRepo(db);
  /** a 是不是 b 的总控（链上任何一个 id）。和 featureSend 同一个判断、同一份数据：epic 没归档、ticket 是 listByFeature 列出来的。 */
  const mailboxControls = (a: string | null, b: string): boolean => {
    const from = a === null ? null : sessions.head(a);
    const to = sessions.head(b);
    const ownKeys = (featureId: number): Set<string> | null =>
      features.get(featureId)?.archivedAt === null ? new Set(tickets.listByFeature(featureId).map((t) => t.key)) : null;
    return !!from && !!to && isControllerOf(from, to, ownKeys);
  };
  /** 这条消息是收件人自己的总控发的（BTL-269 A：「需要你」时也送进去）。 */
  const mailboxFromController = (m: SessionMessage, headId: string): boolean => mailboxControls(m.fromSession, headId);
  /** 这个 head 有别的 session 发来、还排着的消息（约定广播不算）。 */
  const headOf = (id: string): string => sessions.head(id)?.id ?? id;
  const hasSessionMail = (headId: string): boolean => sessionMailWakes(messagesRepo.queued(), headOf, headId);
  /** 全局总控在做巡检那一轮（BTL-279 复核建议 3）：这一轮 send_message 发的不把用户点 × 关掉的 epic 总控拉起来。 */
  const patrolTurns = new PatrolTurns(Date.now);
  const mailbox = new Mailbox({
    repo: messagesRepo,
    root: paths.mailbox,
    head: (id) => sessions.head(id),
    termOf: gateTerm,
    openTerms: () => pty.openIds(),
    check: (id, o) => (o.answer ? answerGuard : deliveryGuard).check(id, { force: o.force, lenient: o.lenient }),
    recheckAfter: (id, passed, o) => (o.answer ? answerGuard : deliveryGuard).recheckAfter(id, passed, { force: o.force, lenient: o.lenient }),
    fromController: (m, headId) => mailboxFromController(m, headId),
    // 同一个判断反过来（BTL-279）：发件人是收件人管的 session（汇报）。
    fromSubordinate: (m, headId) => m.fromSession !== null && mailboxControls(headId, m.fromSession),
    hibernated: (id) => isHibernated(id),
    deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
    // 叫停：在忙、屏幕上没有要用户回答的、用户 30 秒内没打字、没有草稿、没在换新、没被熔断压着、没有别的自动输入正在进去。
    canInterrupt: (termId) => {
      const h = sessions.head(termId);
      if (!h || h.waitingForInput || refresher.isRefreshing(h.id) || costBreaker?.sessionPaused(h.id)) return false;
      if (pty.screenNeedsUser(termId) || pty.hasDraft(termId) || pty.autoInputInFlight(termId)) return false;
      const typed = pty.lastUserInputAt(termId);
      return typed === 0 || Date.now() - typed >= (guardDeps.typingQuietMs ?? USER_TYPING_QUIET_MS);
    },
    interrupt: (termId) => pty.interrupt(termId),
    interruptRecheck: (termId) => {
      const at = Date.now();
      return () => pty.isOpen(termId) && pty.lastUserInputAt(termId) <= at && !pty.screenNeedsUser(termId);
    },
    lastReply: (id) => activityMonitor.lastReplyOf(id),
    turnClosed: (id) => activityMonitor.turnClosed(id),
    // 正在换新的不往 hook 投影（BTL-248）：/handoff 那一轮带进去的消息会被紧接着的 /clear 清掉。
    held: (id) => refresher.isRefreshing(id),
    featureOf: (id) => {
      const h = sessions.head(id);
      return h ? (h.featureId ?? (h.ticketKey === null ? null : (tickets.get(h.ticketKey)?.featureId ?? null))) : null;
    },
    nameOf: mailboxName,
    typing: (h, phase) => inboxService.shipherdTyping(h, phase),
    coordinatorAnswered: (h, o) => inboxService.coordinatorAnswered(h, o),
    awaitingUser: (h) => awaitingUserOf(h),
    // 休眠着的（WS-M B）叫它醒，醒来停下时 sessionStopped 再送；真关了的、总控管的在后台恢复（BTL-256）。熔断压着的不叫。
    // 真关了的只为别的 session 发来的消息恢复（总控的指示、汇报……）：CI、合并这类 Shipherd 自己的通知排着等下次打开，
    // 免得总控刚 end_session 的 session 被下一条通知又拉起来。
    wake: (id) => {
      if (costBreaker?.sessionPaused(id) || quitState.quitting) return;
      if (hibernator && isHibernated(id)) void hibernator.wake(id, "delivery");
      else if (resumer && hasSessionMail(id)) void resumer.request(id, "mail");
    },
    // 关着的总控的角色由谁担着（BTL-279）：新开的全局总控、同一个 epic 开着的另一个总控。回复和汇报改投给它。
    successor: (id) => {
      const h = sessions.head(id);
      if (!h || h.ticketKey !== null) return null;
      if (h.shipherd) {
        const r = sessionService.runningShipherd();
        return r && r.id !== h.id ? r.id : null;
      }
      if (!h.coordinator || h.featureId === null) return null;
      return sessions.listFeatureCoordinators(h.featureId).find((x) => x.id !== h.id && x.coordinator && x.replacedBy === null && !x.dismissed && gateTerm(x.id) !== null)?.id ?? null;
    },
    delivered: (m) => {
      patrolTurns.messageDelivered(sessions.head(m.toSession)?.id ?? m.toSession, m);
      resumer?.delivered(m);
    },
    notify,
    // 又试了一次（BTL-279）：只有消息列表跟着变。
    notifyMessages: () => notify("messages"),
    now: Date.now,
    log: logger,
  });
  mailboxDiagnostics = () => mailbox.diagnostics();
  // 信息流转（BTL-272）：每轮说完抽要点，写进最小一级记忆，发给该知道的 session，对话里说的状态变化同步进 Shipherd。
  // 关 ticket 用 BTL-270 的 closeTicket（来源记 routing），重新打开用 reopenTicket；ticketClose 在后面定义，执行时才用到。
  const flowLookups = infoflowLookups({
    tickets, features, blocks, sessions,
    live: (id) => pty.isOpen(id) || isHibernated(id),
    closed: (t) => effectiveStatus(t) === "closed",
  });
  const infoflow = new InfoflowService({
    repo: new InfoflowRepo(db),
    conv: convRepo,
    head: (id) => sessions.head(id),
    enabled: () => settings.get("flowExtract") !== "0",
    autoApply: () => settings.get("flowAutoApply") !== "0",
    dailyAsks: () => flowDailyAsks(settings),
    nameOf: mailboxName,
    ...flowLookups,
    extract: (ctx, turn, o) => extractTurn({ ...judgeDeps, timeoutMs: 90_000 }, ctx, turn, o),
    cwdOf: (s) => (existsSync(s.cwd) ? s.cwd : paths.home),
    paused: (id) => costBreaker?.sessionPaused(id) ?? false,
    remember: (scope, text, findDup) => memory.rememberUnlessDup(scope, text, findDup),
    forget: (scope, match) => memory.forgetText(scope, match),
    // epic 不从来源带（null）：信箱按收件人算，发到别的 epic 的消息归在收件人那边。
    send: (m) => mailbox.send({ kind: "fact", from: m.from, to: m.to, featureId: null, body: m.body, ref: m.ref, meta: m.meta }),
    withdraw: (ref) => mailbox.withdraw(ref),
    act: infoflowTicketActions({
      tickets, blocks, notify,
      closer: {
        close: (key, reason, closePrs, prUrls) => ticketClose.close(key, { reason, source: "routing", closePrs, ...(prUrls && { prUrls }), endSessions: false }),
        preview: async (key) => ticketClose.preview(key),
        retry: (key, o) => ticketClose.retry(key, o),
        reopen: async (key) => ticketClose.reopen(key, "routing"),
      },
    }),
    strings: () => M().infoflow,
    notify,
    now: Date.now,
    log: logger,
    // 只给 e2e 用：不想等 20 秒的安静期、30 秒一遍。
    settleMs: Number(process.env.SHIPHERD_FLOW_SETTLE_MS) || undefined,
  });
  const inboxRepo = new InboxRepo(db);
  const inboxService: InboxService = new InboxService({
    repo: inboxRepo,
    head: (id) => sessions.head(id),
    ticket: (key) => tickets.get(key),
    termOf: gateTerm,
    openHeads: liveShipherdHeads,
    mailbox,
    latestCoordinator: (where) => {
      for (const x of sessions.listFeatureCoordinators(where.feature)) {
        const h = sessions.head(x.id);
        if (h && !h.dismissed) return h.id;
      }
      return null;
    },
    // 换新输入的 /handoff 和接着做的话也会触发 UserPromptSubmit：那不是用户在终端里回答。
    refreshing: (id) => refresher.isRefreshing(id),
    recordEvent,
    choices,
    onAsked: (q) => {
      notifier?.emit("decision_needed", { ticketKey: q.ticketKey });
      // 先 asked（又问一遍的那种同步就定了类别），再 sync：sync 会清掉已经结束的条目的类别，包括刚被顶掉的那条。
      const classified = interrupts.asked(q);
      waitTracker.sync();
      void classified.then(() => waitTracker.sync(), (e: unknown) => logger("metrics: classifying a question failed", e));
    },
    onSuperseded: () => waitTracker.sync(),
    notify,
    now: Date.now,
    log: logger,
  });
  // 对话 tab（UI 重做第 5 层）：发给开发 session（输入框、分叉的结论）。BTL-248 起排进信箱（kind user），停着的原样直接输入。
  const devSender = new DevSender({ sessions, mailbox, sanitize: sanitizeTask, now: Date.now, log: logger });
  /**
   * 完整分叉自己的 --mcp-config：跟开发 session 打开时同一个配置函数、同一组 server，但 termId 是 null——
   * 分叉从不走共享 MCP 的 hub，总是写 mcp/forks/ 下自己的 stdio 文件（见 placeMcp、writeForkMcpConfig；Task 8 review I1）。
   * 开发 session 没有 MCP 配置时返回 null（沿用开发参数）。
   */
  const forkMcpConfig = (dev: DevLaunch, runId: string): string | null => {
    if (!dev.mcpConfigPath) return null;
    const s = sessions.get(dev.sessionId);
    if (!s) return null;
    const termId = null;
    try {
      if (s.ticketKey !== null) {
        const featureId = tickets.get(s.ticketKey)?.featureId ?? null;
        return memoryMcpConfig(s.ticketKey, { featureId }, termId);
      }
      if (s.featureId !== null) return featureMcpConfig(s.featureId, termId);
      if (s.shipherd) return shipherdMcpConfig(termId);
      return null;
    } catch (e) {
      logger(`fork: writing the MCP config for ${dev.sessionId} (run ${runId}) failed; the fork uses the dev session's`, e);
      return null;
    }
  };
  const forkService = new ForkService({
    repo: new ForkDiscussionsRepo(db),
    conv,
    recentQa: (root, maxChars) => conv.recentQa(root, maxChars),
    sessions,
    // 下面三个 ForkService 都用链上现在的 head id 调。
    devLaunchOf: (id) => sessionService.devLaunchOf(id),
    transcriptExists,
    // 分叉第一轮的准数：被分叉的开发 session 存下的累计（BTL-239）。
    costBase,
    // 开着终端（gateTerm 按 head 找终端，/clear 之后也找得到）；休眠的没有终端，不算在跑。
    devRunning: (id) => gateTerm(id) !== null,
    lastTurnAt: (id) => usageRepo.lastSessionTurnAt(id),
    recall: (scope, maxChars) => memory.recallText(scope, maxChars),
    files: {
      // 只读 hook 和 gate hook 是同一个 shipherd-hook 命令（forkSettings 在后面加 readonly）；hook 没装好 → null → ForkService 报 no_claude。
      settings: (devSettingsPath) => {
        try {
          return writeForkSettings({ dir: paths.mcp, devSettingsPath, guardCommand: hookInstalled() ? hookCommand(paths.hookBin, process.platform) : null });
        } catch (e) {
          logger("fork: writing the fork settings failed", e);
          return null;
        }
      },
      mcp: forkMcpConfig,
    },
    // 接着问、要结论不再写 settings：每一轮都看一次 hook 还在不在。
    hookReady: hookInstalled,
    run: runHeadless,
    claude: () => health.claude(),
    // 跟交互 session 一样的 process.env：CLAUDE_EFFORT 之类原样带过去（forkEnv 补上 sessionEnv 的默认值）。
    baseEnv: process.env,
    recordHeadless: (id, cwd, at) => sessions.recordHeadless(id, cwd, at),
    onUsage: recordHeadlessUsage,
    onLimit: availabilityHooks.onLimit,
    registry: () => routing.config().registry,
    send: (anyId, text) => devSender.send(anyId, text),
    remember: (scope, text) => memory.rememberText(scope, text),
    memoryEnabled: () => memoryOn(settings),
    changed: (root) => safeSend(IPC.forkChanged, root),
    plan: FULL_FORK,
    now: Date.now,
    newRunId: randomUUID,
    signal: headlessAbort.signal,
    log: logger,
  });
  // 上次退出时还在跑的分叉讨论记成 interrupted。
  try {
    forkService.recover();
  } catch (e) {
    logger("fork: recovering interrupted discussions failed", e);
  }
  // 等人时间（ws-h）：开着终端的 Shipherd head（复盘分析 session 除外）此刻在等什么。休眠的没有终端，不算。
  const waitHeads = (): WaitHead[] => {
    const categories = needsYou.categories();
    const asksByHead = inboxService.unansweredAsksByHead();
    interrupts.retainAsks(new Set([...asksByHead.values()].flat()));
    const out = new Map<string, WaitHead>();
    for (const termId of pty.openIds()) {
      const h = sessions.head(termId);
      if (!h || h.origin !== "shipherd" || h.lessonRunId !== null || out.has(h.id)) continue;
      const asks = asksByHead.get(h.id) ?? [];
      const activity = activityMonitor.get(h.id) ?? null;
      out.set(h.id, {
        id: h.id, ticketKey: h.ticketKey, waiting: h.waitingForInput, hibernated: h.hibernatedAt !== null,
        kind: activity?.kind ?? null, permission: pty.permissionShowing(termId), questionTool: questionToolShowing(activity),
        ask: asks.length > 0 ? interrupts.askCategory(asks[asks.length - 1]) : undefined,
        needsYou: categories.get(h.id) ?? null,
      });
    }
    return [...out.values()];
  };
  const waitTracker = new WaitTracker({
    repo: metricsRepo, heads: waitHeads, now: Date.now, log: logger,
    // 权限确认和 AskUserQuestion 只在这里看得到：开段时记打断。ask_user、需要你各自在自己那里记。
    onHumanSpan: (spanId, h, st) => {
      if ((st.source === "permission_prompt" || st.source === "question_tool") && st.category) interrupts.spanOpened(spanId, h.id, h.ticketKey, st.category, st.source);
    },
  });
  waitTracker.recover();
  const waitTimer = setInterval(() => waitTracker.sync(), WAIT_TOUCH_MS);
  // 人在终端里的输入（ws-h）：UserPromptSubmit 和对话框按键。Shipherd 自己递的（回答、汇报、换新）不算。
  // 只算 Shipherd 开着终端的 session：外部终端里认领的、复盘分析 session 不算。
  const terminalMeter = new TerminalInputMeter({
    record: recordEvent, now: Date.now, log: logger,
    session: (termId) => {
      if (!pty.isOpen(termId)) return null;
      const h = sessions.head(termId);
      return h && h.origin === "shipherd" && h.lessonRunId === null ? { id: h.id, ticketKey: h.ticketKey } : null;
    },
    autoInputInFlight: (termId) => pty.autoInputInFlight(termId) || refresher.isRefreshing(sessions.head(termId)?.id ?? termId),
    permissionShowing: (termId) => pty.permissionShowing(termId),
    activity: (termId) => activityMonitor.get(sessions.head(termId)?.id ?? termId) ?? null,
    waitingFor: (termId) => waitTracker.waitingFor(sessions.head(termId)?.id ?? termId),
  });
  /** 对话框按键（ws-h）：权限确认往往在下一次活动 tick 之前就被答掉了，先 sync 一次把等待段和打断记上，屏幕重画以后再 sync 关掉。 */
  const meterTerminalKeys = (termId: string, data: string): void => {
    if (!isDialogKey(data)) return;
    waitTracker.sync();
    if (terminalMeter.keys(termId, data)) setTimeout(() => waitTracker.sync(), 1500).unref?.();
  };
  // Shipherd 总控的每日巡检（BTL-190 第 5 点）：到点打开（或接着用）Shipherd 总控，发巡检消息。BTL-248 起排进它的信箱。
  const shipherdPatrol = new ShipherdPatrol({
    time: () => settings.get("shipherdPatrolTime"),
    jobs,
    now: Date.now,
    running: () => sessionService.runningShipherd(),
    latest: () => sessionService.latestShipherd(),
    open: (req) => sessionService.openShipherd(req),
    mailbox,
    headOf: (termId) => sessions.head(termId)?.id ?? termId,
    opened: (id, termId) => mailbox.opened(id, termId, submitTask),
    message: () => M().shipherdPatrolMessage,
    onChange: notify,
    log: logger,
  });
  // 清理 session（BTL-190 第 8 点）：闲置自动关闭、隐藏 14 天后删除、「清理闲置」和「全部删除」。
  const sessionCleanup = new SessionCleanup({
    idleMinutes: () => idleCloseMinutes(settings),
    terminals: () => pty.openIds().flatMap((termId) => {
      const head = sessions.head(termId);
      return head && head.origin === "shipherd" ? [{ termId, head }] : [];
    }),
    activity: (id) => activityMonitor.get(id),
    lastUserInputAt: (termId) => pty.lastUserInputAt(termId),
    openedAt: (termId) => pty.openedAt(termId),
    ticketsOfFeature: (id) => tickets.listByFeature(id).map((t) => t.key),
    askUserPending: (id) => inboxService.hasPendingDecision(id),
    // 合并排队（等待者记的是 SHIPHERD_SESSION，换成 head 再对）、ticket 的 PR 的 CI 还在跑：通知只递给开着的终端。
    waitingOnShipherd: (headId) => {
      if ([...gateRepo.waitingSessionIds()].some((id) => (sessions.head(id)?.id ?? id) === headId)) return true;
      const key = sessions.head(headId)?.ticketKey;
      // 合并、关闭了的 PR 留着最后一次读到的 CI：只算开着的 PR 和还没有 PR 的分支。
      return key != null && prWatcher.statusOf(key).some((p) => (p.state === "open" || p.state === null) && p.ci === "pending");
    },
    refresher,
    hiddenBefore: (before) => sessions.listHiddenBefore(before),
    head: (id) => sessions.head(id),
    terminalOpen: (id) => gateTerm(id) !== null,
    deleteChain: (id) => sessions.deleteChain(id),
    removeTail: (id) => rmSync(refreshTailPath(paths, id), { force: true }),
    notify,
    now: Date.now,
    log: logger,
  });
  // PR 和 CI 的监视（计划 13）。
  const ticketPrs = new TicketPrsRepo(db);
  // 只数读过的行（checkedAt > 0，同 prHandoff）：没读过的行状态只是链接时的猜测，不能把 ticket 钉在 in_review；新链接的行下一轮轮询就会读到。
  // 一直读不到、放弃了的行也不数。
  const linkedOpen = (k: string): boolean => anyLinkedOpen(ticketPrs.byTicket(k));
  // 放弃读了的 PR：handoff 里（模型报的、记着的）开着也不再把 ticket 留在 in_review。
  const givenUpPrs = (k: string): ReadonlySet<string> => new Set(ticketPrs.byTicket(k).filter(prGivenUp).map((p) => p.url));
  const shipherdClosedPrs = (k: string): ReadonlySet<string> =>
    new Set(ticketPrs.byTicket(k).filter((p) => (p.shipherdClosedAt ?? null) !== null).map((p) => p.url));
  // 不在 ticket 任何仓库里的 PR（BTL-261）：不收录、不跟踪，handoff 里说它开着也不把 ticket 留在 in_review。
  const foreignPr = (k: string, url: string): boolean => prLinker.foreign(k, url);
  const branchWatch = new BranchWatchRepo(db);
  const prCommandDeps: PrCommandDeps = {
    session: (id) => {
      const h = sessions.head(id);
      return h ? { ticketKey: h.ticketKey, featureId: h.coordinator ? h.featureId : null } : null;
    },
    ticketsOfFeature: (f) => tickets.listByFeature(f).map((t) => t.key),
    prsByUrl: (u) => ticketPrs.byUrl(u),
    prsByNumber: (n) => ticketPrs.byNumber(n),
    prsOfTicket: (k) => ticketPrs.byTicket(k),
  };
  // 仓库改名（BTL-261）：记下的改名启动时先去 GitHub 复查（旧名字可能被新仓库占了），确认的才改写、才用；之后定时复查。
  // 启动后再扫一遍存着的 slug，watcher / linker 看到链接换了仓库名时再查。
  const repoRenamesRepo = new RepoRenamesRepo(db);
  // 汇总还没建好（启动时改写）就先记着，建好以后马上重算。
  let rerollPending = false;
  let afterRename = (): void => {
    rerollPending = true;
  };
  const repoRenames = new RepoRenames({
    repo: repoRenamesRepo,
    currentSlug: (slug) => repoCurrentSlug(homedir(), slug, 20_000),
    candidates: () => repoRenamesRepo.candidates(Date.now() - 90 * 24 * 60 * 60_000),
    slugOf: (path) => repoIdentity.rawSlugOf(path),
    now: Date.now,
    log: logger,
    onApplied: () => afterRename(),
  });
  // 各处拿到的仓库 slug 都换成改名后的名字（本地 origin 还是旧名字也一样）。
  repoIdentity.useCanonical((slug) => repoRenames.canonical(slug));
  void repoRenames.verifyRecorded();
  const prLinker = new PrLinker({
    prs: ticketPrs, tickets, slugOf: (path) => repoIdentity.slugOf(path), remoteSlugs: (path) => repoIdentity.remoteSlugsOf(path),
    canonical: (slug) => repoRenames.canonical(slug), settled: (slug) => repoRenames.settled(slug),
    onSlugMoved: (from, to) => repoRenames.suggest(from, to), log: logger, now: Date.now,
  });
  // 合并通知排进等待者的信箱（BTL-248）：在忙的下一次调用工具读到，关着的下次打开时读到，休眠的信箱叫它醒。
  const holdWatcher = new HoldWatcher({
    repo: gateRepo, prInfo, git,
    mailbox: { send: (x) => mailbox.send({ ...x, body: sanitizeTask(x.body) }) },
    // PrWatcher 刚查过的 PR 不用再问 gh。prWatcher 在后面才建好：回调里才用到。
    cachedByUrl: (url) => prWatcher.cachedByUrl(url),
    whoOf, now: Date.now, log: logger,
  });
  // 分支是谁的（工作流 W）：hook 看到的 git push / gh pr create 记下来，CI 的结论按它递。
  const branchOwners = new BranchOwnersRepo(db);
  /** CI 结论和评论递给谁（pickRecipient + 休眠的，WS-M B）：CiDelivery 和评论闭环共用。ctx 给了就用它读开着的、休眠的 head（首页一次拼输入里共用）。 */
  const loopRecipient = (key: string, repoId: number, branch: string, ctx?: RecipientCtx) => {
    const o = branchOwners.get(key, repoId, branch);
    return ciRecipient({
      ticketKey: key, repoId, branch,
      openHeads: ctx ? ctx.openHeads() : pty.openIds().flatMap((t) => sessions.head(t) ?? []),
      hibernatedHeads: ctx ? ctx.hibernatedHeads() : hibernatedHeads(),
      ownerSessionId: o?.sessionId ?? null,
      headOf: ctx ? ctx.head : (id) => sessions.head(id),
      ownerTermOpen: o !== null && gateTerm(o.sessionId) !== null,
      ticketBranch: tickets.getRepo(repoId)?.branch ?? null,
    });
  };
  // 评论闭环和 CI 分类（工作流 I）：三层策略（契约 4.2），模型经路由（comment_classify / ci_classify），对外动作过 4.8 的开关。
  const loopPolicies = new LoopPolicies({ db, products: { productsOf: (slug) => lessonsRepo.productsOf(slug), product: (id) => lessonsRepo.product(id) }, now: Date.now });
  /** 仓库的三层策略；给了 ticket 且它所在 epic 自己选了自动化档位时，受管的键按那一档（BTL-247）。 */
  const loopPolicyFor = (slug: string | null, ticketKey?: string | null) => automation.loop(loopPolicies.forSlug(slug), ticketKey);
  const ciTriageRepo = new CiTriageRepo(db);
  const commentItems = new CommentItemsRepo(db);
  const loopStats = new LoopStats({ comments: commentItems, triage: ciTriageRepo });
  const prGhDir = (pr: { repoId: number | null }): string => {
    const r = pr.repoId === null ? null : tickets.getRepo(pr.repoId);
    return r ? ticketService.ghWorkDir(r) : homedir();
  };
  const ciTriage = new CiTriage({
    repo: ciTriageRepo,
    policy: loopPolicyFor,
    external: externalActions,
    gh: { runInfo, failedLog, rerunFailed },
    model: (input) => classifyCiByModel(judgeDeps, input),
    where: (item: CiItem) => {
      if (item.kind === "pr") {
        const r = ticketPrs.get(item.id);
        return r ? { cwd: prGhDir(r), slug: r.slug, ticketKey: r.ticketKey, prId: r.id, target: r.url } : null;
      }
      const b = branchWatch.get(item.repoId);
      const repo = tickets.getRepo(item.repoId);
      return b && repo ? { cwd: ticketService.ghWorkDir(repo), slug: repoIdentity.slugOf(repo.repoPath), ticketKey: b.ticketKey, prId: null, target: null } : null;
    },
    // ciDelivery 在下面才建好：回调到调用时才用。
    wake: (item) => void ciDelivery.settled(item).catch((e: unknown) => logger("ci delivery: after triage failed", e)),
    soon: (item) => {
      if (item.kind === "branch") return prWatcher.soon(item.repoId);
      const r = ticketPrs.get(item.id);
      if (r) prWatcher.soonTicket(r.ticketKey);
    },
    recordEvent,
    now: Date.now,
    log: logger,
  });
  const commentLoop = new CommentLoop({
    items: commentItems,
    prs: ticketPrs,
    policy: loopPolicyFor,
    cwdOf: prGhDir,
    gh: { reviewThreads, compareFiles, replyToReviewComment, commentOnPr, resolveReviewThread },
    model: (cwd, list) => classifyCommentsByModel(judgeDeps, cwd, list),
    external: externalActions,
    recipient: loopRecipient,
    mailbox,
    // stackService 在下面才建好：递评论时才用。
    stackNote: (row): string | null => stackService.stackNote(row.url, row.headBranch),
    recordEvent,
    changed: () => notify(),
    headOf: (id) => sessions.head(id)?.id ?? null,
    now: Date.now,
    log: logger,
  });
  // CI 的结论排进 PR 所属的 session 的信箱（pickRecipient：推这个分支的、启动时就在这个分支上的、ticket 分支上的第一个；
  // 休眠着的也算，信箱叫它醒）。BTL-248 起不再自己等它停下。
  const ciDelivery = new CiDelivery({
    prs: ticketPrs,
    branches: branchWatch,
    currentBranch: (repoId) => tickets.getRepo(repoId)?.branch ?? null,
    mailbox,
    headOf: (id) => sessions.head(id)?.id ?? id,
    recipient: loopRecipient,
    triage: ciTriage,
    now: Date.now,
    log: logger,
  });
  /** 「现在」页上「CI 结果未能送达」的提醒上次是哪几条：变了才刷新页面。 */
  let ciStuck = "";
  const ciStuckChanged = (): void => {
    const next = ciDelivery.undelivered().map((u) => `${u.item.kind}:${"id" in u.item ? u.item.id : u.item.repoId}:${u.reason}`).join("|");
    if (next !== ciStuck) {
      ciStuck = next;
      notify();
    }
  };
  /** 递还没递出去的 CI 结论（永不 reject）。每一轮都看一次有没有刚满半小时的。 */
  // 评论闭环排着队的评论跟在 CI 后面递（同一个时机；CI 递出去了 session 就忙了，评论等它下次停下来）。
  const flushCi = (): Promise<void> => ciDelivery.flush().then(ciStuckChanged).catch((e: unknown) => logger("ci delivery: flush failed", e))
    .then(() => commentLoop.flush()).catch((e: unknown) => logger("comment loop: flush failed", e));
  // 栈式 PR（工作流 K）：三层策略（契约 4.2），对外动作只经 4.8 的开关（branch_push、pr_open、issue_post）。
  const stackPolicy = new StackPolicyService({
    db, productsOf: (slug) => lessonsRepo.productsOf(slug), productName: (id) => lessonsRepo.product(id)?.name ?? null, now: Date.now, onChange: () => notify(),
  });
  /** 这个仓库里的这个分支是哪个 ticket 的：ticket 仓库的分支优先，其次是 hook 记下的推送（branch_owners）。 */
  const stackOwned = (repoPath: string, branch: string): OwnedBranch | null => {
    const own = (r: TicketRepo): OwnedBranch => ({
      ticketKey: r.ticketKey, ticketRepoId: r.id, ticketTitle: tickets.get(r.ticketKey)?.title ?? null,
      worktree: r.workMode === "worktree" && r.worktreePath && r.worktreeRemovedAt === null && existsSync(r.worktreePath) ? r.worktreePath : null,
    });
    // 只认没归档的 ticket；分支名被重复用过时取最新的那个
    const live = (r: TicketRepo): boolean => { const t = tickets.get(r.ticketKey); return t !== null && t.archivedAt === null; };
    const direct = tickets.reposByBranch(branch).filter((r) => samePath(r.repoPath, repoPath) && live(r)).at(-1);
    if (direct) return own(direct);
    for (const o of branchOwners.byBranch(branch)) {
      const r = tickets.getRepo(o.repoId);
      if (r && samePath(r.repoPath, repoPath) && live(r)) return { ...own(r), worktree: null };
    }
    return null;
  };
  const stackService = new StackService({
    repo: new StacksRepo(db, Date.now),
    policy: stackPolicy,
    // 自动化档位（BTL-247）：栈里各层 ticket 所在 epic 自己选的档位盖在三层策略上；「半自动」epic 的仓库也做栈检测。
    overlay: (base, keys) => automation.stack(base, keys),
    autoRebaseRepos: () => [
      ...new Set(tickets.list().filter((t) => t.archivedAt === null && automation.overrideForTicket(t.key) === "semi").flatMap((t) => t.repos.map((r) => r.repoPath))),
    ],
    external: externalActions,
    workRoot: join(paths.home, "stack-work"),
    execPath: process.execPath,
    now: Date.now,
    log: logger,
    owned: stackOwned,
    slugOf: async (path) => repoIdentity.slugOf(path),
    // 开着终端、在这个目录里、正在干活的 session（同一个 head 只看一次）。
    sessionBusy: (path) => pty.openIds().some((t) => {
      const h = sessions.head(t);
      return h !== null && h !== undefined && samePath(h.cwd, path) && working(activityMonitor.get(h.id) ?? null);
    }),
    gateHeld: (repoPath, branch) => gateRepo.activeHold(repoPath, branch) !== null,
    trunkBusy: (repoPath, trunk, ignore) => gateRepo.activeHolds().some((h) => samePath(h.repoPath, repoPath) && h.target === trunk && !ignore.includes(h.branch)),
    awaitingCheck: (url): boolean => ticketPrs.byUrl(url).some((r): boolean => commentLoop.awaitingCheck(r.id)),
    // 和 CI、评论同一个收件人；排进它的信箱（BTL-248），同一层新的冲突换掉还没送的旧的。认不出收件人时返回 false。
    deliver: async (to, text) => {
      const repoId = to.ticketRepoId ?? tickets.listRepos(to.ticketKey).find((r) => r.branch === to.branch)?.id ?? null;
      if (repoId === null) return false;
      const rcpt = loopRecipient(to.ticketKey, repoId, to.branch);
      if (!rcpt.ok) return false;
      mailbox.send({ kind: "stack", from: null, to: rcpt.sessionId, featureId: null, body: sanitizeTask(text), ref: `stack:${to.ticketKey}:${to.branch}` });
      return true;
    },
    record: recordEvent,
    onChange: () => notify(),
    closedByShipherd: (url) => ticketPrs.markShipherdClosed(url, Date.now()),
    jobs,
    repos: () => [...new Set(tickets.list().filter((t) => t.archivedAt === null).flatMap((t) => t.repos.map((r) => r.repoPath)))],
    // 开栈底 PR 时的简报（工作流 G）：G 的 BriefService 建好后填进 stackBriefProvider；关着或没有时为 null。
    briefProvider: stackBriefProvider,
  });
  // 预审、证据、就绪、风险、简报、review 效果（工作流 G）。模型走路由（pre_review、evidence_verify、brief_summary），
  // 对外动作（贴简报）过 4.8 的开关；预审在后台队列里跑，结论和 CI、评论走同一道递送。
  const prPolicies = new PrPolicies({ db, products: { productsOf: (slug) => lessonsRepo.productsOf(slug), product: (id) => lessonsRepo.product(id) }, now: Date.now });
  const preReviewRepo = new PreReviewRepo(db);
  const assessRepo = new AssessRepo(db);
  const reviewEffectRepo = new ReviewEffectRepo(db);
  const prPolicyFor = (slug: string) => prPolicies.forSlug(slug);
  const prProfile = (slug: string): RepoProfile | null => {
    const b = baselineService.latest(slug);
    return b && b.origin !== "imported" ? b.profile : null;
  };
  const prExec: ExecRun = (o) => execHeadlessJson(judgeDeps, o);
  const ticketTitle = (key: string | null): string | null => (key ? (tickets.get(key)?.title ?? null) : null);
  const prRecipient = (pr: TicketPr): string | null => {
    if (pr.repoId === null || !pr.headBranch) return null;
    const r = loopRecipient(pr.ticketKey, pr.repoId, pr.headBranch);
    return r.ok ? r.sessionId : null;
  };
  const sessionChecks = (id: string | null): { absent: string | null; hits: CheckHitView[] } =>
    id ? { absent: checksService.sessionCoverage([id])[id]?.absent ?? null, hits: checksService.hitsForSessions([id]) } : { absent: null, hits: [] };
  /** PR 的改动：本地仓库里算（有这个提交时），不行就走 GitHub compare。 */
  const prFilesOf = async (pr: TicketPr): Promise<DiffFile[] | null> => {
    if (!pr.headSha || !pr.baseBranch) return null;
    const cwd = prGhDir(pr);
    const local = await prDiff(cwd, pr.headSha, pr.baseBranch).catch(() => null);
    if (local) return local.files;
    const rows = await compareFiles(cwd, pr.baseBranch, pr.headSha, 60_000, pr.slug);
    return rows ? fromCompare(rows).files : null;
  };
  /** 这份代码（仓库 + 分支）开着的 PR：交证据、预审取 diff 时用。 */
  const openPrFor = (ticketKey: string | null, target: ReviewTarget): TicketPr | null =>
    (ticketKey ? ticketPrs.byTicket(ticketKey) : ticketPrs.all()).find((p) => p.state === "open" && p.slug === target.repoSlug && p.headBranch === target.branch) ?? null;
  // BTL-271：每个 ticket、PR、session 的预审状态和预审队列（徽标、队列页、总控工具；契约 [contract:prereview-status]）。
  const preReviewStatus = new PreReviewStatusService({
    repo: preReviewRepo,
    jobs: { queued: () => bgRepo.queued("pre_review"), running: () => bgRepo.runningOf("pre_review") },
    gate: (ticketKey) => bgScheduler.gate("pre_review", ticketKey ? { ticketKey } : undefined),
    concurrency: () => bgQueue.concurrencyOf("pre_review"),
    heldLocks: () => bgQueue.locksOf("pre_review").values(),
    pr: (id) => {
      const pr = ticketPrs.get(id);
      return pr ? { number: pr.number, url: pr.url } : null;
    },
    chainOf: (id) => sessions.chainOf(id),
    enabled: (key) => preReviewActive(key),
    // ticket 各仓库现在的分支 + 开着的 PR 的分支；旧分支不参与 ticket 的 overall（BTL-271）。
    currentBranches: (key) => [
      ...tickets.listRepos(key).filter((r) => r.branch).map((r) => ({ slug: repoIdentity.slugOf(r.repoPath), branch: r.branch })),
      ...ticketPrs.byTicket(key).filter((p) => p.state === "open" && p.headBranch).map((p) => ({ slug: p.slug, branch: p.headBranch! })),
    ],
    now: Date.now,
  });
  const preReview = new PreReviewService({
    repo: preReviewRepo,
    queue: bgQueue,
    placeOf: (id) => preReviewStatus.placeOf(id),
    enabled: preReviewActive,
    place: (id) => {
      const s = sessions.get(id);
      const cwd = sessions.head(id)?.cwd ?? null;
      if (!s || !cwd) return null;
      const repo = s.repoId !== null ? tickets.getRepo(s.repoId) : null;
      return { cwd, ticketKey: s.ticketKey ?? null, slug: repoIdentity.slugOf(repo?.repoPath ?? cwd) };
    },
    git: git.git,
    recipient: prRecipient,
    cwdOf: (pr, sessionId) => (sessionId ? (sessions.head(sessionId)?.cwd ?? null) : null) ?? (pr.repoId !== null ? (tickets.getRepo(pr.repoId)?.repoPath ?? null) : null),
    // 和度量的 shipherd_made 同一个口径（分支的主人、合并占位、在这个分支上干活的 session 是 Shipherd 开的）；度量还没算到的现场看。
    isShipherdPr: (pr) => {
      const o = pr.repoId !== null && pr.headBranch ? branchOwners.get(pr.ticketKey, pr.repoId, pr.headBranch) : null;
      if (o && sessions.get(o.sessionId)?.shipherd) return true;
      return pr.headBranch !== null && sessions.listByTicket(pr.ticketKey).some((s) => s.shipherd && s.gitBranch === pr.headBranch);
    },
    openPrFor,
    profile: prProfile,
    policy: prPolicyFor,
    mailbox,
    lang: () => currentLang(),
    changed: () => notify(),
    now: Date.now,
    log: logger,
  });
  const assessment = new AssessmentService({
    prs: ticketPrs,
    preReviews: preReviewRepo,
    repo: assessRepo,
    gaps: (row) => preReview.gaps(row),
    preReviewView: (row) => preReview.view(row),
    preReviewEnabled: preReviewActive,
    policy: prPolicyFor,
    checks: sessionChecks,
    sessionOf: prRecipient,
    openCommentItems: (prId) => {
      const pr = ticketPrs.get(prId);
      if (!pr || !loopPolicyFor(pr.slug, pr.ticketKey)["comments.enabled"]) return null;
      return commentItems.byPr(prId).filter((c) => c.state === "pending" || c.state === "review" || c.state === "queued" || c.state === "delivered").length;
    },
    waitingOnGate: (pr) =>
      pr.headBranch !== null && gateRepo.activeHolds().some((h) => gateRepo.waitersOf(h.id).some((w) => w.ticketKey === pr.ticketKey && w.branch === pr.headBranch)),
    files: prFilesOf,
    recordEvent,
    lang: () => currentLang(),
    changed: () => notify(),
    now: Date.now,
    log: logger,
  });
  const briefs = new BriefService({
    repo: assessRepo,
    preReviews: preReviewRepo,
    prs: ticketPrs,
    assessment,
    gaps: (row) => preReview.gaps(row),
    policy: prPolicyFor,
    ticketTitle,
    exec: prExec,
    external: externalActions,
    ghCwd: (pr) => prGhDir(pr),
    gh: { body: (cwd, ref) => prBody(cwd, ref), edit: (o) => editPrBody(o) },
    lang: () => currentLang(),
    changed: () => notify(),
    now: Date.now,
    log: logger,
  });
  setStackBriefProvider(briefs.briefProvider);
  bgQueue.register("pre_review", makePreReviewHandler({
    repo: preReviewRepo,
    diff: async (row) => {
      const pr = row.prId !== null ? ticketPrs.get(row.prId) : openPrFor(row.ticketKey, row.target);
      // 交证据早于开 PR：没有 base 就用仓库的默认分支。
      const base = row.base ?? pr?.baseBranch ?? (row.cwd ? await defaultBase(row.cwd).catch(() => null) : null);
      if (row.cwd && base) {
        const local = await prDiff(row.cwd, row.target.headSha, base).catch(() => null);
        if (local) return local;
      }
      if (!pr?.baseBranch) return null;
      const rows = await compareFiles(prGhDir(pr), pr.baseBranch, row.target.headSha, 60_000, pr.slug);
      return rows ? fromCompare(rows) : null;
    },
    lessons: (slug, files) => relevantLessons(lessonsRepo, [slug], files),
    checks: sessionChecks,
    ci: (prId) => {
      const ci = prId !== null ? ticketPrs.get(prId)?.ci : null;
      return ci === "pending" || ci === "passing" || ci === "failing" ? ci : null;
    },
    profile: prProfile,
    policy: prPolicyFor,
    ticketTitle,
    producer: (id) => {
      const model = id ? sessions.get(id)?.model : null;
      const tier = model ? registryTier(routing.config(), model) : null;
      return model && tier ? { model, tier } : null;
    },
    exec: prExec,
    rerun: { git: git.git },
    addDirs: (row) => (row.ticketKey ? tickets.listRepos(row.ticketKey).map((r) => r.repoPath).filter((p) => p !== row.cwd) : []),
    lang: () => currentLang(),
    after: async (row) => {
      if (row.prId !== null) await assessment.assess(row.prId);
      await briefs.generate(row);
    },
    deliver: async (row) => {
      await preReview.deliver(row);
    },
    changed: () => notify(),
    now: Date.now,
    log: logger,
  }), {
    // 同一个 worktree 的预审一个接一个（复跑命令、查 HEAD 会互相干扰）；不同 worktree 的按并发数同时跑。
    lockKey: (job) => {
      const id = Number((job.payload as PreReviewPayload | null)?.preReviewId);
      return preReviewLockKey(Number.isFinite(id) ? (preReviewRepo.get(id)?.cwd ?? null) : null);
    },
  });
  const reviewCollector = new ReviewEffectCollector({
    db,
    repo: reviewEffectRepo,
    files: (pr) => {
      const repo = pr.repoId !== null ? tickets.getRepo(pr.repoId) : null;
      return prFileNames(repo ? ticketService.ghWorkDir(repo) : homedir(), pr.number, 60_000, pr.slug);
    },
    now: Date.now,
    log: logger,
  });
  const openPrIds = (): number[] => ticketPrs.all().filter((p) => p.state === "open").map((p) => p.id);
  const reassessAll = (): void => void assessment.assessAll(openPrIds()).catch((e: unknown) => logger("assess: reassessing open PRs failed", e));
  prPolicies.onChange(reassessAll);
  afterConfigApplied = reassessAll;
  const prWatcher = new PrWatcher({
    prs: ticketPrs,
    branches: branchWatch,
    tickets: () => tickets.list(),
    repoOf: (repoId) => tickets.getRepo(repoId),
    ghWorkDir: (r) => ticketService.ghWorkDir(r),
    // 休眠着的也算：它在等 CI，CI 有结论就要叫醒它。
    sessionOpen: (key, repoId) => sessionService.hasLiveSession(key, repoId ?? undefined),
    home: homedir(),
    slugOf: (path) => repoIdentity.slugOf(path),
    linker: prLinker,
    gh: { prStatus: prRead, prsForBranch, branchRuns, failedLogDetail, reviewComments, reviewAuthors, prBatch },
    onSlugMoved: (from, to) => repoRenames.suggest(from, to),
    git: { firstCommitAt: git.firstCommitAt },
    stages: prStages,
    owners: branchOwners,
    onMerged: (pr, repoPath) => {
      // 栈底合并了：整栈 rebase、下一层升成栈底（工作流 K；失败只记日志，不让 lessons 那边重来）。
      lessonRunner.merged({ repoPath, slug: pr.slug }, pr.number);
      if (repoPath) void stackService.onMerged({ url: pr.url, number: pr.number, headSha: pr.headSha, headBranch: pr.headBranch }, repoPath).catch((e: unknown) => logger(`stacks: after ${pr.url} merged failed`, e));
      void reviewCollector.collect(pr.id).catch((e: unknown) => logger("review effect: collecting failed", e));
    },
    // PR 的状态或 review 变了：在最新的 handoff 上换掉 prs，存成一条 refresh。ticket 状态、PR 标签、合并后清理 worktree 都照旧走 ingest。
    onPrChanged: (key) => {
      // 归档 ticket 的补链接行读一次也会走到这里：不为它们写 refresh handoff、不同步记忆。
      if (tickets.get(key)?.archivedAt != null) return;
      const base = handoffs.latestValid(key);
      if (!base?.payload) return;
      const next = prHandoff(key, ticketPrs.byTicket(key), { id: base.id, createdAt: base.createdAt, status: base.payload.status, prs: base.payload.prs, blockers: base.payload.blockers });
      if (!next) return;
      // 和早间刷新一样：done_today、followups、decisions、learnings 清空，免得重复计算、重复写进记忆。
      ingest({
        ticketKey: key, sessionId: null, trigger: "refresh",
        payload: {
          ...base.payload, status: next.status, done_today: [], followups: [], decisions: [], learnings: [], prs: next.prs,
          ...(next.clearBlockers && { blockers: [] }),
        },
        rawText: null, sourceRef: next.sourceRef,
      });
    },
    onCiSettled: (item) => void ciDelivery.settled(item).catch((e: unknown) => logger("ci delivery: handing over a CI result failed", e)),
    onPrRead: (rows, pr, where) => {
      for (const r of rows) {
        try {
          preReview.onPrSeen(r);
        } catch (e) {
          logger("pre-review: queuing for a PR failed", e);
        }
      }
      void assessment.observe(rows, pr).catch((e: unknown) => logger("assess: observing a PR failed", e));
      return commentLoop.observe(rows, pr, where);
    },
    onHumanComment: (ticketKey, prNumber, count) => {
      for (let i = 0; i < count; i++) notifier?.emit("review_comment", { ticketKey, prNumber });
    },
    notify,
    // 每轮之后再递一遍：session 停着但当时用户在打字、有草稿的，安静下来之后在这里递出去。
    roundDone: () => {
      void flushCi();
      void preReview.flush().catch((e: unknown) => logger("pre-review: flush failed", e));
    },
    now: Date.now,
    log: logger,
  });
  // 马上查一个 ticket 的 PR：谁发起的决定强不强制读放弃了的，等决定的 ticket 连关掉的也读（prRefreshOptions）。
  const soonTicketPrs = (key: string, source: TicketCloseSource | "session"): void => {
    const t = tickets.get(key);
    prWatcher.soonTicket(key, prRefreshOptions(t ? effectiveStatus(t) : null, source));
  };
  const mergeGate = new MergeGate({
    tickets, repo: gateRepo, git, prInfo, whoOf,
    repoOfSlug: (slug, cwdRepo) => {
      const remotesOf = (p: string) => {
        const origin = [repoIdentity.slugOf(p), repoIdentity.rawSlugOf(p)].filter((x): x is string => x !== null);
        return { origin, upstream: repoIdentity.remoteSlugsOf(p).filter((x) => !origin.includes(x)) };
      };
      if (cwdRepo === undefined) return locateRepo(slug, tickets.list().filter((t) => t.archivedAt === null).flatMap((t) => t.repos.map((r) => r.repoPath)), remotesOf);
      const here = remotesOf(cwdRepo);
      // 读不出它的 remote（git 超时、没有 remote）：按没写 -R 时一样，在这个仓库里按 origin 查。
      if (here.origin.length === 0 && here.upstream.length === 0) return { path: cwdRepo, remote: "origin" };
      return locateRepo(slug, [cwdRepo], () => here);
    },
    openTerminals: (key) => sessionService.openTerminalCount(key),
    notify: () => notify(),
    checkSoon: () => holdWatcher.soon(),
    // 新链接的行 checked_at 为 0，下一轮就会读，不用再催。
    onPrHold: (id) => {
      const hold = gateRepo.hold(id);
      if (hold) prLinker.linkHold(hold, (s) => sessions.get(s)?.ticketKey ?? null);
    },
    now: Date.now,
    log: logger,
  });
  // 自动接活（工作流 N）：拉来源 → 分类（规则优先，判不了的经 intake_classify）→ 决定 → 后台队列 intake 开工。
  // 总开关是 intake_policies 的 enabled（默认哪层都没开）：没开时不拉、不记、什么都不做，和以前一样。
  const intakeRepo = new IntakeRepo(db);
  const intakePolicies = new IntakePolicyService({
    db, now: Date.now,
    productsOf: (slug) => lessonsRepo.productsOf(slug),
    productName: (id) => lessonsRepo.product(id)?.name ?? null,
    onChange: () => notify(),
  });
  const intakeRepoMap = () => parseRepoMap(settings.get("intakeRepoMap")).rules;
  const intakeSourceKind = (): IntakeSourceKind => {
    const v = settings.get("intakeSource");
    return v === "tracker" || v === "file" ? v : "none";
  };
  const intakeSource = (): IntakeSource | null => {
    const kind = intakeSourceKind();
    if (kind === "file") return settings.get("intakeFilePath") ? fileSource(settings.get("intakeFilePath")) : null;
    if (kind === "tracker") {
      return trackerSource(
        prExec, () => settings.get("intakeTrackerDir") || (intakeRepoMap()[0]?.path ?? null), settings.get("intakeTrackerQuery"),
        () => trackerTools(settings), () => currentLang(),
      );
    }
    return null;
  };
  const intake = new IntakeService({
    repo: intakeRepo,
    policies: intakePolicies,
    sourceKind: intakeSourceKind,
    source: intakeSource,
    repoMap: intakeRepoMap,
    slugOf: async (p) => repoIdentity.slugOf(p),
    riskPolicy: (slug) => (slug ? prPolicyFor(slug) : defaultPrPolicy()).risk,
    validKey: (k) => isValidTicketKey(k, settings.get("ticketPattern")),
    ticketExists: (k) => tickets.get(k) !== null,
    classifyModel: (t, decided, cwd) => classifyByModel(prExec, cwd, t, decided, currentLang()),
    lang: () => currentLang(),
    preReviewOn: preReviewActive,
    gateOpen: () => bgScheduler.gate("intake").run,
    enqueue: (key) => {
      bgQueue.enqueue("intake", { key }, { ticketKey: key, dedupeKey: `intake:${key}` });
      bgQueue.wake("intake");
    },
    costAllows: (key) => costBreaker?.allowBackground(key) ?? true,
    openTerminals: (key) => sessionService.openTerminalCount(key),
    activeInRepo: (repoPath) =>
      activeInRepo(repoPath, {
        tickets: () => tickets.list(),
        openTerminalCount: (key) => sessionService.openTerminalCount(key),
        heldTickets: () => gateRepo.activeHolds().map((h) => h.ticketKey),
        workDir: (r) => ticketService.workDir(r),
        changedPaths: (cwd) => changedPaths(cwd, git.git),
        samePath,
      }),
    sessionModel: (tier) => routing.sessionModel(tier),
    createTicket: async (i) => {
      try {
        // 有父 epic 的建进对应的 Shipherd epic（按 Jira epic key 去重，没有就新建，BTL-246 §7）。
        // ticket 建不出来时，这次新建的 epic 要是还空着就一起删掉，不留空壳（BTL-248）。
        const create = (featureId: number | null) =>
          ticketService.create({
            key: i.key, title: i.title, repoPath: i.repoPath, workMode: "worktree", ...(featureId !== null && { featureId }), ...(i.startPoint && { startPoints: [{ repoPath: i.repoPath, ref: i.startPoint }] }),
          });
        const t = i.epic ? await featureService.withJiraEpic(i.epic, i.repoPath, create).finally(() => notify()) : await create(null);
        const r = t.repos[0];
        if (!r) return { ok: false, exists: false, message: "no repo" };
        notify();
        return { ok: true, repoId: r.id, branch: r.branch };
      } catch (e) {
        if (e instanceof TicketError) return { ok: false, exists: e.code === "exists" || e.code === "archived", retry: e.code === "busy", message: e.message };
        return { ok: false, exists: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    ticketRepo: (key) => {
      const r = tickets.listRepos(key)[0];
      return r ? { repoId: r.id, branch: r.branch } : null;
    },
    openSession: async (key, repoId, model) => {
      const r = await sessionService.open({ ticketKey: key, repoId }, { model: model ?? undefined });
      if (!r.ok) return { ok: false, message: r.reason };
      notify();
      return { ok: true, termId: r.termId };
    },
    submit: (termId, text) => {
      void submitTask(termId, taskMessage(sanitizeTask(text), currentLang(), memoryOn(settings) ? "ticket" : null)).then(
        (res) => res === "sent" || logger(`intake: task for ${termId} not delivered (${res})`),
        (e: unknown) => logger(`intake: task for ${termId} failed`, e),
      );
    },
    stack: {
      canStackOn: (repoPath, parentBranch) => stackService.canStackOn(repoPath, parentBranch),
      stackOn: ({ ticketKey, ...p }) => stackService.stackOn({ ...p, featureId: tickets.get(ticketKey)?.featureId ?? null }),
    },
    hasPr: (key) => ticketPrs.byTicket(key).length > 0,
    prOf: (key) => {
      const pr = ticketPrs.byTicket(key)[0];
      if (!pr) return null;
      const s = assessRepo.summaries([pr.id]).get(pr.id);
      return { number: pr.number, url: pr.url, risk: s?.risk ?? null, ready: s?.ready ?? null };
    },
    external: {
      allowed: (kind, scope) => externalActions.allowed(kind, scope),
      record: (kind, r) => void externalActions.record(kind, { scope: r.scope, target: r.target, summary: r.summary, outcome: r.outcome, error: r.error ?? null }),
    },
    // 全局总控开着就排进它的信箱（BTL-248）；没开返回 false，退回成通知。
    toCoordinator: async (text) => {
      const b = sessionService.runningShipherd();
      if (!b) return false;
      mailbox.send({ kind: "shipherd", from: null, to: b.id, featureId: null, body: sanitizeTask(text) });
      return true;
    },
    // Jira epic 对应的 Shipherd epic 自己选了档位：它的 ticket 接进来以后整理还是开工按它（BTL-247 接 BTL-246 §7）。
    epicLevel: (epicKey) => {
      const f = features.byJiraEpic(epicKey);
      return f ? automation.overrideForFeature(f.id) : null;
    },
    toEpicCoordinator: async (epic, repoPath, text) => {
      const featureId = await featureService.ensureJiraEpic(epic, repoPath);
      notify();
      // 排进 epic 总控的信箱（BTL-245）：在忙的下一次调用工具时读到，停着的直接输入，关着的下次打开时第一条读到。
      // hold：马上要打开它，不让信箱再去唤醒一次（免得两边同时 --resume 同一个 session）。
      const body = text.slice(0, MAILBOX_BODY_LIMIT);
      const send = (to: string, hold = false) => mailbox.send({ kind: "shipherd", from: null, to, featureId, body, hold });
      const running = sessionService.runningCoordinator(featureId);
      if (running) {
        send(running.id);
        return { ok: true };
      }
      // 总控没开：和用户点开一样接着最近那个，开之前按内存放行（工作流 W）。先排进接着的那个的信箱：开不了也不丢。
      const resume = sessions.listFeatureCoordinators(featureId).find((x) => x.coordinator && x.replacedBy === null && !x.dismissed);
      if (resume) send(resume.id, true);
      const room = await admitOrRefuse(admission, `intake epic ${epic.key}`);
      if (!room.ok) return resume ? { ok: true } : { ok: false, message: room.error };
      const r = await sessionService.openFeature({ featureId, ...(resume && { sessionId: resume.id }) }).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
      if (!r.ok || ("alreadyOpen" in r && r.alreadyOpen)) room.release();
      if (!r.ok) return resume ? { ok: true } : { ok: false, message: r.reason };
      notify();
      const head = sessions.head(r.termId)?.id ?? r.termId;
      // 等内存放行时用户自己点开了：信箱照常送（在忙走 hook，停着直接输入）。
      if ("alreadyOpen" in r && r.alreadyOpen) {
        if (!resume) send(head);
        return { ok: true };
      }
      if (!resume) send(head, true);
      void mailbox.opened(head, r.termId, submitTask).catch((e: unknown) => logger(`intake: epic ${epic.key} message for ${head} failed`, e));
      return { ok: true };
    },
    recordEvent,
    metricEvents: (since, kinds) => metricsRepo.events(since, kinds),
    knownRepos: () => {
      const paths: string[] = [...IntakeService.mappedPaths(intakeRepoMap())];
      for (const t of tickets.list()) for (const r of t.repos) if (!paths.some((p) => samePath(p, r.repoPath))) paths.push(r.repoPath);
      return paths.slice(0, 200).map((path) => ({ path, slug: repoIdentity.slugOf(path) }));
    },
    now: Date.now,
    log: logger,
    onChange: () => notify(),
  });
  bgQueue.register("intake", (ctx) => intake.handle(ctx));
  intake.resume();
  intakeEnded = () => intake.sessionEnded(() => bgQueue.wake("intake"));
  // 定时拉：每分钟看一次到没到 intakePollMinutes；总开关关着、来源没配时 poll 直接返回。
  let intakeLastPoll = 0;
  const intakePollMs = (): number => Math.min(1440, Math.max(5, Number(settings.get("intakePollMinutes")) || 15)) * 60_000;
  const intakeTick = (force = false): void => {
    if (closing || headlessAbort.signal.aborted || !intake.active()) return;
    if (!force && Date.now() - intakeLastPoll < intakePollMs()) return;
    intakeLastPoll = Date.now();
    void intake.poll().catch((e: unknown) => logger("intake: poll failed", e));
  };
  const intakePollSoon = (): void => {
    // 搁着的项按新设置重新决定（内容没变的拉取不碰它们），然后拉一次。
    setTimeout(() => void intake.reevaluate().catch((e: unknown) => logger("intake: re-deciding failed", e)).finally(() => intakeTick(true)), 1_000);
  };
  // hook 最多等 5 秒：轮询要快；超过 10 秒的请求那边早就放行了。handle 抛错也放行。排队的时间算进裁决期限（meta.ageMs）。
  const gateInbox = new ControlInbox<GateRequest, GateResult>({
    requestsDir: paths.gateRequests,
    resultsDir: paths.gateResults,
    parse: parseGateRequest,
    badResult: () => ({ v: 1, decision: "allow" }),
    handle: (req, meta) => mergeGate.handle(req, meta),
    intervalMs: 200,
    maxRequestAgeMs: 10_000,
    log: logger,
  });

  /**
   * 一个 session 停下来等输入了（Stop hook、终端重新打开、全新启动，或者 transcript 显示这一轮没经过 Stop 就结束了）：
   * 合并通知和 CI 结论一般早就排进信箱了（BTL-248），这里接住排队时出错的，并且马上查一次这个仓库的 PR 和 CI（刚停下的 session 常常刚 push）。
   */
  const sessionStopped = (stopped: string): void => {
    holdWatcher.sessionIdle(stopped);
    patrolTurns.stopped(sessions.head(stopped)?.id ?? stopped);
    // 权限档案省掉了几次确认（ws-j）：只读 transcript 新增的部分。
    void profileHits.sessionStopped(stopped).catch((e: unknown) => logger("permission profile: counting hits failed", e));
    // 熔断压着的「接着做」（降档、提高上限以后）趁现在递（工作流 L）。
    void costBreaker?.sessionStopped(stopped).catch((e: unknown) => logger("cost: nudging after Stop failed", e));
    // 活动没变时 activityMonitor 不会 notify：停下来以后的「需要你」判断在这里补一次。
    void refreshActivityOf(stopped)
      .catch((e: unknown) => logger(`ci delivery: re-reading the activity of ${stopped} failed`, e))
      .then(() => {
        needsYou.update();
        // 卡片上答好的回答、该送给总控的汇报也趁现在送（永不 reject）。
        void inboxService.flush();
        // 信箱（BTL-245）：它收过等回复的消息就把这一轮的最后一条回复送回去，再把排着的消息直接输入（永不 reject）。
        void mailbox.stopped(stopped);
        // 在等 Shipherd 总控停下来的巡检也趁现在送（BTL-190 第 5 点，永不 reject）。
        if (!headlessAbort.signal.aborted) void shipherdPatrol.check();
        return flushCi();
      });
    // 这个 ticket 的 PR 都马上查一次；feature 总控查它所有 ticket 的；别的按仓库。
    const head = sessions.head(stopped);
    // epic 记忆（BTL-246 §5）：epic 里任何 session 停下来时，笔记快满就把最旧的挪进存档、重新渲染 handoff（永不 reject）。
    const epicId = head?.featureId ?? (head?.ticketKey ? tickets.get(head.ticketKey)?.featureId : null) ?? null;
    if (epicId !== null) void memory.syncFeature(epicId);
    // 栈（工作流 K）：这一层有新提交就 rebase 上面的层；没递进去的冲突趁现在补送。
    if (head?.ticketKey) void stackService.sessionStopped(head.ticketKey).catch((e: unknown) => logger(`stacks: after ${stopped} stopped failed`, e));
    if (head?.ticketKey) soonTicketPrs(head.ticketKey, "session");
    // 总控停下来：epic 里每个 ticket 都查一遍，但放弃了的 PR 不跟着重试（BTL-261：不然它们每一轮都被读）。
    else if (head?.coordinator && head.featureId != null) for (const t of tickets.listByFeature(head.featureId)) prWatcher.soonTicket(t.key, { retryGivenUp: false });
    else if (head?.repoId != null) prWatcher.soon(head.repoId);
  };

  const branchOwnership = new BranchOwnership({
    tickets,
    sessionTicket: (id) => sessions.head(id)?.ticketKey ?? null,
    currentBranch: git.currentBranch,
    mainRepoRoot: git.mainRepoRoot,
    owners: branchOwners,
    linker: prLinker,
    isCoordinator: (id) => sessions.head(id)?.coordinator ?? false,
    isOpen: (id) => gateTerm(id) !== null,
    soon: (repoId) => prWatcher.soon(repoId),
    exists: existsSync,
    home: homedir(),
    win: process.platform === "win32",
    now: Date.now,
    log: logger,
  });

  const inbox = new HookInbox({
    dir: paths.inbox,
    badDir: paths.inboxBad,
    log: (m) => logger(m),
    handle: (env) => {
      // 信箱 hook 送完了（BTL-245）：马上清扫这个终端的 .done，记成送达。
      const mp = env.payload && typeof env.payload === "object" ? (env.payload as { hook_event_name?: unknown }) : null;
      if (mp?.hook_event_name === MAILBOX_EVENT) {
        if (env.shipherdSession) mailbox.sweep(env.shipherdSession);
        return;
      }
      // 约定广播（BTL-245）：存进 feature 记忆的 remember 推给同一个 feature 里开着的其他 session。
      broadcastConvention({
        head: (id) => sessions.head(id),
        ticketFeature: (key) => tickets.get(key)?.featureId ?? null,
        openTerms: () => pty.openIds(),
        nameOf: mailboxName,
        send: (x) => mailbox.send(x),
      }, env);
      const effect = applyHookEnvelope(env, {
        sessions, tickets, transcriptState: (id) => transcriptLocator.state(id),
        placement: (key, cwd) => ticketService.placement(key, cwd),
        featureForCwd,
      });
      // Stop 之后看这一轮有没有 /handoff 的输出（异步；失败只记日志，不影响 hook 处理）。
      const stop = stopFromEnvelope(env);
      if (stop) {
        void captureCommandHandoff({ sessions, tickets, ingest, ingestFeature, afterFeatureCommand }, stop).then(
          (r) => {
            // 换新在等这个 session 的 /handoff 收进来（ticket 的和 feature 总控的都算）。校验没过（degraded）的没写进记忆，
            // 清空以后接不上，不算：换新等到超时停下，什么都不再输入。
            if (r?.stored && !r.degraded) refresher.handoffStored(stop.sessionId);
            // 总控写成了 ticket 代码块（BTL-267）：已按总控身份换成 feature 汇总存下，记一笔。
            if (r?.stored && "featureId" in r && r.fromTicketBlock) {
              logger(`/handoff in feature ${r.featureId} coordinator session ${stop.sessionId}: printed a ticket shipherd-handoff block instead of a shipherd-feature-handoff block; stored it as the feature handoff`);
            }
            if (r?.stored) notify();
            // feature 总控（设计文档 2026-10-28）：没存下时记一笔；子 ticket 的 handoff 照样在后台跑（afterFeatureCommand）。
            else if (r && "featureId" in r) {
              const where = `/handoff in feature ${r.featureId} coordinator session ${stop.sessionId}`;
              if (r.reason === "wrong_block") logger(`${where}: printed a ticket shipherd-handoff block instead of a shipherd-feature-handoff block that could not be turned into a feature handoff (invalid or empty); not stored`);
              else if (r.reason === "no_block") logger(`${where}: no feature handoff block found in the transcript; not stored`);
              else if (r.reason === "no_feature") logger(`${where}: the feature no longer exists; not stored`);
            }
            // session 没有归属 ticket、输出里的 ticket 号也不存在，或者等了几次都没读到结果：记一笔，免得用户以为采集坏了。
            else if (r && r.reason === "no_ticket") logger(`/handoff output in session ${stop.sessionId} names no known ticket; not stored`);
            else if (r && r.reason === "no_block") logger(`/handoff in session ${stop.sessionId}: no handoff block found in the transcript; not stored`);
          },
          (e: unknown) => logger("capture /handoff failed", e),
        );
      }
      // 推送和开 PR 记下分支是谁的（工作流 W）。同样在 ignored 提前返回之前（PostToolUse）。
      void branchOwnership.handle(env).catch((e: unknown) => logger("branch owner: recording failed", e));
      // gh pr merge / close / reopen 跑完（BTL-270）：马上重读动到的 ticket 的 PR（关掉、合并了的也读，reopen 才看得到），不等下一轮轮询。
      // 不重试放弃了的、认定不存在的（BTL-261）：跑一条 gh 命令不是用户点刷新。
      const prCmd = prStateFromEnvelope(env);
      if (prCmd) {
        for (const key of ticketsForPrCommands(prCmd, prCommandDeps)) prWatcher.soonTicket(key, { includeSettled: true, retryGivenUp: false });
      }
      // 设计 / 自我 review 的 skill 调用记进 PR 进度。必须在 ignored 提前返回之前：PostToolUse 在 applyHookEnvelope 里恒为 ignored。
      const stageObs = stageEventFromHook(env, sessions);
      if (stageObs && prStages.add(stageObs.event, stageObs.dedupeKey)) notify();
      if (effect.kind === "ignored") return;
      // 记录文件快要有了（SessionStart、UserPromptSubmit）：忘掉「没找到」的记忆（BTL-275）。
      if (effect.kind === "session_started" || (effect.kind === "waiting" && !effect.waiting)) transcriptLocator.forget(effect.sessionId);
      // 总控开的子 session 等这个信号才交任务（信任文件夹之类的启动对话框已经过去）。
      // 终端按 SHIPHERD_SESSION 记：--resume 有时换 session id，唤醒（WS-M B）和交任务等的都是终端的 id。
      if (effect.kind === "session_started") {
        pty.markStarted(env.shipherdSession ?? effect.sessionId);
        // 信箱：/clear、resume 之后 head 换了，投影按新的 head 对一遍。
        mailbox.syncTerm(env.shipherdSession ?? effect.sessionId);
      }
      // claude 收下了一条输入（UserPromptSubmit）：deliver 回车以后等的就是它（BTL-190 第 9 点）。终端按 SHIPHERD_SESSION 记，
      // /clear 以后 hook 里的 session id 已经换了。
      // 同一个时机：用户在终端里回答了，这个 session 卡片上还没答的「待你决定」都算答过（换新、Shipherd 刚递回答时不算，BTL-190 第 2+3 点）。
      if (effect.kind === "waiting" && !effect.waiting) {
        // 先记人介入（ws-h）：markSubmitted 之后就分不出这是不是 Shipherd 递进去的了。终端里嵌套的 claude 的输入不算（不抛）。
        const termId = env.shipherdSession ?? effect.sessionId;
        if (promptOnTerminalChain((id) => sessions.head(id)?.id ?? null, effect.sessionId, termId)) terminalMeter.promptSubmitted(termId);
        pty.markSubmitted(env.shipherdSession ?? effect.sessionId);
        procs?.terminalActive(env.shipherdSession ?? effect.sessionId);
        inboxService.promptSubmitted(env.shipherdSession ?? effect.sessionId);
        // 马上重读活动：实况窗口里它立刻算在干活（BTL-190 第 7 点）。
        void activityMonitor.promptSubmitted(env.shipherdSession ?? effect.sessionId).catch((e: unknown) => logger("re-reading the activity on prompt submit failed", e));
      }
      // claude 停下来等输入了：有“对方已经合完”的通知就趁现在发（设计文档 2026-11-04：不打断忙着的 session）。
      // 同一个时机也递还没递出去的 CI 结论（先重读活动），并且马上查一次这个仓库的 PR 和 CI（刚停下的 session 常常刚 push）。
      // 终端重新打开（--resume）的 session 停在输入框等着（hook-events 记成 waiting）：和停下来一样，马上递卡片上答好的回答等。
      // 全新启动的也一样（hook-events 记成 waiting）：没人打过字就不会有 Stop，不在这里送的话，等着的回答和汇报要等到用户先说一句话。
      if ((effect.kind === "waiting" && effect.waiting) || (effect.kind === "session_started" && (effect.resumed === true || effect.fresh === true))) {
        sessionStopped(env.shipherdSession ?? effect.sessionId);
      }
      notify();
      // 还没归属 ticket、又缺 cwd / 分支 / 首条提示的 session：触发一次发现（每个 session 每次运行最多一次）。
      if (effect.kind !== "nested") {
        const s = sessions.get(effect.sessionId);
        if (s && outsideSessionsOn(settings) && needsDiscovery(s, discoveryRequested)) {
          discoveryPending.add(s.id);
          scheduleDiscovery();
        }
        // 分支不再靠扫描补（扫描默认关）：Shipherd 自己的 session 从目录读一次（BTL-244）。
        if (s) {
          void fillBranchFromCwd(s, { tried: branchTried, currentBranch: git.currentBranch, fill: (id, branch) => sessions.fillDetails(id, { gitBranch: branch }) })
            .catch((e: unknown) => logger("reading a session's branch failed", e));
        }
      }
    },
  });

  // before-quit 里先停换新再关终端：终端关掉时正在等的换新不再输入、不再读库（will-quit 里数据库就关了），也不当作失败。
  procs = createProcServices({
    settings, sessions, samples: new MemorySamplesRepo(db), pty,
    activity: (id) => activityMonitor.get(id),
    refresher,
    appMetrics: () => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, kb: m.memory.workingSetSize })),
    windowShown: windowVisible,
    ownedFile: paths.procsOwned,
    pinned: (head) => sessions.head(head)?.pinned === true,
    restart: (head) => hibernator?.restart(head) ?? Promise.resolve(),
    onSample: (s) => hibernator?.onSample(s),
    sampleNeeded: () => memoryPressureOn(settings),
    log: logger,
    changed: () => notify("procs"),
  });
  const procServices = procs;
  // e2e（后台窗口模式下才算数）：SHIPHERD_HIBERNATE_AFTER_MS 把四种等待的分钟数都换成这么多毫秒，安静期也一起缩短。
  const hibernateAfterMs = BACKGROUND_WINDOWS ? Number(process.env.SHIPHERD_HIBERNATE_AFTER_MS) || 0 : 0;
  const shipherdTerminals = () =>
    pty.openIds().flatMap((termId) => {
      const head = sessions.head(termId);
      return head && head.origin === "shipherd" ? [{ termId, head }] : [];
    });
  const scope = { ticketsOfFeature: (id: number) => tickets.listByFeature(id).map((t) => t.key) };
  const prPending = (key: string | null, ci: "pending" | "review"): boolean =>
    key != null &&
    prWatcher.statusOf(key).some((p) =>
      ci === "pending" ? (p.state === "open" || p.state === null) && p.ci === "pending" : p.state === "open" && p.ci !== "pending" && p.review !== "approved",
    );
  // 开新 session 前按内存放行（工作流 W）：取代以前每 ticket、每 feature 写死的上限。
  // 只数开着终端的：休眠的 session 进程已经结束，不占内存，也不在 pty.openIds() 里。
  // 每个 session 的预估：有工作流 M 的实测就用开着的 session 的实测平均，没有就用设置里的值。
  // SHIPHERD_E2E_AVAILABLE_MB 只在没打包时生效（e2e 用）。
  const memoryReadDeps = defaultReadDeps((file, args) => execText(file, args, { timeoutMs: 2_000 }), app.isPackaged);
  // 启动时记一次读数（附录第 7 节）：看得出这台机器上 vm_stat 算出来的可用内存合不合理。
  void memorySnapshotLine(memoryReadDeps).then((line) => logger(`memory at startup: ${line}`), (e: unknown) => logger("memory at startup: reading failed", e));
  const admission = memoryAdmission = new MemoryAdmission({
    read: () => readAvailableMemory(memoryReadDeps),
    settings: () => sessionAdmission(settings),
    measuredSessionsKb: () => measuredOpenSessionsKb(
      pty.openIds().flatMap((termId) => {
        const h = sessions.head(termId);
        return h ? [{ head: h.id, openedAt: pty.openedAt(termId) }] : [];
      }),
      (head) => procServices.monitor.memoryOf(head),
      Date.now(),
    ),
    running: () => pty.openIds().length,
    now: () => Date.now(),
    log: logger,
  });
  hibernator = new Hibernator({
    enabled: () => hibernateOn(settings),
    minutes: (state) => (hibernateAfterMs > 0 ? hibernateAfterMs / 60_000 : hibernateMinutes(settings, state)),
    endWatchers: () => hibernateEndWatchersOn(settings),
    pressureOn: () => memoryPressureOn(settings),
    pressureLine: () => memoryPressureFreePercent(settings),
    terminals: shipherdTerminals,
    candidate: (t) => {
      const a = activityMonitor.get(t.head.id);
      const typed = pty.lastUserInputAt(t.termId);
      const terms = shipherdTerminals();
      return {
        head: t.head, termId: t.termId, pinned: t.head.pinned === true,
        transcript: transcriptLocator.state(t.head.id),
        activity: a && { working: working(a), background: a.background },
        screenNeedsUser: pty.screenNeedsUser(t.termId),
        draft: pty.hasDraft(t.termId),
        typing: typed > 0 && Date.now() - typed < (guardDeps.typingQuietMs ?? USER_TYPING_QUIET_MS),
        autoInput: pty.autoInputInFlight(t.termId),
        refreshing: refresher.isRefreshing(t.head.id),
        visible: procServices.isVisible(t.termId),
        childrenWorking: childrenWorking(t.head, terms.map((x) => x.head), (id) => working(activityMonitor.get(id)), scope),
        openedAt: pty.openedAt(t.termId),
        idleSince: Math.max(t.head.lastActivityAt ?? 0, a?.lastOutputAt ?? 0, typed, pty.openedAt(t.termId)),
      };
    },
    waitInput: (h) => ({
      needsYou: needsYou.reasonOf(h.id) !== null || inboxService.hasPendingDecision(h.id),
      ciPending: [...gateRepo.waitingSessionIds()].some((id) => (sessions.head(id)?.id ?? id) === h.id) || prPending(h.ticketKey, "pending"),
      reviewPending: prPending(h.ticketKey, "review"),
    }),
    sessions,
    readTable: () => readProcTable(process.platform),
    pid: (termId) => pty.pid(termId),
    isOpen: (termId) => pty.isOpen(termId),
    started: (termId) => pty.started(termId),
    reserve: (termId) => pty.reserve(termId),
    endTerminal: (termId) => pty.kill(termId),
    kill: platformKill(process.platform, (cmd, args) => void execFile(cmd, args, { windowsHide: true }, () => undefined)),
    spare: (owner, list) => procServices.orphans.spare(owner, list),
    release: (owner) => void procServices.orphans.release(owner).catch((e: unknown) => logger("hibernate: releasing kept watchers failed", e)),
    open: (head) => openHibernated(head),
    notify,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logger,
    ...(hibernateAfterMs > 0 && { quiet: { openMs: hibernateAfterMs, wakeMs: hibernateAfterMs } }),
  });
  /** 按种类 --resume 一个 head（不 force：分支对不上就算打不开，交给用户）。 */
  const openByKind = async (head: Session): Promise<{ ok: true; termId: string; alreadyOpen: boolean } | { ok: false; reason: string }> => {
    const r = head.shipherd && head.ticketKey === null ? await sessionService.openShipherd({ sessionId: head.id })
      : head.ticketKey !== null ? await sessionService.open({ ticketKey: head.ticketKey, sessionId: head.id })
      : head.featureId !== null ? await sessionService.openFeature({ featureId: head.featureId, sessionId: head.id })
      : ({ ok: false, reason: "kind" } as const);
    return r.ok ? { ok: true, termId: r.termId, alreadyOpen: r.alreadyOpen } : { ok: false, reason: r.reason };
  };
  /** 唤醒一个休眠的 head。 */
  const openHibernated = async (head: Session): Promise<{ ok: true; termId: string } | { ok: false; reason: string }> => {
    const r = await openByKind(head);
    // 唤醒不问内存（要递的消息不能被拒），但记成刚开的，紧接着的 start_session 照样扣掉它（工作流 W）。
    if (r.ok && !r.alreadyOpen) admission.note(`wake ${head.id}`);
    return r.ok ? { ok: true, termId: r.termId } : r;
  };
  // 后台恢复关着的 session（BTL-256）：和 start_session 一样先问内存，按种类 --resume，等 SessionStart；起来以后信箱照常送。
  const resumableCtx = {
    ticketArchived: (key: string) => {
      const t = tickets.get(key);
      return !t || t.archivedAt !== null;
    },
    epicArchived: (id: number) => {
      const f = features.get(id);
      return !f || f.archivedAt !== null;
    },
    latestShipherd: () => sessionService.latestShipherd()?.id ?? null,
  };
  const theResumer = resumer = new Resumer({
    head: (id) => sessions.head(id),
    running: (id) => gateTerm(id) !== null,
    resumable: (h, insisted) => resumable(h, resumableCtx, insisted),
    // 「关了的就打开」（BTL-279）：它自己的总控（全局总控 → epic 总控，epic 总控 → 它的 ticket / 修复 session）发来的指示。
    controllerMailSince: (headId) => controllerMailSince(messagesRepo.queued(), headId, (id) => sessions.head(id)?.id ?? id, mailboxControls),
    transcript: (id) => transcriptLocator.state(id),
    admit: (what) => admitOrRefuse(admission, what),
    open: openByKind,
    started: (termId) => pty.started(termId),
    isOpen: (termId) => pty.isOpen(termId),
    setWakeError: (id, error, at) => sessions.setWakeError(id, error, at),
    waitingSenders: (headId) => messagesRepo.queued().flatMap((m) =>
      m.fromSession !== null && (m.kind === "instruction" || m.kind === "shipherd") && (sessions.head(m.toSession)?.id ?? m.toSession) === headId
        ? [{ id: m.id, from: m.fromSession, featureId: m.featureId }] : []),
    receipt: (to, featureId, body) => void mailbox.send({ kind: "reply", from: null, to, featureId, body }),
    nameOf: mailboxName,
    notify,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logger,
  });
  // 重启后自动恢复（BTL-256，设置 autoResumeAfterRestart，默认关）：上次退出时开着终端、总控管的 session，
  // 有未读信箱消息的最先，然后是 ticket 有 PR 开着的；一个一个问内存，第一次不够就停下。
  if (settings.get("autoResumeAfterRestart") === "1" && openAtLastQuit.length > 0) {
    void healthReady.then(async () => {
      const seen = new Set<string>();
      const heads = openAtLastQuit.flatMap((id) => {
        const h = sessions.head(id);
        if (!h || seen.has(h.id)) return [];
        seen.add(h.id);
        return !h.hibernatedAt && h.userEndedAt == null && resumable(h, resumableCtx) ? [h] : [];
      });
      const mail = headsWithWakingMail(messagesRepo.queued(), (id) => sessions.head(id)?.id ?? id);
      const order = restartOrder(heads, (id) => mail.has(id), (h) => h.ticketKey !== null && prWatcher.statusOf(h.ticketKey).some((p) => p.state === "open" || p.state === null));
      logger(`resume after restart: ${order.length} of ${openAtLastQuit.length} session(s) open at the last quit`);
      const r = await theResumer.resumeAll(order);
      if (r.waitingMemory.length > 0) logger(`resume after restart: memory ran short, left closed: ${r.waitingMemory.join(", ")}`);
    }).catch((e: unknown) => logger("resume after restart failed", e));
  }
  windowShownHook = () => procServices.windowShown();
  shutdownSessions = () => {
    hibernator?.stop();
    resumer?.stop();
    void procServices.stop();
    refresher.stop();
    pty.killAll();
  };

  const autostart = {
    get: () => autostartState({ packaged: app.isPackaged, platform: process.platform, openAtLogin: () => app.getLoginItemSettings().openAtLogin }),
    set: (on: boolean) => {
      if (!autostart.get().supported) throw new SettingError(M().autostartUnsupported);
      app.setLoginItemSettings({ openAtLogin: on });
      return autostart.get();
    },
  };

  const featureService = new FeatureService({
    features, tickets, db, now: Date.now,
    onTicketArchived: (key) => {
      removeTicketMcpConfigs(paths.mcp, key);
      inboxService.dismissScope({ ticketKey: key });
    },
  });
  // 防休眠：只在内存里，启动时是关的。状态一变，托盘菜单、提示文字和界面都跟着更新。
  keepAwake = new KeepAwake({
    blocker: powerSaveBlocker,
    onChange: (on) => {
      tray?.setContextMenu(trayMenu());
      tray?.setToolTip(trayTooltip());
      safeSend(IPC.appKeepAwakeChanged, on);
    },
    log: logger,
  });
  /** 「现在」页和「谁该动」看板共用的一份 Shipherd 提醒。 */
  const currentNotices = (): NowNotice[] =>
    collectNotices({
      built: buildNotices({
        availability: availability.view(),
        recentRuns: lessonRuns.recentFinished(20),
        routing: routing.attention(),
        sharedMcpError: sharedMcpOn(settings) && mcpHub.status().state === "failed" ? mcpHub.status().error : null,
      }),
      ci: ciNotices(ciDelivery.undelivered(), (key) => tickets.get(key)?.title ?? null),
      cost: costNotices(costBreaker?.views() ?? [], costTargetOf),
      comments: commentNotices(commentLoop.waiting(), (key) => tickets.get(key)?.title ?? null),
      stack: stackNotices(stackService.notices()),
      backtest: backtest.notices(),
      intake: intakeNotices(intake.notices()),
      behalf: inboxService.behalfNotices((key) => tickets.get(key)?.title ?? null),
      infoflow: infoflow.notices(),
    });
  // 请你 review 的 PR（UI 重做第 1 层，计划 R9）：gh search 的结果整体替换进 review_requests。
  const reviewRequests = new ReviewRequestsRepo(db);
  let unbindReviewFocus: (() => void) | null = null;
  const reviewPoller = new ReviewRequestPoller({
    fetch: () => reviewRequestedPrs(REVIEW_SEARCH_TIMEOUT_MS),
    repo: reviewRequests,
    away: () => idleSignal.locked() || idleSignal.idleSeconds() >= REVIEW_AWAY_IDLE_SECONDS,
    ghAvailable: () => ghAvailable(),
    // 写了 review 请求：看板的输入缓存作废（BTL-242）；别的视图不读 review_requests（BTL-265）。
    changed: () => {
      viewCache.invalidate([VIEW_KEYS.turnInput]);
      turnService.changed();
    },
    now: Date.now,
    log: logger,
  });
  // 所有 ticket 的视图（BTL-265）：单独的 ticket 列表和 feature 视图都从它拼，活动变了不用重拼（view-scopes.ts）。
  const allTicketViews = viewCache.wrap(VIEW_KEYS.ticketsAll, () => perfOp("views.tickets.all", () => sessionService.allTickets()));
  const views = {
    tickets: viewCache.wrap(VIEW_KEYS.tickets, () => perfOp("views.tickets", () => sessionService.ticketViews(allTicketViews()))),
    features: viewCache.wrap(VIEW_KEYS.features, () => perfOp("views.features", () => sessionService.featureViews(allTicketViews()))),
  };
  /** 总控 session（feature 总控和 Shipherd 总控）的 head：开着终端或休眠着的。 */
  const turnCoordinators = () =>
    turnCoordinatorsOf({
      featureViews: views.features,
      runningShipherd: () => sessionService.runningShipherd(),
      hibernatedHeads,
    });
  // 拼首页 turn 输入时每个 PR、每个 session 都要问的（BTL-265）：在一次 turn.input 构建里（turnScope.run）只读一次，构建完就作废。
  // 构建只读不写；sendToAgent 这些在构建外调用，读到的都是现读的。
  const turnScope = new ReadScope();
  const turnHead = turnScope.memo(() => {
    const m = new Map<string, Session | null>();
    return (id: string): Session | null => {
      if (!m.has(id)) m.set(id, sessions.head(id));
      return m.get(id) ?? null;
    };
  });
  const turnTask = {
    head: (id: string): Session | null => turnHead()(id),
    openHeads: turnScope.memo((): Session[] => pty.openIds().flatMap((t) => turnHead()(t) ?? [])),
    hibernatedHeads: turnScope.memo(hibernatedHeads),
    mergeWaiting: turnScope.memo((): Set<string> => new Set([...gateRepo.waitingSessionIds()].map((w) => turnHead()(w)?.id ?? w))),
  };
  const turnRecipientCtx: RecipientCtx = turnTask;
  const turnService = new TurnService({
    cache: (key, build) => viewCache.get(key, build),
    readScope: (build) => turnScope.run(build),
    tickets: views.tickets,
    features: views.features,
    hibernatedHeads: turnTask.hibernatedHeads,
    coordinators: turnCoordinators,
    head: turnTask.head,
    prs: (key) => prWatcher.statusOf(key),
    prRow: (id) => ticketPrs.get(id),
    recipient: (key, repoId, branch) => loopRecipient(key, repoId, branch, turnRecipientCtx),
    activity: (id) => activityMonitor.get(id),
    lastReplyAt: (id) => activityMonitor.lastReplyOf(id)?.at ?? null,
    needsYou: () => ({ reasons: needsYou.reasons(), categories: needsYou.categories() }),
    decisions: () => inboxRepo.pendingDecisions(),
    lastReport: (key) => inboxRepo.lastReport(key),
    refreshing: (id) => refresher.stepOf(id) !== null,
    // 合并排队的等待者记的是 SHIPHERD_SESSION：换成 head 再对。
    mergeQueued: (id) => turnTask.mergeWaiting().has(id),
    risk: (prId, headSha) => {
      const r = assessRepo.risk(prId);
      return r && r.headSha === headSha ? r.level : null;
    },
    ciUndelivered: () => ciDelivery.undelivered(),
    comments: commentLoop,
    ciResend: async (item) => {
      const r = await ciDelivery.resend(item);
      ciStuckChanged();
      return r;
    },
    notices: currentNotices,
    reviews: () => reviewRequests.list(),
    reviewScope: () => (settings.get("reviewRequestScope") === "registered" ? "registered" : "all"),
    registeredSlugs: () => [...lessonsRepo.repos().map((r) => r.slug), ...ticketPrs.slugs()],
    homeOpened: () => reviewPoller.catchUp(),
    stackBelow: (url, branch) => stackService.stackBelow(url, branch),
    emit: () => safeSend(IPC.turnChanged),
    now: Date.now,
  });
  turnChanged = () => safeSend(IPC.turnChanged);
  // 设置变了以后该跑的：设置页保存、套用自动化档位预设都走这里（BTL-247 抽出来给档位用）。
  const onSettingChanged = (key: EditableSettingKey): void => {
    if (key === "checksEnabled" || key === "checksEditTimeoutSec" || key === "checksPushTimeoutSec" || key === "ticketPattern") checkSnapshots.schedule();
    // 后台调度的设置（工作流 L）：马上按新的时段、空闲、额度重算，该让路的让路。提醒线跟着路由阈值。
    if (key.startsWith("bg")) bgScheduler.tick();
    // 预审并发数调大了：马上多取几个。
    if (key === "preReviewConcurrency") bgQueue.pump();
    if (key === "routingThresholds" || key === "routingQuotas") costCheckSoon();
    // 打断减少的开关第一次打开：Effect 页前后对比从这里分界（ws-j）。
    if ((key === "interruptChoiceRule" || key === "interruptChoiceDefaults" || key === "interruptSelfServe") && settings.get(key) === "1") markInterruptEffective(Date.now());
    // 预审开关变了：就绪条件跟着变（工作流 G）。
    if (key === "preReviewEnabled") {
      reassessAll();
      intakePollSoon();
    }
    // 自动接活的来源和间隔（工作流 N）：改了马上按新的拉一次。
    if (key.startsWith("intake")) intakePollSoon();
    // 打开「显示 Shipherd 之外开的 session」：马上扫一次，不等 5 分钟的定时（BTL-244）。
    if (key === "showOutsideSessions") void runDiscovery();
    // 关掉「自动抽要点」：马上跑一遍，把还在排队的要点撤回（BTL-272）。
    if (key === "flowExtract") infoflow.poke();
    // 改了每天的上限：马上跑一遍（调高了就接着问），「现在」页马上刷新（还在上限时，次数、上限、什么时候接着也跟着变）。
    if (key === "flowDailyAsks") {
      infoflow.poke();
      notify();
    }
  };
  automationHooks.settingChanged = onSettingChanged;
  // 三族策略的读写入口：设置 › 自动化的开关、套用档位预设、register 的 loop / stacks / intake 用同一份。
  const loopPolicyIo = {
    policyView: (scope: LoopScope) => loopPolicies.view(scope),
    policySet: (scope: LoopScope, overrides: LoopPolicyOverrides) => loopPolicies.setLayer(scope, overrides),
  };
  const stackPolicyIo = {
    policyView: (scope: PolicyScope) => stackPolicy.view(scope),
    policySet: (scope: PolicyScope, overrides: Record<string, unknown>): StackPolicySetResult => {
      try {
        stackPolicy.setLayer(scope, overrides);
        return { ok: true };
      } catch (e) {
        if (e instanceof StackPolicyError) return { ok: false, key: e.key, message: e.code };
        throw e;
      }
    },
  };
  const intakePolicyIo = {
    policyView: (scope: PolicyScope) => intakePolicies.view(scope),
    policySet: (scope: PolicyScope, overrides: Record<string, unknown>): IntakePolicySetResult => {
      try {
        intakePolicies.setLayer(scope, overrides);
        intakePollSoon();
        return { ok: true };
      } catch (e) {
        if (e instanceof IntakePolicyError) return { ok: false, key: e.key, message: e.code };
        throw e;
      }
    },
  };
  automationHooks.policy = featurePolicyLayers({ loop: loopPolicyIo, stacks: stackPolicyIo, intake: intakePolicyIo });
  const keepAwakeSwitch = keepAwake;
  // 「发送反馈」（BTL-254）：链接只开 github.com/yul761/shipherd；诊断脱敏后先给用户看，确认了再存进下载目录。
  const feedback = new FeedbackService({
    env: () => {
      let sys: string | null;
      try {
        sys = process.getSystemVersion();
      } catch {
        sys = null;
      }
      return { shipherd: app.getVersion(), os: osName(process.platform, sys), platform: process.platform, arch: process.arch, claude: health.claudeVersion() ?? "unknown" };
    },
    openExternal: (url) => shell.openExternal(url),
    copyText: (text) => clipboard.writeText(text),
    buildDiagnostics: async () => {
      if (!diag) throw new Error("diagnostics unavailable");
      return diag.build();
    },
    redactTerms: () => {
      const safe = <T,>(f: () => T, fallback: T): T => {
        try {
          return f();
        } catch {
          return fallback;
        }
      };
      return collectRedactTerms(db, {
        home: [homedir()],
        users: [safe(() => userInfo().username, "")],
        paths: [paths.home, paths.claudeConfigDir, tmpdir(), ...(["userData", "temp", "downloads", "documents", "desktop", "exe"] as const).map((n) => safe(() => app.getPath(n), ""))],
        slugs: safe(() => lessonsRepo.repos().map((r) => r.slug), [] as string[]),
      });
    },
    downloadsDir: () => app.getPath("downloads"),
    exists: (p) => existsSync(p),
    writeFile: (p, text) => writeFileAsync(p, text, "utf8"),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    now: Date.now,
    log: logger,
  });
  // 关 ticket（BTL-270）：界面（IPC）和两级总控（close_ticket 等）共用这一份依赖。
  const ticketCloseDeps: TicketCloseDeps = {
    tickets, followups,
    transaction: (fn) => withTransaction(db, fn),
    // 哪些开着的 PR 能关、怎么关、怎么结束 session：tickets/ticket-close-wiring.ts（单独测）。
    ...closeWiring({
      tickets, ticketPrs, branchOwners, ghDir: prGhDir, slugOf: (path) => repoIdentity.slugOfWarm(path), defaultBranch: (repo) => git.defaultBranch(repo), prHead, prClose, external: externalActions,
      sessions: {
        activityKind: (id) => activityMonitor.get(id)?.kind ?? null,
        waitingForInput: (id) => sessions.get(id)?.waitingForInput ?? false,
        screenNeedsUser: (termId) => pty.screenNeedsUser(termId),
        setUserEnded: (id, at) => sessions.setUserEnded(id, at),
        kill: (termId) => pty.kill(termId),
        forgetHibernated: (id) => {
          hibernator?.forget(id, "ended by ticket close");
          const h = sessions.get(id);
          if (h?.waitingForInput) sessions.setWaiting(id, false, h.lastActivityAt ?? 0);
        },
      },
      now: Date.now,
      log: logger,
    }),
    liveSessions: (key) =>
      sessions.listByTicket(key)
        .filter((s) => sessions.head(s.id)?.id === s.id)
        .map((s) => ({ id: s.id, termId: sessionService.termIdOf(s.id), hibernated: isHibernated(s.id) }))
        .filter((s) => s.termId !== null || s.hibernated),
    rederive: (key) => {
      rederiveTicketStatus({ tickets, handoffs, followups, now: Date.now, linkedOpen, givenUpPrs, shipherdClosedPrs, foreignPr }, key);
      void memory.syncTicket(key);
    },
    // 总控、路由发起的不强制读放弃了的、认定不存在的 PR（BTL-261），用户发起的才强制；等决定的 ticket 连关掉的也读一次。
    refreshPrs: (key, source) => soonTicketPrs(key, source),
    notify: () => {
      viewCache.invalidate();
      notify();
    },
    now: Date.now,
    log: logger,
  };
  const ticketClose = {
    close: (key: string, o: Parameters<typeof closeTicket>[2]) => closeTicket(ticketCloseDeps, key, o),
    reopen: (key: string, source: TicketCloseSource) => reopenTicket(ticketCloseDeps, key, source),
    retry: (key: string, o: Parameters<typeof retryClose>[2]) => retryClose(ticketCloseDeps, key, o),
    setStatus: (key: string, status: Parameters<typeof setTicketStatus>[2], source: TicketCloseSource) => setTicketStatus(ticketCloseDeps, key, status, source),
    preview: (key: string) => closePreview(ticketCloseDeps, key),
  };
  registerIpc({
    diag: diag ?? undefined,
    ticketClose,
    feedback,
    infoflow,
    userEnded: (termId) => {
      const h = sessions.head(termId);
      if (h) sessions.setUserEnded(h.id, Date.now());
    },
    onWrite: () => viewCache.invalidate(),
    ptySubs,
    ptyOutput,
    views,
    conv,
    fork: forkService,
    devSend: devSender,
    forkReady: () => healthReady,
    keepAwake: keepAwakeSwitch,
    update: {
      view: () => updateChecker.view(),
      checkNow: () => updateChecker.checkNow(),
      skip: (v) => updateChecker.skip(v),
      dismiss: (v) => updateChecker.dismiss(v),
      openRelease,
    },
    onArchived: (key) => {
      removeTicketMcpConfigs(paths.mcp, key);
      inboxService.dismissScope({ ticketKey: key });
    },
    // 快照里有给 agent 看的文字：换语言、改检查相关的设置都要重写。
    languageChanged: () => {
      applyLanguage();
      checkSnapshots.schedule();
    },
    settingChanged: onSettingChanged,
    // 共享 MCP（WS-M H）：打开就启动 hub（之后开的 session 用它）；关掉时接着它的 session 退完了再停。
    sharedMcpChanged: () => {
      if (sharedMcpOn(settings)) {
        if (existsSync(bundledHubPath())) mcpHub.start();
      } else mcpHub.stopWhenIdle();
    },
    onFeatureArchived: (id) => {
      removeFeatureMcpConfig(paths.mcp, id);
      inboxService.dismissScope({ featureId: id });
    },
    recheckCleanup: (key) => cleanupIfMerged(cleanupDeps, handoffs, key),
    autostart,
    tickets, ticketService, featureService, sessionService, activity: activityMonitor, pty, health, followups, handoffs, settings, runner, featureRunner, scheduler, jobs, gateRepo,
    memory,
    externalAudit,
    metrics: (days) => metricsView(days),
    messages: (scope) => mailbox.views(scope, sessions.listShipherd().map((x) => x.id)),
    deliverNow: (id) => mailbox.deliverNow(id),
    usage: usageRepo, sessions,
    refreshSession: (id) => {
      const refused = startRefresh(refresher, id, "manual", logger);
      return refused ? { ok: false, reason: refused } : { ok: true };
    },
    closeIdleSessions: (ids) => sessionCleanup.closeIdleNow(ids),
    deleteHiddenSessions: (ids) => sessionCleanup.deleteHidden(ids),
    pinSession: (id, on) => {
      const head = sessions.head(id);
      if (head) sessions.setPinned(head.id, on);
    },
    wakeSession: async (id) => (hibernator ? hibernator.wake(id, "user") : "not_hibernated"),
    inbox: inboxService,
    lessons: lessonsService,
    batches: batchRecorder,
    policies: admissionPolicies,
    admission: admissionFacade,
    interrupts: interruptsFacade,
    loop: {
      ...loopPolicyIo,
      comments: (key) => commentLoop.list(key),
      act: (a) => commentLoop.act(a),
      flaky: () => ciTriageRepo.flakyEntries(Date.now() - loopPolicies.forSlug(null)["ci.autoListDays"] * 86_400_000),
      flakyAct: (a) => (a.op === "add" ? ciTriageRepo.list(a.repoSlug, a.kind, a.name, "manual", Date.now()) : ciTriageRepo.unlist(a.repoSlug, a.kind, a.name)),
      effect: (days) => {
        const until = Date.now();
        return loopStats.summary({ since: until - effectDays(days) * 86_400_000, until });
      },
    },
    stacks: {
      view: (filter) => stackService.view(filter),
      rebaseNow: (id) => stackService.rebaseNow(id),
      setLayerMode: (id, mode) => stackService.setLayerMode(id, mode),
      restore: (id) => stackService.restore(id),
      remove: (id) => stackService.remove(id),
      ...stackPolicyIo,
      policyLayers: () => stackPolicy.layers(),
    },
    review: {
      ticket: (key) => assessment.ticketView(key),
      run: (prId) => {
        const pr = ticketPrs.get(prId);
        if (!pr) return { ok: false, reason: "no_pr" };
        return preReview.manual(pr) === null ? { ok: false, reason: "no_head" } : { ok: true };
      },
      regenerate: async (prId) => {
        const pr = ticketPrs.get(prId);
        if (!pr) return { ok: false, reason: "no_pr" };
        const row = assessment.latestPreReview(pr);
        if (!row) return { ok: false, reason: "no_pre_review" };
        return (await briefs.generate(row)) ? { ok: true } : { ok: false, reason: "failed" };
      },
      post: async (prId) => {
        const r = await briefs.post(prId, true);
        return r.ok ? { ok: true, url: r.url } : r;
      },
      policyView: (scope) => prPolicies.view(scope),
      policySet: (scope, overrides) => prPolicies.setLayer(scope, overrides),
      effect: (days) => reviewEffect(db, effectDays(days), Date.now()),
      queue: () => assessment.queue(),
      preReviewStatus: (req) => ({
        tickets: Object.fromEntries(preReviewStatus.forTickets(req.tickets ?? [])),
        sessions: Object.fromEntries(preReviewStatus.forSessions(req.sessions ?? [])),
        prs: Object.fromEntries(preReviewStatus.forPrs(req.prs ?? [])),
      }),
      preReviewQueue: () => preReviewStatus.queue(),
      // 和总控的 pre_review_queue 同一个入口（PreReviewService.cancel / moveToFront）。
      preReviewQueueAct: (a) => (a.op === "cancel" ? preReview.cancel(a.id) : preReview.moveToFront(a.id)),
    },
    checks: {
      act: (a) => checksService.act(a),
      view: (scope) => checksService.view(scope),
      hits: (key) => checksService.hits(key),
      draft: (lessonId) => checkDrafter.draft(lessonId),
    },
    baselines: {
      view: () => baselineService.view(), act: (a) => baselineService.act(a), rulesView: (scope) => baselineService.rulesView(scope), summary: (scope) => baselineService.summary(scope),
    },
    legacy: {
      views: () => legacyScans.views(), start: (checkId, slug) => legacyScans.start(checkId, slug), cancel: (id) => legacyScans.cancel(id),
      violations: (id, offset, limit) => legacyScans.violations(id, offset, limit),
    },
    checkExports: { list: () => checkExporter.list(), act: (a) => checkExporter.act(a) },
    backtest: { view: () => backtest.view(), act: (a) => backtest.act(a) },
    intake: {
      view: () => intake.view(),
      effect: (days) => intake.effect(days),
      ...intakePolicyIo,
      classify: (e) => intake.editClassification(e),
      poll: async () => {
        const r = await intake.poll({ manual: true });
        return r.ok ? { ok: true } : r;
      },
      act: (a) => intake.act(a),
    },
    configIo: configIoFacade({
      io: configIo, backups: configBackups, backupDir: configBackupDir, now: Date.now, notify, log: logger,
      openPath: (dir) => shell.openPath(dir),
      dialogs: {
        save: async (defaultName) => {
          const w = win;
          const opts = { defaultPath: defaultSavePath((n) => app.getPath(n), defaultName), filters: [{ name: "JSON", extensions: ["json"] }] };
          const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
          return r.canceled || !r.filePath ? null : r.filePath;
        },
        open: async () => {
          const w = win;
          const opts = { properties: ["openFile" as const], filters: [{ name: "JSON", extensions: ["json"] }] };
          const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
          return r.canceled ? null : (r.filePaths[0] ?? null);
        },
      },
    }),
    availability,
    routing, switcher,
    cost: {
      breakers: () => costBreakerInst.views(),
      view: (scope) => ({ policy: costPolicy.view(scope), layers: costPolicy.layers(), breakers: costBreakerInst.views(), events: costRepoInst.events({ limit: 50 }) }),
      set: (scope, overrides) => {
        try {
          costPolicy.setLayer(scope, overrides);
          return { ok: true };
        } catch (e) {
          if (e instanceof CostPolicyError) return { ok: false, key: e.key, message: M().cost.error[e.code](e.key) };
          throw e;
        }
      },
      resume: (kind, id) => costBreakerInst.resume(kind, id),
    },
    background: {
      status: () => bgScheduler.status(),
      act: (a) => bgScheduler.setKindPaused(a.kind, a.op === "pauseKind"),
    },
    ciResend: async (item) => {
      const r = await ciDelivery.resend(item);
      ciStuckChanged();
      return r;
    },
    prStages: new PrStagesService({
      tickets: { get: (key) => tickets.get(key), byFeature: (id) => tickets.listByFeature(id, { includeArchived: true }) },
      stages: prStages,
      prs: ticketPrs,
      reports: (key) => inboxRepo.reportsForTicket(key),
      skillTrackingSince: () => skillTrackingSince(settings),
    }),
    // 允许的主机和 lessons 的 openSource 一样，只认 git remote 认出来的仓库（lessons_repos），不认 ticket_prs 自己的 slug。
    prOpen: (url) => openKnownPr(url, { prs: knownPrLookup(ticketPrs, () => reviewRequests.list()), trustedSlugs: () => lessonsRepo.repos().map((r) => r.slug), openExternal: (u) => shell.openExternal(u), log: logger }),
    linkOpen: (url) => openExternalLink(url, { openExternal: (u) => shell.openExternal(u), log: logger }),
    prWatchList: prWatchListHandler({ watcher: prWatcher, ticketKeys: () => tickets.list().map((t) => t.key) }),
    terminalVisible: (id, v) => procServices.terminalVisible(id, v),
    terminalInput: (id) => procServices.terminalActive(id),
    terminalKeys: meterTerminalKeys,
    onInvoked: (channel, args, result) => void recordInvoke(recordEvent, channel, args, result),
    memoryHistory: (since) => procServices.monitor.history(since),
    turnBoard: (filter) => turnService.board(filter),
    ticketGlance: (key) => ticketGlance(key, {
      headsOf: (k) => sessionService.ticketHeads(k),
      rootOf: (id) => sessions.rootOf(id),
      lastReplyOf: (id) => activityMonitor.lastReplyOf(id),
      contextOf,
      threshold: () => refreshThreshold(settings),
    }),
    turnSendToAgent: (item) => turnService.sendToAgent(item),
    turnHomeOpened: () => turnService.homeOpened(),
    // 进视图缓存（BTL-275）：每种 notify 都作废它（view-scopes.ts），只省掉同一批变化之间重复的 now:view。
    nowView: (merges) => viewCache.getFor(VIEW_KEYS.now, JSON.stringify(merges), () => {
      // 分段计时（BTL-265）：导出诊断的 ops 里 now.* 是这一次 now:view 的各部分。
      const p = perfParts("now");
      try {
        // 合并排队的等待者记的是 SHIPHERD_SESSION：换成 head 再对；「需要你」的理由一次取齐。
        const queued = p.run("queued", () => new Set([...gateRepo.waitingSessionIds()].map((id) => sessions.head(id)?.id ?? id)));
        const reasons = p.run("needsYou", () => needsYou.reasons());
        const tickets = p.run("views", () => views.tickets());
        const features = p.run("views", () => views.features());
        const decisions = p.run("decisions", () => inboxService.pendingDecisionViews());
        const notices = p.run("notices", () => currentNotices());
        // 所有 ticket 的 PR 状态一次读（BTL-275：原来每个 ticket 各查 PR 和分支）。
        const prs = p.run("prs", () => prWatcher.statusOfMany([...tickets, ...features.flatMap((f) => f.tickets)].map((t) => t.key)));
        const view = p.run("build", () => buildNowView({
          tickets,
          features,
          // 休眠着的 Shipherd 总控照样算（WS-M B）。
          shipherd: ((b) => (b ? { ...b, termId: sessionService.termIdOf(b.id), rootId: sessions.rootOf(b.id) ?? b.id } : null))(
            sessionService.runningShipherd() ?? hibernatedHeads().find((h) => h.shipherd && h.ticketKey === null) ?? null,
          ),
          activity: (id) => activityMonitor.get(id),
          needsYouReason: (id) => reasons.get(id) ?? null,
          prs: (key) => prs.get(key) ?? [],
          mergeQueued: (id) => queued.has(id),
          refreshing: (id) => refresher.stepOf(id),
          merges,
          approvalText: M().nowApproval,
          decisions,
          recent: (id) => activityMonitor.recent(id),
          memory: activityMonitor.memoryLog(),
          notices,
          sessionMemory: (id) => procServices.monitor.memoryOf(id),
          memorySnapshot: procServices.monitor.snapshot(),
          sharedMcp: sharedMcpOn(settings),
        }));
        const out = p.run("intake", () => (intake.active() ? { ...view, intake: intake.recent() } : view));
        return out;
      } finally {
        p.done();
      }
    }),
    rederive: (key) => {
      rederiveTicketStatus({ tickets, handoffs, followups, now: Date.now, linkedOpen, givenUpPrs, shipherdClosedPrs, foreignPr }, key);
      // followup 完成 / 忽略 / 恢复：StateCore 里对应的条目跟着 forget / 重写。
      void memory.syncTicket(key);
    },
    detectTrackerTools,
    featurePolicy: () => readFeaturePolicy(db, (id) => lessonsRepo.product(id)?.name ?? null),
    automation: {
      state: () => automation.state(),
      apply: (level) => automation.apply(level),
      // epic 档位改了：它的 PR 的预审、就绪要按新档位重算，搁着的接活项按新档位重新决定（在跑的 session 的说明要下次打开才换）。
      setFeatureLevel: (id, level) => {
        features.setAutomationLevel(id, level);
        reassessAll();
        intakePollSoon();
      },
    },
    window: () => win,
    now: Date.now,
    notify,
    memoryToggled: (on) => {
      safeSend(IPC.memoryChanged, null);
      // 记忆从关变成开：关着的时候没写进去的补同步一次（最终审查 6）。永不 reject。
      if (on) memory.syncAll().catch((e: unknown) => logger("memory catch-up sync failed", e));
    },
    aborted: () => headlessAbort.signal.aborted,
  });

  /**
   * 汇总过时没有（ws-b）：hasNewActivity 要同步扫 transcript 目录，总控的 progress_overview 和 list_features 每次都给每个 feature 算一遍，所以按 feature 缓存一会儿。
   * 新写了一份汇总（latest 的 id 变了）马上重算。
   */
  const STALE_TTL_MS = 20_000;
  const staleCache = new Map<number, { summaryId: number | null; at: number; stale: boolean }>();
  const summaryStale = (id: number): boolean => {
    const summaryId = featureHandoffs.latest(id)?.id ?? null;
    const now = Date.now();
    const hit = staleCache.get(id);
    if (hit && hit.summaryId === summaryId && now - hit.at < STALE_TTL_MS) return hit.stale;
    const stale = featureRunner.hasNewActivity(id);
    staleCache.set(id, { summaryId, at: now, stale });
    return stale;
  };
  /** 总控 progress_overview 的聚合（ws-b）。 */
  const progressView = (filter: ProgressFilter): ProgressView => {
    const firstCommits = prStages.ticketsWith("first_commit");
    const live = tickets.list();
    return buildProgress({
      now: Date.now(),
      tickets: live,
      features: features.list().map((f) => ({ id: f.id, name: f.name })),
      prs: live.flatMap((t) => prWatcher.statusOf(t.key)),
      summary: (id) => {
        const rec = featureHandoffs.latestValid(id);
        return { summary: rec?.payload?.summary ?? null, at: rec?.createdAt ?? null, prStatusAt: rec?.prStatusAt ?? null, stale: summaryStale(id) };
      },
      started: (key) => firstCommits.has(key) || sessions.listByTicket(key).length > 0,
      turnOf: turnService.prTurns(),
    }, filter);
  };


  // 总控 session 开子 session 的请求（设计文档 2026-10-23 第二步）。
  /** ticket_prs 的 id 或 PR 链接 → PR（同一个链接可能挂在几个 ticket 上）。 */
  const prsByRef = (ref: string): TicketPr[] => {
    const r = ref.trim();
    if (/^\d+$/.test(r)) {
      const pr = ticketPrs.get(Number(r));
      return pr ? [pr] : [];
    }
    return ticketPrs.byUrl(r);
  };
  const controlInbox = new ControlInbox({
    requestsDir: paths.controlRequests,
    resultsDir: paths.controlResults,
    handle: controlHandler({
      tickets, sessions, features, blocks, ticketService, sessionService, notify,
      activity: (id) => activityMonitor.get(id),
      activityOutput: (id) => activityMonitor.output(id),
      refresher,
      lastReply: (id) => activityMonitor.lastReply(id),
      awaitingUser: (id) => awaitingUserOf(sessions.head(id)?.id ?? id),
      inbox: inboxService,
      mailbox,
      // Shipherd 总控（BTL-190 第 5 点）的只读数据。
      shipherd: {
        shipherdSessions: () => sessions.listShipherd().map((x) => x.id),
        patrolling: (id) => patrolTurns.active(id),
        featureRows: () => sessionService.featureRowsAll(),
        prs: () => tickets.list().flatMap((t) => prWatcher.statusOf(t.key)),
        prTurns: () => turnService.prTurns(),
        openHeads: openShipherdHeads,
        needsYou: (id) => needsYou.reasons().get(id) ?? null,
        inbox: inboxService,
        progress: progressView,
        metrics: (days) => metricsView(days),
        summaries: {
          running: (id) => featureRunner.isRunning(id),
          stale: (id) => summaryStale(id),
          prStatusAt: (id) => featureHandoffs.latestValid(id)?.prStatusAt ?? null,
          // 和 feature 页的"立即更新"一样：后台跑，完成后刷新界面。
          refresh: (id) => void featureRunner.runManual(id).then(notify, (e: unknown) => logger(`control: refreshing the summary of feature ${id} failed`, e)),
        },
        assessment: {
          summaries: (ids) => assessRepo.summaries(ids),
          // epic 总控（keep）只认自己 epic 的 PR：同一个链接挂在几个 ticket 上时挑它自己的那个（BTL-271）。
          view: (ref, keep) => {
            const pr = prsByRef(ref).find((p) => !keep || keep(p.ticketKey)) ?? null;
            return pr ? assessment.view(pr) : null;
          },
        },
      },
      preReview: {
        submit: (id, raw) => preReview.submitEvidence(id, raw),
        latest: (id) => preReview.latestForSession(id),
      },
      // lessons 工具（BTL-274）：这个 ticket 的仓库的规矩全文；路径按 worktree 和主仓库目录对到仓库（同名分支也分得开）。
      lessons: (t, q) => lookupLessons(
        lessonsRepo, repoIdentity, t.repos.map((r) => r.repoPath),
        dripRoots(repoIdentity, t.repos.flatMap((r) => [ticketService.workDir(r), r.repoPath])), q, guideLessonOptions(),
      ),
      // BTL-271：两级总控的 pre_review_status / pre_review_run / pre_review_queue 和列表里的 preReview。
      preReviewOps: {
        status: preReviewStatus,
        view: (id) => {
          const row = preReviewRepo.get(id);
          return row ? preReview.view(row) : null;
        },
        findPrs: prsByRef,
        prsOf: (key) => ticketPrs.byTicket(key),
        // 和 ticket 页的「重新预审」（IPC review:run）同一个入口：排队、通知都在 manual 和队列里。
        manual: (pr) => preReview.manual(pr),
        rerun: (id) => preReview.rerun(id),
        cancel: (id) => preReview.cancel(id),
        moveToFront: (id, within) => preReview.moveToFront(id, within),
        ticketOf: (id) => {
          const row = preReviewRepo.get(id);
          return row ? row.ticketKey : undefined;
        },
      },
      // 和界面上点 × 一样（IPC pty:kill）：只关终端，session 留在列表里。不记成用户结束（BTL-256）。
      kill: (termId) => pty.kill(termId),
      // 后台恢复（BTL-256）：信箱已经调过同一个请求，这里拿到同一个结果；熔断压着的不恢复。
      resume: async (id) => (costBreaker?.sessionPaused(id) ? null : isHibernated(id) ? { state: "hibernated" } : (resumer?.request(id, "mail") ?? null)),
      // 答的是「调用的这个总控现在发一条会怎样」（BTL-279）：和送信时同一个判断（mailboxControls）。epic 下列出的别的协调者、
      // 调用方不是它的总控时照常算（用户点 × 关的就是 ended_by_user）（BTL-279 second review）。
      // 调用方在做巡检那一轮：它发的不拉起用户关掉的（BTL-279 复核建议 3），答「用户结束了」。
      wakeState: (id, caller) => {
        const r = resumer;
        return wakeStateFor(id, caller, {
          hibernated: isHibernated,
          controls: mailboxControls,
          patrolling: (c) => patrolTurns.active(sessions.head(c)?.id ?? c),
          status: r ? (x, o) => r.status(x, o) : null,
        });
      },
      endHibernated: (id) => {
        const h = sessions.get(id);
        hibernator?.forget(id, "ended by end_session");
        if (h?.waitingForInput) sessions.setWaiting(id, false, h.lastActivityAt ?? 0);
        notify();
      },
      screenNeedsUser: (termId) => pty.screenNeedsUser(termId),
      submit: submitTask,
      memoryEnabled: () => memoryOn(settings),
      ticketPattern: () => settings.get("ticketPattern"),
      sessionModel: (m) => routing.sessionModel(m),
      admission,
      stacks: new StackControl({ service: stackService, tickets: () => tickets.list(), features }),
      ticketOps: new TicketControl({ tickets, followups, ...ticketClose, rederive: ticketCloseDeps.rederive, notify: ticketCloseDeps.notify, now: Date.now, log: logger }),
      log: logger,
    }),
    log: logger,
  });

  win = createWindow();
  windowReopenable = true;
  tray = createTray();
  inbox.start();
  controlInbox.start();
  gateInbox.start();
  // hook 看到 alive.json（并且 pid 还活着）才来问；写不了就当 Shipherd 没开着，hook 一律放行。
  try {
    writeFileSync(paths.gateAlive, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  } catch (e) {
    logger("merge gate: could not write alive.json; merges are not checked", e);
  }
  holdWatcher.start(Number(process.env.SHIPHERD_GATE_CHECK_MS) || HOLD_CHECK_MS);
  // 等 git 和 gh 的路径按登录 shell 的 PATH 解析好再查：第一轮就可能看到合并、触发 worktree 清理。已经开始退出就不再启动。
  // 更新检查（BTL-253）等 gh 按登录 shell 的 PATH 探测完再开始。
  void healthReady.then(() => ghProbed).then(() => {
    if (!headlessAbort.signal.aborted) updateChecker.start();
  });
  void healthReady.then(() => {
    if (headlessAbort.signal.aborted) return;
    prWatcher.start();
    reviewPoller.start();
    // 窗口切到前台：请你 review 的离上次超过 1 分钟就补查（R9）。
    unbindReviewFocus = bindFocusCatchUp(app, reviewPoller);
    // 一次性补链接所有 ticket（含归档）的 PR；后台跑，失败下次启动重试。
    void runPrBackfill({
      tickets: () => tickets.list({ includeArchived: true }),
      linker: prLinker,
      prs: ticketPrs,
      handoffPrs: (key) => handoffs.allPrs(key),
      holds: () => gateRepo.prHolds(),
      sessionTicket: (s) => sessions.get(s)?.ticketKey ?? null,
      prsForBranch,
      ghWorkDir: (r) => ticketService.ghWorkDir(r),
      home: homedir(),
      // 目录不在时 slugOf 给不出：用这个仓库已经链接过的 PR 的 slug。
      slugOf: (r) => repoIdentity.slugOf(r.repoPath) ?? ticketPrs.byTicket(r.ticketKey).find((p) => p.repoId === r.id)?.slug ?? null,
      jobs,
      now: Date.now,
      log: logger,
      soon: (repoId) => prWatcher.soon(repoId),
    }).catch((e: unknown) => logger("pr backfill failed", e));
  });
  void healthReady
    .then(() => {
      if (headlessAbort.signal.aborted) return;
      lessonRunner.start();
      lessonWizard.resume();
    })
    .catch((e: unknown) => logger("lessons: starting the runner failed", e));
  activityMonitor.start();
  convIngester.start();
  infoflow.start(Number(process.env.SHIPHERD_FLOW_TICK_MS) || undefined);
  procServices.start();
  usageScanner.start(usageScanMs(process.env));
  bgScheduler.start();
  const stopBacktestReview = backtest.keepReviewing();
  bgQueue.start();
  // 预审（工作流 G）：上次没跑完、任务已经不在了的收尾；review 效果补上漏掉的已合并 PR。
  preReview.sweep((jobId) => {
    const j = bgRepo.get(jobId);
    return j !== null && (j.state === "queued" || j.state === "running") ? j.state : null;
  });
  void preReview.flush().catch((e: unknown) => logger("pre-review: flush failed", e));
  void reviewCollector.backfill().catch((e: unknown) => logger("review effect: backfill failed", e));
  // 启动时看一遍：上次退出前暂停着的接着暂停，托盘和「现在」页马上显示。
  void costBreakerInst.check().then(() => costBreakerInst.views().length > 0 && costChanged()).catch((e: unknown) => logger("cost: the first check failed", e));
  void runDiscovery();
  // 启动时补齐记忆：老数据、上次退出时没写完的。
  void memory.syncAll();
  // 信箱上次退出时留下的投影（hook 已经写出去的 .done、认领到一半的）：按库重建。送达回调都注册好了才做。
  mailbox.rebuild();
  const discoveryTimer = setInterval(() => void runDiscovery(), DISCOVERY_INTERVAL_MS);
  const intakeTimer = setInterval(() => intakeTick(), 60_000);
  void healthReady.then(() => intakeTick(true));
  // 自动换新也按活动的节奏再看一遍：活动没变时 activityMonitor 不 notify，而停着的 session 要等「需要你」判断完、
  // 用户 30 秒没打字之后才能换新，那时活动往往已经不变了。
  // 闲置关闭和删除过期的隐藏 session 也跟着这个节奏（BTL-190 第 8 点）。
  const refreshTimer = setInterval(() => {
    if (headlessAbort.signal.aborted) return;
    refresher.autoCheck();
    sessionCleanup.tick();
    hibernator?.tick();
    // 等着送的回答和汇报：Stop 那一刻没送成（用户在打字、有草稿）的，按这个节奏再试。
    void inboxService.flush();
    // 信箱：清扫投影、停着的再试直接输入、清理旧消息（永不 reject）。
    void mailbox.tick();
  }, activityIntervals(process.env).tickMs);

  // 调度：启动（health 探测完成后）、唤醒、解锁时检查到期任务；每分钟 tick，覆盖 16:00 和整晚没锁屏的情况。
  // 上次没收拾掉的栈临时 worktree（崩溃、强退）启动时清掉。
  try {
    stackService.cleanupWork();
  } catch (e) {
    logger("stacks: cleaning up work dirs failed", e);
  }
  void healthReady.then(() => checkSchedule("startup"));
  powerMonitor.on("resume", () => {
    // 睡着的时间不算闲置（BTL-190 第 8 点）：不然一开盖子所有 session 一起被关。
    sessionCleanup.resumed();
    // 「凭屏幕证据当它停着」也一样（BTL-269 B）：不然醒来第一次检查就把睡着的时间当成安静，马上往里送。
    idleEvidence.resumed();
    void checkSchedule("resume");
  });
  powerMonitor.on("unlock-screen", () => void checkSchedule("unlock"));
  // macOS / Linux 关机：和 Windows 的 session-end 一样，不再拦着关窗口。
  powerMonitor.on("shutdown", () => quitState.requestQuit());
  // 合上盖子（进入睡眠）时关掉防休眠，醒来后保持关闭，要用再手动打开。
  powerMonitor.on("suspend", () => {
    keepAwakeSwitch.set(false);
    // 睡着的时间不算等待（ws-h）：开着的等待段现在关掉，醒来以后下一次 sync 重新开。
    waitTracker.closeAll();
  });
  // 共享 MCP 开着就现在启动 hub，免得第一批 session 还在等它起来、先用了 stdio（WS-M H）。
  if (sharedMcpOn(settings) && existsSync(bundledHubPath())) mcpHub.start();
  // 原来栈 tick 每分钟无条件发一次 data notify，顺带盖住了好几样（BTL-275 去掉了它）：每分钟看一次，
  // 「现在」页只按时间出现的提醒（comment loop 超过 30 分钟没送到等）变了、本地日期变了（看板的「今天合并」过午夜翻篇）就发；
  // 另外 10 分钟兜底发一次，盖住漏发 notify 的写入。基线现在就记（启动时的状态）。窗口藏着时 notify 照旧攒着。
  const refreshTick = minuteRefresh({ notices: currentNotices, day: () => localDate(Date.now()), now: Date.now, notify: () => notify() });
  const scheduleTimer = setInterval(() => {
    void checkSchedule("tick");
    refreshTick();
  }, TICK_MS);
  // e2e 用：栈的 tick 另外按 SHIPHERD_STACKS_TICK_MS 跑（不用等整分钟的 schedule；没设时不跑）。
  const stacksTickMs = Number(process.env.SHIPHERD_STACKS_TICK_MS) || 0;
  const stacksTimer = stacksTickMs > 0 ? setInterval(() => void stackService.tick().catch((e: unknown) => logger("stacks: tick failed", e)), stacksTickMs) : null;
  // 度量汇总（ws-h）：启动一分钟后一次，之后每小时一次；整窗重算，幂等。
  const metricsRollup = new MetricsRollup({
    db, repo: metricsRepo, holds: gateRepo, registry: () => routing.config().registry, record: recordEvent,
    since: () => metricsSince(settings) ?? Date.now(), now: Date.now, log: logger,
  });
  const rollupFirst = setTimeout(() => metricsRollup.run(), 60_000);
  // 改名改写了按仓库分的汇总（并进新名字时是相加的）：马上整窗重算一遍。
  afterRename = () => {
    try {
      metricsRollup.run();
    } catch (e) {
      logger("metrics: re-rolling up after a repo rename failed", e);
    }
  };
  if (rerollPending) afterRename();
  const renameScan = setTimeout(() => void repoRenames.scan(), 30_000);
  const renameVerify = setInterval(() => void repoRenames.verifyRecorded(), RENAME_RETRY_MS);
  const rollupTimer = setInterval(() => metricsRollup.run(), 60 * 60_000);
  const METRICS_VIEW_STALE_MS = 10 * 60_000;
  const metricsCutoff = () => baselineCutoffOf(settings, () => sessions.firstShipherdCreatedAt(), metricsSince(settings) ?? Date.now());
  /** 「效果」页和总控 metrics_overview 的数据：上次汇总超过 10 分钟就先汇总一次。 */
  const metricsView = (days: number | undefined): MetricsOverview => {
    metricsRollup.runIfStale(METRICS_VIEW_STALE_MS);
    const now = Date.now();
    const d = clampDays(days ?? METRICS_DAYS_DEFAULT);
    // 打断减少（ws-j）：生效前后各最多 30 天的对比，要读到生效前 30 天。
    const since = Number(settings.get("interruptReductionSince")) || null;
    const fromDay = [overviewFromDay(now, d), ...(since ? [compareFromDay(since)] : [])].sort()[0]!;
    return buildOverview({
      daily: metricsRepo.daily(fromDay), baseline: metricsRepo.baselinePrs(), cutoff: metricsCutoff(), now, days: d,
      rolledUpAt: metricsRollup.lastRun > 0 ? metricsRollup.lastRun : null, compareSince: since,
    });
  };
  // 每天一次读 gh（ws-h）：revert、重开、基线回填；只读，和别的调度任务一样在 checkSchedule 里触发。
  metricsGhJob = new MetricsGhJob({
    gh: { available: ghAvailable, searchMergedPrs, prStatus, reviewComments, reviewAuthors, issueEvents },
    home: homedir(),
    slugs: () => [...ticketPrs.slugs(), ...lessonsRepo.repos().map((r) => r.slug)],
    prs: () => ticketPrs.all(),
    baseline: metricsRepo,
    cutoff: metricsCutoff,
    record: recordEvent,
    jobs,
    now: Date.now,
    log: logger,
  });

  app.on("will-quit", () => {
    // 正常情况下 before-quit 已经停过；没经过 before-quit 的退出也要在关数据库之前停下。
    refresher.stop();
    updateChecker.stop();
    hibernator?.stop();
    mcpHub.stop();
    clearInterval(discoveryTimer);
    clearInterval(refreshTimer);
    clearInterval(intakeTimer);
    stopBacktestReview();
    clearInterval(scheduleTimer);
    if (stacksTimer) clearInterval(stacksTimer);
    availability.dispose();
    notifier?.dispose();
    lessonsGate.dispose();
    routing.dispose();
    clearInterval(upgradeTimer);
    clearInterval(waitTimer);
    clearTimeout(rollupFirst);
    clearTimeout(renameScan);
    clearInterval(renameVerify);
    clearInterval(rollupTimer);
    lessonAdmission.stop();
    lessonWizard.stop();
    if (hookDiscoveryTimer) clearTimeout(hookDiscoveryTimer);
    activityMonitor.stop();
    convIngester.stop();
    infoflow.stop();
    void procServices.stop();
    usageScanner.stop();
    if (costCheckTimer) clearTimeout(costCheckTimer);
    bgQueue.dispose();
    bgScheduler.dispose();
    memory.stop();
    inbox.stop();
    controlInbox.stop();
    // 先删 alive.json：之后的 hook 不再等一个要退出的 Shipherd。
    try {
      rmSync(paths.gateAlive, { force: true });
    } catch (e) {
      logger("merge gate: could not remove alive.json", e);
    }
    gateInbox.stop();
    checkHits.stop();
    checkSnapshots.stop();
    holdWatcher.stop();
    prWatcher.stop();
    unbindReviewFocus?.();
    reviewPoller.stop();
    turnChanged = null;
    invalidator.dispose();
    turnService.dispose();
    diag?.stop();
    pty.killAll();
    keepAwakeSwitch.set(false);
    tray?.destroy();
    // 开着的等待段在关数据库之前关掉（突然退出的下次启动按最后看到的时间补关）。
    waitTracker.closeAll();
    closing = true;
    db.close();
    flushLogSync();
  });
}

process.on("uncaughtException", (e) => {
  logger("uncaughtException", e);
  flushLogSync();
});
// 退出前把还攒着的日志写完（app.exit、正常退出都会到这里）。
process.on("exit", () => flushLogSync());
process.on("unhandledRejection", (e) => logger("unhandledRejection", e));

if (process.argv.includes("--smoke")) {
  void runSmoke()
    .then((code) => app.exit(code))
    .catch(() => app.exit(1));
} else if (!app.requestSingleInstanceLock()) {
  // 平常是第二次打开 Shipherd：已经开着的那个会把窗口拿到前面，这里悄悄退出。
  // BTL-260：老用户的锁和旧版 Butler 共用，Butler 开着时这里也会退出，看上去像「打不开」：先说一声再退出。
  if (!usingLegacyUserData) app.quit();
  else
    void readProcTable(process.platform)
      .then((t) => legacyButlerHolder(t))
      .catch(() => "unknown" as const)
      .then(async (holder) => {
        if (holder === "none") return;
        await app.whenReady();
        const m = holder === "butler" ? M().legacyButlerRunning : M().lockHeldUnknown;
        dialog.showMessageBoxSync({ type: "info", message: m.title, detail: m.detail, buttons: ["OK"] });
      })
      .finally(() => app.quit());
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitState.markQuitting();
    headlessAbort.abort();
    shutdownSessions();
  });
  // 常驻托盘：窗口全部关闭也不退出。
  app.on("window-all-closed", () => undefined);
  void app
    .whenReady()
    .then(() => {
      if (BACKGROUND_WINDOWS && process.platform === "darwin") app.setActivationPolicy("accessory");
    })
    .then(bootstrap)
    .catch((e: unknown) => {
      // 迁移前的备份失败、用户在对话框里选了退出（BTL-262）：已经告诉过原因了，不再弹第二个。
      if (e instanceof DatabaseBackupError && e.declined) {
        logger(`startup: quit after the database backup failed (${e.failure.reason})`);
        flushLogSync();
        app.exit(1);
        return;
      }
      // 数据比程序新、迁移顺序对不上、备份失败：给一句能看懂的话，不贴调用栈。
      dialog.showErrorBox(M().startupFailed, startupErrorText(e));
      app.exit(1);
    });
}
