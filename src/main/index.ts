import { execFile } from "node:child_process";
import { app, BrowserWindow, dialog, Menu, nativeImage, powerMonitor, powerSaveBlocker, shell, Tray } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeTask } from "../shared/control";
import { parseGateRequest, type GateRequest, type GateResult } from "../shared/gate";
import { IPC } from "../shared/ipc";
import type { LimitHit } from "../shared/availability";
import { ClaudeAvailability } from "./claude/availability";
import { buildNotices, ciNotices } from "./now/notices";
import { AvailabilityRepo } from "./db/availability-repo";
import type { Session, WatchedPr } from "../shared/types";
import { APP_ID, shouldSetAppId } from "./app-id";
import { runHeadless } from "./claude/headless";
import { probeMcpTools } from "./claude/mcp-probe";
import { projectMcpApprovalSettings, projectMcpConfigs } from "./claude/project-mcp";
import { headlessEnv } from "./claude/spawn";
import { AuditRepo } from "./db/audit-repo";
import { NewerDatabaseError, openDatabase } from "./db/database";
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
import { TermsRepo } from "./db/terms-repo";
import { TicketsRepo } from "./db/tickets-repo";
import { UsageRepo } from "./db/usage-repo";
import { execHeadlessJson, jobOf } from "./handoff/headless-exec";
import { UsageScanner, usageScanMs } from "./usage/usage-scanner";
import { HoldWatcher } from "./gate/hold-watcher";
import { HOLD_CHECK_MS, MergeGate } from "./gate/merge-gate";
import { BranchOwnership } from "./prwatch/branch-owners";
import { CiDelivery, ciRecipient } from "./prwatch/ci-delivery";
import { prHandoff } from "./prwatch/pr-handoff";
import { runPrBackfill } from "./prwatch/pr-backfill";
import { ensureSkillTrackingSince, skillTrackingSince } from "./prwatch/skill-tracking";
import { PrLinker } from "./prwatch/pr-links";
import { PrWatcher } from "./prwatch/pr-watcher";
import { makeWhoOf } from "./gate/who";
import { auditCutoff, stalePendingCost } from "./gateway/budget";
import { PrivacyGateway } from "./gateway/gateway";
import { KeyStore } from "./gateway/key-store";
import { autostartState } from "./autostart";
import { electronSecretBox } from "./gateway/safe-storage";
import { llmStatus } from "./gateway/status";
import { captureCommandHandoff, stopFromEnvelope } from "./handoff/capture";
import { handoffCommandPath, handoffCommandUsable } from "./handoff/command";
import { ingestFeatureHandoff, type FeatureIngestInput } from "./handoff/feature-ingest";
import { featureCommandFollowup, FeatureSummaryRunner } from "./handoff/feature-runner";
import { ingestHandoff, rederiveTicketStatus, type IngestInput } from "./handoff/ingest";
import { cleanupIfMerged } from "./tickets/worktree-cleanup";
import { FeatureHandoffsRepo } from "./db/feature-handoffs-repo";
import { ButlerMessagesRepo } from "./db/butler-messages-repo";
import { ButlerMessages } from "./control/butler-messages";
import { buildProgress } from "./progress/progress-view";
import type { ProgressFilter, ProgressView } from "../shared/progress";
import { EpicHistoryRepo } from "./db/epic-history-repo";
import { EpicsRepo } from "./db/epics-repo";
import { EpicDigestRunner } from "./epics/epic-digest";
import { EPIC_HISTORY_READ_ENTRIES } from "./epics/epic-history-view";
import { EpicService } from "./epics/epic-service";
import { FeaturesRepo } from "./db/features-repo";
import { currentLang, onLangChange, setLang } from "./i18n";
import { pruneSessionGuides, writeSessionGuide } from "./claude/session-guide";
import { safeSessionLessons } from "./lessons/select";
import { resolveLang } from "../shared/i18n";
import { FeatureService } from "./tickets/feature-service";
import { HandoffRunner } from "./handoff/runner";
import { hookCommand } from "./hooks/installer";
import { HealthService } from "./hooks/health";
import { applyHookEnvelope } from "./hooks/hook-events";
import { createFileLogger, type Logger } from "./logger";
import { hubRoutes, memoryServers, pruneTerminalMcpConfigs, removeEpicMcpConfig, removeFeatureMcpConfig, removeTerminalMcpConfig, removeTicketMcpConfigs, SESSIONS_AUTO_ALLOW, sessionsServer, type StdioServerSpec, writeButlerMcpConfig, writeEpicMcpConfig, writeFeatureMcpConfig, writeTerminalMcpConfig, writeTicketMcpConfig } from "./memory/mcp-config";
import { McpHub, spawnHub } from "./memory/mcp-hub";
import { MemoryService, nightlyDistill } from "./memory/memory-service";
import { controlHandler } from "./control/control-handler";
import { ControlInbox } from "./control/control-inbox";
import { HookInbox } from "./hooks/inbox";
import { stageEventFromHook } from "./hooks/stage-hook";
import { InboxRepo } from "./db/inbox-repo";
import { PrStagesService } from "./prwatch/pr-stages-service";
import { InboxService } from "./inbox/inbox-service";
import { registerIpc } from "./ipc/register";
import { ensureDirs, refreshTailPath, resolvePaths } from "./paths";
import { isWorkingDay, localDate } from "./schedule/calendar";
import { BackgroundRunner, morningJob, nightlyJob, type DailyJobDeps } from "./schedule/daily-jobs";
import { ButlerPatrol } from "./schedule/butler-patrol";
import { Scheduler, TICK_MS, type ScheduleTrigger } from "./schedule/scheduler";
import { AdmissionPolicyService } from "./lessons/admission-policies";
import { ConfigIoService, defaultRegistry } from "./config-io";
import { ConfigBackups } from "./config-io/backup-job";
import { configIoFacade, defaultSavePath } from "./config-io/facade";
import { ActivityMonitor, activityIntervals } from "./sessions/activity-monitor";
import { sessionRegistryName } from "./sessions/activity-sources";
import { DeliveryGuard, USER_TYPING_QUIET_MS, type DeliveryGuardDeps } from "./sessions/delivery-guard";
import { writeRefreshTail } from "./sessions/refresh-tail";
import { autoRefreshNeedsYou, refreshKindOf, SessionRefresher, startRefresh } from "./sessions/session-refresher";
import { SessionCleanup, working } from "./sessions/session-cleanup";
import { Hibernator } from "./sessions/hibernator";
import { childrenWorking } from "./sessions/managed-by";
import { findTranscript, needsDiscovery, scanClaudeProjects, syncDiscovered, transcriptState, UNCLAIMED_WINDOW_MS, type HeadCache } from "./sessions/discovery";
import { PtyManager } from "./sessions/pty-manager";
import { nodePtyFactory } from "./sessions/pty-node";
import { SessionService } from "./sessions/session-service";
import { judgeStuck } from "./sessions/stuck-judge";
import { markTurnEndedWithoutStop } from "./sessions/turn-end";
import { deliveryNeedsYou, judgeNeedsYou, NeedsYouTracker, type NeedsYouHead } from "./sessions/needs-you";
import { buildNowView } from "./now/now-view";
import {
  checksConfig, configBackupIntervalDays, configBackupKeep, configExportReminderDays, hibernateEndWatchersOn, hibernateMinutes, hibernateOn, idleCloseMinutes, sharedMcpOn, llmConfig, memoryOn,
  memoryPressureFreePercent, memoryPressureOn, refreshThreshold, scheduleConfig, SettingError, trackerTools,
} from "./settings/settings-values";
import { watcherGuideLines } from "./procs/watcher-policy";
import { createProcServices, type ProcServices } from "./procs/proc-services";
import { platformKill } from "./procs/orphans";
import { readProcTable } from "./procs/proc-table";
import { MemorySamplesRepo } from "./db/memory-samples-repo";
import { runSmoke } from "./smoke";
import { M } from "./strings";
import { pathKey } from "./util/env";
import { resolveGh } from "./util/gh-path";
import { applyGitResolution, resolveGit } from "./util/git-path";
import { openKnownPr } from "./util/github-url";
import { TicketService } from "./tickets/ticket-service";
import { applyGhResolution, branchRuns, ghAvailable, probeGh, compareFiles, failedLog, mergedPrs, prInfo, prLessonDataDetail, prsForBranch, prStatus, reviewAuthors, reviewComments } from "./tickets/gh";
import { LessonsRepo } from "./db/lessons-repo";
import { LessonRunsRepo } from "./db/lesson-runs-repo";
import { RepoIdentity } from "./lessons/repo-identity";
import { readTailLines, TRANSCRIPT_TAIL_BYTES } from "./lessons/tail";
import { LessonRunner } from "./lessons/lesson-runner";
import { LessonsService } from "./lessons/lessons-service";
import { LessonBatchService } from "./lessons/lesson-batches";
import { BatchRecorder } from "./batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "./batches/table-adapter";
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

const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** hook 发现没有 ticket 的 session 后，稍等片刻再扫描磁盘（合并连续事件）。 */
const HOOK_DISCOVERY_DEBOUNCE_MS = 3000;
/** 系统空闲超过这么多秒就不算“正在用电脑”（用于 tick 触发早间任务）。 */
const ACTIVE_IDLE_SECONDS = 120;

let win: BrowserWindow | null = null;
/** 窗口 show / restore 时调（bootstrap 里接到 WS-M 的优先级上）。 */
let windowShownHook: () => void = () => undefined;
let tray: Tray | null = null;
/** e2e 设 BUTLER_BACKGROUND_WINDOWS=1：窗口不激活、macOS 上不进 Dock，测试跑起来不把焦点从别的程序抢过来。 */
const BACKGROUND_WINDOWS = process.env.BUTLER_BACKGROUND_WINDOWS === "1";
/** 防休眠开关（托盘菜单和侧边栏都能开关）；bootstrap 里建好。 */
let keepAwake: KeepAwake | null = null;
const quitState = createQuitState(() => app.quit());
let logger: Logger = () => undefined;
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

// 隔离运行（BUTLER_HOME 指向别的目录）时也换一个 Electron 用户目录，否则单实例锁会和正在用的 Butler 冲突。
// 用 resolvePaths 解析：相对路径会变成绝对路径（setPath 只接受绝对路径）。
if (process.env.BUTLER_HOME?.trim()) app.setPath("userData", join(resolvePaths().home, "electron"));
// Windows 的通知要有 AppUserModelID，否则点击通知没有反应（计划 2 Task 13）。
if (shouldSetAppId(process.platform)) app.setAppUserModelId(APP_ID);

function safeSend(channel: string, ...args: unknown[]): void {
  if (win && canSend(win)) win.webContents.send(channel, ...args);
}

/** 开发时仓库根目录下的 build/（out/main/index.js 往上两级）。 */
const devBuildDir = (): string => join(__dirname, "..", "..", "build");

function bundledHookPath(): string {
  const name = process.platform === "win32" ? "butler-hook.exe" : "butler-hook";
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

/** 总控 session 的 butler-sessions MCP（和记忆 MCP 一起打包，放在同一个目录）。 */
function bundledSessionsMcpPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "memory-mcp", "butler-sessions-mcp.cjs") : join(devBuildDir(), "memory-mcp", "butler-sessions-mcp.cjs");
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
    title: "Butler",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 自动化测试（e2e）在后台开窗口：不抢焦点，不打断用户在别的程序里打字。
  w.on("ready-to-show", () => (BACKGROUND_WINDOWS ? w.showInactive() : w.show()));
  w.on("closed", () => {
    if (win === w) win = null;
  });
  // 窗口又出现了：看得见的终端马上恢复优先级（WS-M E）。
  w.on("show", () => windowShownHook());
  w.on("restore", () => windowShownHook());
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
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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

function trayTooltip(): string {
  return keepAwake?.isOn() ? M().trayTooltipKeepAwake : "Butler";
}

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();
  await ensureDirs(paths);
  logger = createFileLogger(join(paths.logs, "main.log"), undefined, app.isPackaged ? undefined : teeToConsole);
  if (!app.isPackaged) process.stderr.on("error", () => { teeBroken = true; });
  // 先用 Butler 自己的 PATH 定下 git 和 gh 的绝对路径；登录 shell 的 PATH 读到之后再更新一次。
  const ownPath = process.env[pathKey(process.env)] ?? "";
  applyGitResolution(resolveGit(ownPath, process.platform), process.platform, (m) => logger(m));
  applyGhResolution(resolveGh(ownPath, process.platform), process.platform, (m) => logger(m));
  void probeGh(5000);
  const db = openDatabase(paths.db);
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const featureForCwd = (cwd: string): number | null => features.byWorkspace(cwd)?.id ?? null;
  const epics = new EpicsRepo(db);
  const epicForCwd = (cwd: string): number | null => epics.byWorkspace(cwd)?.id ?? null;
  const settings = new SettingsRepo(db);
  /** 当前语言：BUTLER_LANG > 设置 > 系统首选语言（设计文档 2026-10-26）。 */
  const applyLanguage = () => setLang(resolveLang(settings.get("language"), app.getPreferredSystemLanguages(), process.env.BUTLER_LANG));
  applyLanguage();
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const jobs = new JobsRepo(db);
  const featureHandoffs = new FeatureHandoffsRepo(db);
  const epicHistory = new EpicHistoryRepo(db);
  // PR 进度的原始事件：PR 监视和 hook 的 skill 事件共用这一个。
  const prStages = new PrStageRepo(db);
  const memory = new MemoryService({
    dataDir: paths.statecore,
    tickets,
    handoffs,
    followups,
    features,
    featureHandoffs,
    epics,
    // sessionService 在后面才建好：回调里才用到。
    epicRows: (id) => sessionService.epicFeatureRows(id),
    sync: new MemorySyncRepo(db),
    enabled: () => memoryOn(settings),
    now: Date.now,
    // 记忆标签开着时能看到新写入的内容：只发记忆专用的事件，标签不跟着每次 stateChanged 重新打开 StateCore（最终审查 4）。
    onSynced: (key) => safeSend(IPC.memoryChanged, key),
    log: logger,
  });
  const ticketService = new TicketService({ tickets, features, settings, now: Date.now, workspacesDir: paths.workspaces });
  // hook 程序是当前版本（启动时刚换好或本来就是，或健康页刚装好）才看得到 skill 调用：从这时起记「开始记 skill 的时间」。幂等，不会往后移。
  const seedSkillTracking = () => {
    try {
      ensureSkillTrackingSince({ settings, firstSkillAt: () => prStages.firstSkillAt(), now: Date.now });
    } catch (e) {
      logger("skill tracking start not recorded", e);
    }
  };
  const health = new HealthService({ paths, platform: process.platform, env: process.env, settings, bundledHookBin: bundledHookPath(), memoryMcpScript: bundledMemoryMcpPath(), log: logger, onHookBinCurrent: seedSkillTracking });
  const notify = () => safeSend(IPC.stateChanged);
  // 健康探测可能很慢（登录 shell、claude --version）：后台进行，窗口先出来。
  // 同时把升级后还是旧版本的 butler-hook 换成新的（最终审查 1）：打开 session 要等 healthReady，gate 开不开在那之前就定了。syncHookBinary 不抛错。
  // Butler 旧版本装的 /handoff 也先换成当前版本再探测（C1），健康页报告的是换完的状态。syncHandoffCommand 不抛错。
  const healthReady: Promise<void> = Promise.all([health.syncHandoffCommand().then(() => health.refresh()), health.syncHookBinary()]).then(
    () => {
      if (health.hookBinCurrent() && existsSync(paths.hookBin)) seedSkillTracking();
      applyGitResolution(resolveGit(health.claude().pathValue, process.platform), process.platform, (m) => logger(m));
      applyGhResolution(resolveGh(health.claude().pathValue, process.platform), process.platform, (m) => logger(m));
      notify();
      void probeGh(5000).then(() => notify()).catch((e: unknown) => logger("gh probe notify failed", e));
    },
    (e: unknown) => {
      logger("initial health refresh failed", e);
    },
  );
  const usageRepo = new UsageRepo(db);
  /** 某个 session（取 head）最近一轮的上下文大小：计划 16 的自动换新看它。 */
  const contextOf = (sessionId: string): number | null => usageRepo.latestContext(sessions.head(sessionId)?.id ?? sessionId);
  /** headless 运行（handoff、feature 汇总、卡住判断）的用量入库。 */
  const recordHeadlessUsage = ({ runId, label, at, model, usage, task, requestedTier, fallbackFrom, costUsd }: UsageReport) => {
    try {
      usageRepo.record([{
        messageId: `headless:${runId}`, sessionId: null, agentId: null, source: "headless", job: jobOf(label), at, model, ...usage,
        context: usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead,
        ...(task !== undefined && { task, requestedTier: requestedTier ?? null, fallbackFrom: fallbackFrom ?? null, costUsd: costUsd ?? null }),
      }]);
    } catch (e) {
      logger("recording headless usage failed", e);
    }
  };
  const usageScanner = new UsageScanner({
    repo: usageRepo,
    sessionIds: () => pty.openIds().map((t) => sessions.head(t)).filter((s) => s?.origin === "butler").map((s) => s!.id),
    transcriptFile: (id) => findTranscript(paths.claudeProjects, id),
    log: logger,
  });
  /** will-quit 关数据库之前置位：之后才到的终端退出事件（killAll 是异步的）不再碰数据库。没处理的空 session 下次启动时清掉。 */
  let closing = false;
  // 内存、优先级、孤儿（WS-M）：要等 refresher 建好才装，终端退出事件在那之前到就跳过。
  let procs: ProcServices | null = null;
  // 休眠（WS-M B、C）：要等 procs 和下面的一堆服务建好才装，在那之前没有休眠这回事。
  let hibernator: Hibernator | null = null;
  /** 休眠着的 head（Butler 结束了它的终端，等事情来了再 --resume）。 */
  const hibernatedHeads = (): Session[] => sessions.listHibernated();
  /** 这条链休眠着（正在休眠、正在唤醒的也算）。 */
  const isHibernated = (id: string): boolean => hibernator?.isHibernated(id) ?? false;
  const pty = new PtyManager(nodePtyFactory, {
    data: (id, data) => safeSend(IPC.ptyData, id, data),
    exit: (id, code) => {
      safeSend(IPC.ptyExit, id, code);
      if (closing) return;
      procs?.terminalExited(id);
      // 共享 MCP（WS-M H）：撤掉这个终端的路由，删掉它的配置文件。
      mcpHub.removeTerminal(id);
      removeTerminalMcpConfig(paths.mcp, id);
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
   * 记忆 server（记忆开着时）加上 butler-sessions（设计文档 2026-10-23 第二步，和记忆开关无关）。
   * mem 是要挂哪些记忆：ticket 的、feature 的（设计文档 2026-10-26）、epic 的（设计文档 2026-11-01）；scope 是总控管的 ticket 或 feature，
   * 普通 ticket session 是 member（只有 ask_user、report，BTL-190 第 2+3 点）。
   */
  const launcher = (script: string) => ({ command: process.execPath, script });
  const mcpServers = (mem: { ticketKey?: string; featureId?: number | null; epicId?: number | null }, scope: { ticketKey: string; member?: boolean } | { featureId: number; epic?: boolean } | { epicId: number } | { butler: true }) => {
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
      logger(`sessions MCP bundle missing at ${script}; sessions have no butler-sessions tools (run pnpm build:memory-mcp)`);
      sessionsMcpMissingLogged = true;
    }
    return servers as Record<string, StdioServerSpec>;
  };
  /**
   * 共享 MCP 开着、hub 在跑：这个终端的 server 换成 hub 上的路由，写进 mcp/terms/<终端>.json；否则 null，调用方写今天的 stdio 配置。
   * hub 还在启动、挂了、bundle 不在的时候都是 stdio，session 照样有 Butler 的 MCP。
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
  /** 每次打开 session 时重写这个 ticket 的 --mcp-config 文件（设计文档 4.2、8.4）。什么都不挂时返回 null。 */
  const memoryMcpConfig = (ticketKey: string, opts: { coordinator: boolean; featureId: number | null; epicId: number | null }, termId: string): string | null => {
    const servers = mcpServers({ ticketKey, featureId: opts.featureId, epicId: opts.epicId }, opts.coordinator ? { ticketKey } : { ticketKey, member: true });
    if (Object.keys(servers).length === 0) return null;
    return sharedMcpConfig(termId, servers) ?? writeTicketMcpConfig({ mcpDir: paths.mcp, ticketKey, servers, coordinator: opts.coordinator });
  };
  /** feature 总控：feature 记忆、全局记忆和 feature 模式的 butler-sessions；feature 属于 epic 时加 epic 记忆。 */
  const featureMcpConfig = (featureId: number, epicId: number | null, termId: string): string | null => {
    const servers = mcpServers({ featureId, epicId }, { featureId, epic: epicId !== null });
    if (Object.keys(servers).length === 0) return null;
    return sharedMcpConfig(termId, servers) ?? writeFeatureMcpConfig({ mcpDir: paths.mcp, featureId, servers });
  };
  /** epic session：epic 记忆、全局记忆和 epic 模式的 butler-sessions（list_features、list_repos、create_feature，以及各 feature 的 session）。 */
  const epicMcpConfig = (epicId: number, termId: string): string | null => {
    const servers = mcpServers({ epicId }, { epicId });
    if (Object.keys(servers).length === 0) return null;
    return sharedMcpConfig(termId, servers) ?? writeEpicMcpConfig({ mcpDir: paths.mcp, epicId, servers });
  };
  /** Butler 总控（BTL-190 第 5 点）：只有全局记忆（butler-workspace）和 Butler 模式的 butler-sessions。 */
  const butlerMcpConfig = (termId: string): string | null => {
    const servers = mcpServers({}, { butler: true });
    if (Object.keys(servers).length === 0) return null;
    return sharedMcpConfig(termId, servers) ?? writeButlerMcpConfig({ mcpDir: paths.mcp, servers });
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
  const judgeDeps: HeadlessExecDeps = {
    run: runHeadless, ready: () => healthReady, claude: () => health.claude(), baseEnv: process.env, sessions, now: Date.now, newRunId: randomUUID,
    signal: headlessAbort.signal, onUsage: recordHeadlessUsage, ...availabilityHooks, routing, log: logger,
  };
  /** 复盘的闸门：没配置路由时就是账号级的可用状态；配置了只在 lesson_analyze 哪个模型都用不了时停。 */
  const lessonsGate = new RoutedLessonsGate({ availability, routing, now: Date.now });
  // 复盘规矩：合并的 PR 排队，用用户自己的 claude 分析（最多 2 个同时）。
  const lessonsRepo = new LessonsRepo(db);
  // 规矩、产品和准入策略的改动都记成可撤销的批次（契约 4.4）。
  const batchRecorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  // 确定性检查（契约 4.5）：库里是三层的定义，hook 只读 Butler 写出来的快照（<BUTLER_HOME>/checks/snapshot.json）。
  // 检查、产品、设置、语言一变就重写快照（合并一小段时间里的改动）；内容没变不写。
  const checksService: ChecksService = new ChecksService({
    db, lessons: lessonsRepo, recorder: batchRecorder, now: Date.now, config: () => checksConfig(settings),
    onChanged: () => checkSnapshots.schedule(),
    snapshotStatus: () => checkSnapshots.lastStatus(),
  });
  const checkSnapshots = new SnapshotWriter({ file: paths.checksSnapshot, build: () => checksService.snapshot(), log: logger });
  checkSnapshots.start();
  // hook 一次运行写一个命中文件：读进 check_hits，「没有检查」记到 session 行上。
  const checkHits = new HitIngest({
    dir: paths.checksHits,
    insertHits: (rows) => checksService.repo.insertHits(rows),
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
    version: {
      get: () => Math.max(1, Number.parseInt(settings.get("admissionPolicyVersion"), 10) || 1),
      set: (v) => settings.set("admissionPolicyVersion", String(v)),
    },
  });
  // 导入导出（契约 4.3）：备份放在 <BUTLER_HOME>/backups。
  const configBackupDir = join(paths.home, "backups");
  const configRegistry = defaultRegistry();
  const configIo = new ConfigIoService({
    db, repo: lessonsRepo, policies: admissionPolicies, recorder: batchRecorder, registry: configRegistry, butlerVersion: app.getVersion(),
    backupDir: configBackupDir, now: Date.now, onExported: (at) => settings.set("configLastExportAt", String(at)), onApplied: () => (checkSnapshots.schedule(), routing.reloadConfig()), log: logger,
  });
  // 从规矩生成检查（任务 check_draft）：走模型路由（高档，撞限就等；没配置路由时和以前一样不带 --model）。
  const checkDrafter = new CheckDrafter({
    lessons: lessonsRepo, checks: checksService, fallbackCwd: () => paths.home,
    run: (req) => execHeadlessJson(judgeDeps, req),
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
  const lessonRunner = new LessonRunner({
    repo: lessonsRepo, runs: lessonRuns, availability: lessonsGate, identity: repoIdentity, jobs,
    upgradeReady: () => routing.tierHealthy(routing.plan("lesson_analyze").route.tier as Tier),
    gh: { mergedPrs, prLessonDataDetail, compareFiles, available: () => ghAvailable() },
    headless: { ...judgeDeps },
    ticketForBranch: (slug, branch) => tickets.reposByBranch(branch).find((r) => repoIdentity.slugOf(r.repoPath) === slug)?.ticketKey ?? null,
    butlerContext: async (key, wantTranscripts) => {
      const ps = handoffs.listByTicket(key, 20).flatMap((h) => (h.payload ? [h.payload] : []));
      const seen = new Set<string>();
      const transcripts: string[][] = [];
      if (wantTranscripts) {
        for (const s of sessions.listByTicket(key)) {
          for (const id of sessions.chainOf(s.id)) {
            if (seen.has(id)) continue;
            seen.add(id);
            const file = findTranscript(paths.claudeProjects, id);
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
  });
  // 设置页「升级重跑」按钮；另外每小时看一次（档位恢复时路由的变化也会触发）。
  routing.rerunHook = () => void lessonRunner.requeueUpgrades(true);
  const upgradeTimer = setInterval(() => lessonRunner.requeueUpgrades(), 60 * 60_000);
  upgradeTimer.unref?.();
  // 复盘规矩页：仓库路径直接查表（已归档的 ticket、feature、epic 不算）；归组建议按 ticket 和 feature 各算一组。
  const repoPathRows = <T extends { repo_path: string }>(sql: string): T[] => db.prepare(sql).all() as unknown as T[];
  const lessonsService = new LessonsService({
    repo: lessonsRepo, batches: lessonBatches, runs: lessonRuns, availability: lessonsGate, identity: repoIdentity, runner: lessonRunner,
    knownRepoPaths: () => [
      ...new Set(
        repoPathRows<{ repo_path: string }>(
          `SELECT tr.repo_path FROM ticket_repos tr JOIN tickets t ON t.key = tr.ticket_key WHERE t.archived_at IS NULL
           UNION SELECT fr.repo_path FROM feature_repos fr JOIN features f ON f.id = fr.feature_id WHERE f.archived_at IS NULL
           UNION SELECT er.repo_path FROM epic_repos er JOIN epics e ON e.id = er.epic_id WHERE e.archived_at IS NULL`,
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
    // writeRunFile 写不了会同步抛出：LessonsService 接住，记日志，返回 write_failed。sessionService 在下面才建好：调用时才用到。
    openRun: (d, repoPath) => {
      const file = writeRunFile(paths.lessonsWorkspace, d, currentLang());
      return sessionService.openLessonRun({ runId: d.id, repoPath, file, label: `lesson run ${d.id}` });
    },
  });
  /** 休眠前最后一次看到的样子：休眠的 session 照样留在「需要你」里（活动监视只看开着的终端）。 */
  const needsYouFrozen = new Map<string, NeedsYouHead>();
  /** 开着终端的 Butler session 的 head（同一个 head 只算一次），带上活动和最后一条回复。activityMonitor 在下面才建好：调用时才用到。 */
  const needsYouHeads = (): NeedsYouHead[] => {
    const heads = new Map<string, NeedsYouHead>();
    for (const termId of pty.openIds()) {
      const h = sessions.head(termId);
      // 复盘分析 session 只是用户来问问题的，不判断需要你。
      if (!h || h.origin !== "butler" || h.lessonRunId !== null || heads.has(h.id)) continue;
      heads.set(h.id, { id: h.id, cwd: h.cwd, waiting: h.waitingForInput, kind: activityMonitor.get(h.id)?.kind ?? null, reply: activityMonitor.lastReplyOf(h.id) });
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
    judge: (reply, cwd) => judgeNeedsYou({ ...judgeDeps, timeoutMs: 60_000 }, reply, cwd),
    sessions: needsYouHeads,
    notify,
    log: logger,
  });
  const activityMonitor = new ActivityMonitor({
    sessions, tickets, features, pty,
    transcriptFile: (id) => findTranscript(paths.claudeProjects, id),
    judge: (input) => judgeStuck(judgeDeps, input),
    // 活动变了：先看停下来的 session 有没有新回复要判断、有没有该自动换新的，再刷新界面。
    // 换新自己的 notify 只发 stateChanged（不回到这里），所以 autoCheck → notify 不会再回到 autoCheck。
    notify: () => {
      needsYou.update();
      refresher.autoCheck();
      notify();
    },
    // 卡住不再弹系统通知（之后在「现在」页里显示）：只刷新界面。
    onStuck: () => notify(),
    now: Date.now,
    intervals: activityIntervals(process.env),
    // 实况窗口（BTL-190 第 7 点）：新的工具调用、记忆读写直接推给界面。
    onEvent: (e) => safeSend(IPC.activityEvent, e),
    // transcript 显示这一轮没经过 Stop 就结束了（Esc 打断、API / 限额错误）：Claude Code 不触发 Stop，不记成在等输入的话，
    // 之后往里发消息、闲置自动关闭都认为它还在忙。at 之后已经有输入（UserPromptSubmit）就不动。
    onTurnEnd: (id, at) => {
      if (markTurnEndedWithoutStop(sessions, id, at)) sessionStopped(id);
    },
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
  /** 把任务作为第一条消息交给新 session：总控开的子 session 和修复 session 都走这里。 */
  const submitTask = (termId: string, message: string) => pty.deliver(termId, message, { singleLine: process.platform === "win32" });
  /** 装着的 butler-hook 是当前版本：只有这时才挂 gate / check hook。 */
  const hookInstalled = () => health.hookBinCurrent() && existsSync(paths.hookBin);
  /** 这次启动的 session 为什么跑不了检查（addendum 第 7 节）；没有打开的检查就不算缺。 */
  const checksAbsence = (): CheckAbsenceReason | null => {
    if (!checksService.anyEnabled()) return null;
    if (!checksConfig(settings).enabled) return "disabled";
    if (!hookInstalled()) return "hook_outdated";
    const st = readSnapshotState(paths.checksSnapshot, CHECKS_SNAPSHOT_VERSION);
    return st === "ok" ? null : st === "version" ? "snapshot_version" : "no_snapshot";
  };
  const sessionService = new SessionService({
    knownModel: routing.registered,
    tickets, sessions, settings, ticketService, pty,
    activity: (id) => activityMonitor.get(id),
    sessionName: (id) => sessionRegistryName(paths.claudeSessions, id),
    submit: submitTask,
    // featureRunner 在后面才建好：回调里才用到。
    epicRefresh: (id) => featureRunner.epicRefresh(id),
    // mergeGate 也在后面才建好。
    dirBusy: (repo): Promise<{ ticket: string; branch: string } | null> => mergeGate.dirBusy(repo),
    ready: () => healthReady,
    transcriptExists: (id) => transcriptState(paths.claudeProjects, id) !== "absent",
    transcriptState: (id) => transcriptState(paths.claudeProjects, id),
    claude: () => health.claude(),
    newId: randomUUID,
    now: Date.now,
    platform: process.platform,
    baseEnv: process.env,
    mcpConfig: memoryMcpConfig,
    // 装着的 butler-hook 是旧版本（不认 gate）时不挂 gate hook：旧程序会把每条 Bash 命令当成普通 hook 事件写进收件箱。
    mcpSettings: (dirs) => {
      const cc = checksConfig(settings);
      return projectMcpApprovalSettings(dirs, {
        claudeJson: paths.claudeJson, claudeSettings: paths.claudeSettings, mcpDir: paths.mcp, log: logger, allowTools: SESSIONS_AUTO_ALLOW,
        gateCommand: hookInstalled() ? hookCommand(paths.hookBin, process.platform) : undefined,
        checks: cc.enabled ? { editTimeoutSec: cc.editTimeoutSec, pushTimeoutSec: cc.pushTimeoutSec } : undefined,
      });
    },
    checksAbsence,
    guidePath: (kind, repoPaths) =>
      writeSessionGuide(paths.mcp, currentLang(), kind, kind === "ticket" ? safeSessionLessons(lessonsRepo, repoIdentity, repoPaths, logger) : [], kind === "ticket" ? watcherGuideLines(currentLang(), repoPaths) : []),
    featureMcpConfig,
    epicMcpConfig,
    butlerWorkspace: paths.butlerWorkspace,
    butlerMcpConfig,
    lessonsWorkspace: paths.lessonsWorkspace,
    features, epics, featureHandoffs, handoffs, epicHistory,
    // 打开 session 时补同步这个 ticket（最终审查 6）：上次同步失败、或记忆刚打开过，claude 不会读到旧的记忆。走同步队列，失败只写日志。
    syncMemory: (key) => void memory.syncTicket(key),
    opened: (termId) => hibernator?.opened(termId),
    hidden: (id) => hibernator?.forget(id),
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
      if (h.butler) return sessionService.openButler({ sessionId: h.id });
      if (h.ticketKey) return sessionService.open({ ticketKey: h.ticketKey, sessionId: h.id });
      if (h.featureId !== null) return sessionService.openFeature({ featureId: h.featureId, sessionId: h.id });
      if (h.epicId !== null) return sessionService.openEpic({ epicId: h.epicId, sessionId: h.id });
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

  const transcriptMtime = (id: string): number | null => {
    const file = findTranscript(paths.claudeProjects, id);
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
      { db, tickets, handoffs, followups, now: Date.now, newFollowupId: () => `f_${randomBytes(4).toString("hex")}`, linkPrs: (k, prs) => void prLinker.linkHandoffPrs(k, prs), linkedOpen, givenUpPrs },
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
  const runner = new HandoffRunner({
    tickets, sessions, handoffs, followups, settings, ingest,
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
    log: logger,
  });
  /** feature 有新汇总时，它所在的 epic 重新渲染 handoff（异步，失败只记日志）。 */
  const syncEpicOfFeature = (featureId: number) => {
    const epicId = features.get(featureId)?.epicId ?? null;
    if (epicId !== null) void memory.syncEpic(epicId);
  };
  /** feature 汇总入库（设计文档 2026-10-28）：存下有效的汇总后写进 feature 的记忆（异步，失败只记日志），界面刷新。 */
  const ingestFeature = (input: FeatureIngestInput) => {
    const r = ingestFeatureHandoff({ features, tickets, featureHandoffs, now: Date.now, onValidStored: syncEpicOfFeature }, input);
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
    // prWatcher 在下面才建：只在生成汇总、判断过期时（启动之后）才调。
    livePrs: (key): WatchedPr[] => prWatcher.statusOf(key),
    now: Date.now,
    newRunId: randomUUID,
    projectMcp,
    signal: headlessAbort.signal,
    onUsage: recordHeadlessUsage,
    ...availabilityHooks,
    routing,
    log: logger,
  });
  /**
   * 总控里的 /handoff 之后（后台）：存下了汇总就给子 ticket 跑 handoff；没存下（用户自己开的总控没有 Butler 的 MCP，
   * 输出了 ticket 代码块或没有代码块）就由 Butler 从那个 session fork 出来自己生成汇总。见 featureCommandFollowup。
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
  const audit = new AuditRepo(db);
  // 审计的启动收尾，先于一切读写审计的代码：上次退出时没发完的请求记为 failed（请求体保留，可能已经发出），
  // 再按保留期清理一次（不删本月的记录，预算要用；之后 gateway 每次调用前也会清理）。
  try {
    const stale = audit.failStalePending(M().auditStalePending, stalePendingCost(llmConfig(settings).prices));
    if (stale > 0) logger(`marked ${stale} audit row(s) left pending by the previous run as failed`);
    audit.prune(auditCutoff(Date.now(), llmConfig(settings).retentionDays));
  } catch (e) {
    logger("audit housekeeping at startup failed", e);
  }
  const terms = new TermsRepo(db);
  const keys = new KeyStore({ secrets: new SecretsRepo(db), box: electronSecretBox, now: Date.now, log: logger });
  const gateway = new PrivacyGateway({
    settings, audit, keys, now: Date.now,
    log: logger,
  });
  // 同时只跑一次蒸馏；退出时 headlessAbort 让 gateway 拒绝 / 中止调用，蒸馏在下一个 scope 之前停下。
  const distiller = new BackgroundRunner({
    name: "memory distill",
    run: (signal) => nightlyDistill({ memory, gateway, signal, log: logger }),
    signal: headlessAbort.signal,
    log: logger,
  });
  /**
   * epic 的长期记忆（计划 16 任务 6）：每个 epic 每周跟着工作日的晚间任务整理一次，feature 归档时也整理一次。用 Sonnet，不 fork session，
   * 和卡住判断共用 headless 设置（用量记进 session_usage，退出时取消）。
   */
  const epicDigest = new EpicDigestRunner({
    ...judgeDeps,
    history: epicHistory, epics, features, featureHandoffs, handoffs, tickets, memory,
    cwd: () => paths.home,
  });
  /**
   * feature 归档之后（不等它）：对它所在的 epic 整理一次；不属于 epic 的 feature 只整理它自己。
   * 归档被拒（有终端在跑）的走不到这里；这次没归档成的（例如等汇总期间又被恢复）不整理。重复调用由 runner 跳过：没有新东西就不跑。
   */
  const digestArchivedFeature = (featureId: number) => {
    if (features.get(featureId)?.archivedAt != null) void epicDigest.forFeatureArchived(featureId);
  };
  const dailyDeps: DailyJobDeps = {
    runner,
    features: featureRunner,
    isWorkingDay: () => isWorkingDay(localDate(Date.now()), scheduleConfig(settings).workingDays),
    hasTrackerTools: () => trackerTools(settings).length > 0,
    aborted: () => headlessAbort.signal.aborted,
    log: logger,
    // full 档位的记忆蒸馏：在后台跑，不挡调度链；每次运行都重新向 gateway 要模型（改档位不用重启），模型只经 withScope 交给嵌入式 StateCore。
    distill: () => distiller.start(),
    epicDigest,
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
   * 退出开始后不再发起新的调度任务。Butler 总控的每日巡检（BTL-190 第 5 点）用同样的触发时机，但不排进 Scheduler 的链：
   * 它可能要等 session 停下来，不能挡住晚间 handoff。butlerPatrol 在下面才建好：调用时才用到。
   */
  const checkSchedule = (trigger: ScheduleTrigger) => {
    if (headlessAbort.signal.aborted) return Promise.resolve();
    void butlerPatrol.check();
    void lessonRunner.daily().catch((e: unknown) => logger("lessons: daily pull failed", e));
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
      syncDiscovered(found, sessions, Date.now(), featureForCwd, epicForCwd);
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
  let hookDiscoveryTimer: NodeJS.Timeout | null = null;
  const scheduleDiscovery = () => {
    if (hookDiscoveryTimer) return;
    hookDiscoveryTimer = setTimeout(() => {
      hookDiscoveryTimer = null;
      void runDiscovery();
    }, HOOK_DISCOVERY_DEBOUNCE_MS);
  };

  // 合并总控（设计文档 2026-11-04）。等待者记的是 BUTLER_SESSION（打开终端时的 id = termId）；Butler 重开过的终端用链上最新的 id，按 head 找回来。
  const gateRepo = new MergeGateRepo(db);
  const whoOf = makeWhoOf({ tickets, features, epics });
  const gateTerm = (sessionId: string): string | null => {
    if (pty.isOpen(sessionId)) return sessionId;
    const head = sessions.head(sessionId)?.id;
    return head ? (pty.openIds().find((t) => sessions.head(t)?.id === head) ?? null) : null;
  };
  // 所有自动输入共用的一道检查（计划 13）：停着等输入、屏幕上没有要回答的、用户没在打字、没有草稿才贴。
  const guardDeps: DeliveryGuardDeps = {
    termOf: gateTerm,
    head: (id) => sessions.head(id),
    activity: (id) => activityMonitor.get(id),
    pty,
    // BUTLER_GATE_TYPING_QUIET_MS 只给 e2e 用（它刚在终端里打过字，不想多等 30 秒）。
    typingQuietMs: Number(process.env.BUTLER_GATE_TYPING_QUIET_MS) || undefined,
    // 休眠着的：叫它醒，醒来以后 sessionStopped 再递（WS-M B）。
    wakeIfHibernated: (id) => {
      if (!hibernator || !isHibernated(id)) return false;
      void hibernator.wake(id, "delivery");
      return true;
    },
    now: Date.now,
  };
  // 合并通知和 CI 结果用的：在等用户回答的 session 不往里贴东西（计划 14），「需要你」还没判断完的也先不贴（I1），
  // 正在换新的也不贴（计划 16）。refresher 在下面才建好：回调里才用到。
  const deliveryGuard = new DeliveryGuard({
    ...guardDeps,
    // 有未决 ask_user 的也算在等用户（BTL-190 第 2+3 点）。inboxService 在下面才建好：回调里才用到。
    needsYou: (id): boolean => deliveryNeedsYou(needsYou, id) || inboxService.hasPendingDecision(id),
    refreshing: (id) => refresher.isRefreshing(id),
  });
  /** Stop 到的时候先重读这个 session 的活动（guard 看的是上一次刷新的）。活动按 head 的 id 跟踪；Stop 带来的可能是链上的旧 id。 */
  const refreshActivityOf = async (id: string): Promise<void> => {
    const head = sessions.head(id)?.id;
    if (head) await activityMonitor.refreshSession(head);
  };
  /** 开着终端的 Butler session 的 head（同一个 head 只算一次）。 */
  const openButlerHeads = (): Session[] => {
    const heads = new Map<string, Session>();
    for (const termId of pty.openIds()) {
      const h = sessions.head(termId);
      if (h && h.origin === "butler") heads.set(h.id, h);
    }
    return [...heads.values()];
  };
  /** 开着终端的加上休眠着的 Butler session 的 head：汇报找总控时休眠的总控也算（送的时候叫它醒）。 */
  const liveButlerHeads = (): Session[] => {
    const heads = new Map(openButlerHeads().map((h) => [h.id, h]));
    for (const h of hibernatedHeads()) if (h.origin === "butler" && !heads.has(h.id)) heads.set(h.id, h);
    return [...heads.values()];
  };
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
    // 和 HealthService 装命令的是同一个文件；Butler 的旧版本也算（C1）。读不了当作不是 Butler 的（不换新）。
    handoffCommandReady: () =>
      handoffCommandUsable(handoffCommandPath(paths.claudeCommands)).catch((e: unknown) => {
        logger("refresh: reading the /handoff command file failed", e);
        return false;
      }),
    // epic 的规划已经单独存放（Task 1），epic 总控也可以换新。
    epicPlanReady: () => true,
    memoryEnabled: () => memoryOn(settings),
    epicProgress: (id) => memory.epicProgress(id),
    // 和递 CI 结果一样最多等 1 分钟：session 是停着的，输入框应该很快就绪。斜杠命令粘贴进去照样会执行（R26 用真的 claude 验证过）。
    deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
    sessions: openButlerHeads,
    lastUserInputAt: (termId) => pty.lastUserInputAt(termId),
    openedAt: (termId) => pty.openedAt(termId),
    // BUTLER_REFRESH_OPEN_QUIET_MS 只给 e2e 用（后台窗口模式下才算数）：它刚打开终端就要看自动换新，不想多等 1 分钟。
    openQuietMs: process.env.BUTLER_BACKGROUND_WINDOWS === "1" ? Number(process.env.BUTLER_REFRESH_OPEN_QUIET_MS) || undefined : undefined,
    // handoff 收进来时 ingest 已经把记忆同步排进队列（syncTicket / syncFeature）：/clear 之前等它写完（BTL-190 第 6 点）。
    memoryIdle: () => memory.idle(),
    // 换新前的对话尾巴：读旧 head 的 transcript，按终端的 id 存（同一个终端下一次换新覆盖它）。
    writeTail: (oldHeadId, termId, kind) =>
      writeRefreshTail({ transcript: findTranscript(paths.claudeProjects, oldHeadId), out: refreshTailPath(paths, termId), sessionId: oldHeadId, kind }),
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
  // 「待你决定」和汇报（BTL-190 第 2+3 点）。递回答不看「需要你」（未决的 ask_user 本身就算），别的检查照常；递汇报和 CI 结果同一道 guard。
  const inboxRepo = new InboxRepo(db);
  const inboxService: InboxService = new InboxService({
    repo: inboxRepo,
    head: (id) => sessions.head(id),
    ticket: (key) => tickets.get(key),
    epicOfFeature: (id) => features.get(id)?.epicId ?? null,
    epicName: (id) => epics.get(id)?.name ?? null,
    termOf: gateTerm,
    openHeads: liveButlerHeads,
    answerGuard: new DeliveryGuard({ ...guardDeps, refreshing: (id) => refresher.isRefreshing(id) }),
    reportGuard: deliveryGuard,
    deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
    // 换新输入的 /handoff 和接着做的话也会触发 UserPromptSubmit：那不是用户在终端里回答。
    refreshing: (id) => refresher.isRefreshing(id),
    notify,
    now: Date.now,
    log: logger,
  });
  // send_message 的回复回流（ws-b）：目标停下来时把它最后一条回复送回发消息的总控，和递汇报同一道 guard。
  const butlerMessages = new ButlerMessages({
    repo: new ButlerMessagesRepo(db),
    head: (id) => sessions.head(id),
    lastReply: (id) => activityMonitor.lastReplyOf(id),
    termOf: gateTerm,
    guard: deliveryGuard,
    deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
    targetName: (m) => {
      if (m.featureId !== null) return M().butlerTargetFeature(features.get(m.featureId)?.name ?? String(m.featureId));
      if (m.epicId !== null) return M().butlerTargetEpic(epics.get(m.epicId)?.name ?? String(m.epicId));
      return M().butlerTargetUnknown;
    },
    notify,
    now: Date.now,
    log: logger,
  });
  // Butler 总控的每日巡检（BTL-190 第 5 点）：到点打开（或接着用）Butler 总控，发巡检消息；开着的先过 guard，忙就等下一次 check。
  const butlerPatrol = new ButlerPatrol({
    time: () => settings.get("butlerPatrolTime"),
    jobs,
    now: Date.now,
    running: () => sessionService.runningButler(),
    latest: () => sessionService.latestButler(),
    open: (req) => sessionService.openButler(req),
    guard: deliveryGuard,
    deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
    submit: submitTask,
    message: () => M().butlerPatrolMessage,
    onChange: notify,
    log: logger,
  });
  // 清理 session（BTL-190 第 8 点）：闲置自动关闭、隐藏 14 天后删除、「清理闲置」和「全部删除」。
  const sessionCleanup = new SessionCleanup({
    idleMinutes: () => idleCloseMinutes(settings),
    terminals: () => pty.openIds().flatMap((termId) => {
      const head = sessions.head(termId);
      return head && head.origin === "butler" ? [{ termId, head }] : [];
    }),
    activity: (id) => activityMonitor.get(id),
    lastUserInputAt: (termId) => pty.lastUserInputAt(termId),
    openedAt: (termId) => pty.openedAt(termId),
    ticketsOfFeature: (id) => tickets.listByFeature(id).map((t) => t.key),
    featuresOfEpic: (id) => features.listByEpic(id).map((f) => f.id),
    askUserPending: (id) => inboxService.hasPendingDecision(id),
    // 合并排队（等待者记的是 BUTLER_SESSION，换成 head 再对）、ticket 的 PR 的 CI 还在跑：通知只递给开着的终端。
    waitingOnButler: (headId) => {
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
  const branchWatch = new BranchWatchRepo(db);
  const prLinker = new PrLinker({ prs: ticketPrs, tickets, slugOf: (path) => repoIdentity.slugOf(path), now: Date.now });
  const holdWatcher = new HoldWatcher({
    repo: gateRepo, prInfo, git,
    // 休眠的也算开着：guard 叫它醒，醒来以后 Stop 再递。
    isOpen: (id) => gateTerm(id) !== null || isHibernated(id),
    guard: deliveryGuard,
    refreshActivity: refreshActivityOf,
    // PrWatcher 刚查过的 PR 不用再问 gh。prWatcher 在后面才建好：回调里才用到。
    cachedByUrl: (url) => prWatcher.cachedByUrl(url),
    // 最多等 1 分钟：session 是停着的，输入框应该很快就绪；等不到下一轮再发。
    deliver: async (id, text, recheck) => {
      const t = gateTerm(id);
      return t ? pty.deliver(t, sanitizeTask(text), { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }) : "exited";
    },
    whoOf, now: Date.now, log: logger,
  });
  // 分支是谁的（工作流 W）：hook 看到的 git push / gh pr create 记下来，CI 的结论按它递。
  const branchOwners = new BranchOwnersRepo(db);
  // CI 的结论递给 PR 所属的 session（pickRecipient：推这个分支的、启动时就在这个分支上的、ticket 分支上的第一个）：
  // 和合并通知走同一道 guard，最多等 1 分钟。
  const ciDelivery = new CiDelivery({
    prs: ticketPrs,
    branches: branchWatch,
    currentBranch: (repoId) => tickets.getRepo(repoId)?.branch ?? null,
    guard: deliveryGuard,
    // 休眠着的（WS-M B）也算：guard 叫它醒，醒来以后 sessionStopped 里的 flushCi 再递。
    recipient: (key, repoId, branch) => {
      const o = branchOwners.get(key, repoId, branch);
      return ciRecipient({
        ticketKey: key, repoId, branch,
        openHeads: pty.openIds().flatMap((t) => sessions.head(t) ?? []),
        hibernatedHeads: hibernatedHeads(),
        ownerSessionId: o?.sessionId ?? null,
        headOf: (id) => sessions.head(id),
        ownerTermOpen: o !== null && gateTerm(o.sessionId) !== null,
        ticketBranch: tickets.getRepo(repoId)?.branch ?? null,
      });
    },
    deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
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
  const flushCi = (): Promise<void> => ciDelivery.flush().then(ciStuckChanged).catch((e: unknown) => logger("ci delivery: flush failed", e));
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
    gh: { prStatus, prsForBranch, branchRuns, failedLog, reviewComments, reviewAuthors },
    git: { firstCommitAt: git.firstCommitAt },
    stages: prStages,
    owners: branchOwners,
    onMerged: (pr, repoPath) => lessonRunner.merged({ repoPath, slug: pr.slug }, pr.number),
    // PR 的状态或 review 变了：在最新的 handoff 上换掉 prs，存成一条 refresh。ticket 状态、PR 标签、合并后清理 worktree 都照旧走 ingest。
    onPrChanged: (key) => {
      // 归档 ticket 的补链接行读一次也会走到这里：不为它们写 refresh handoff、不同步记忆。
      if (tickets.get(key)?.archivedAt != null) return;
      const base = handoffs.latestValid(key);
      if (!base?.payload) return;
      const next = prHandoff(key, ticketPrs.byTicket(key), { id: base.id, createdAt: base.createdAt, status: base.payload.status, prs: base.payload.prs });
      if (!next) return;
      // 和早间刷新一样：done_today、followups、decisions、learnings 清空，免得重复计算、重复写进记忆。
      ingest({
        ticketKey: key, sessionId: null, trigger: "refresh",
        payload: { ...base.payload, status: next.status, done_today: [], followups: [], decisions: [], learnings: [], prs: next.prs },
        rawText: null, sourceRef: next.sourceRef,
      });
    },
    onCiSettled: (item) => void ciDelivery.settled(item).catch((e: unknown) => logger("ci delivery: handing over a CI result failed", e)),
    notify,
    // 每轮之后再递一遍：session 停着但当时用户在打字、有草稿的，安静下来之后在这里递出去。
    roundDone: () => void flushCi(),
    now: Date.now,
    log: logger,
  });
  const mergeGate = new MergeGate({
    tickets, repo: gateRepo, git, prInfo, whoOf,
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
   * 有“对方已经合完”的通知就趁现在发（设计文档 2026-11-04：不打断忙着的 session）。
   * 同一个时机也递还没递出去的 CI 结论（先重读活动），并且马上查一次这个仓库的 PR 和 CI（刚停下的 session 常常刚 push）。
   */
  const sessionStopped = (stopped: string): void => {
    void holdWatcher.sessionIdle(stopped);
    // 活动没变时 activityMonitor 不会 notify：停下来以后的「需要你」判断在这里补一次。
    void refreshActivityOf(stopped)
      .catch((e: unknown) => logger(`ci delivery: re-reading the activity of ${stopped} failed`, e))
      .then(() => {
        needsYou.update();
        // 卡片上答好的回答、该送给总控的汇报也趁现在送（永不 reject）。
        void inboxService.flush();
        // 它是总控 send_message 的目标：把这一轮的最后一条回复送回去；它是总控自己：送还没送回的回复（ws-b）。
        void butlerMessages.targetStopped(stopped).then(() => butlerMessages.flush(), (e: unknown) => logger(`butler messages: ${stopped} stopped`, e));
        // 在等 Butler 总控停下来的巡检也趁现在送（BTL-190 第 5 点，永不 reject）。
        if (!headlessAbort.signal.aborted) void butlerPatrol.check();
        return flushCi();
      });
    // 这个 ticket 的 PR 都马上查一次；feature 总控查它所有 ticket 的；别的按仓库。
    const head = sessions.head(stopped);
    if (head?.ticketKey) prWatcher.soonTicket(head.ticketKey);
    else if (head?.coordinator && head.featureId != null) for (const t of tickets.listByFeature(head.featureId)) prWatcher.soonTicket(t.key);
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
      const effect = applyHookEnvelope(env, {
        sessions, tickets, transcriptState: (id) => transcriptState(paths.claudeProjects, id),
        placement: (key, cwd) => ticketService.placement(key, cwd),
        featureForCwd, epicForCwd,
      });
      // Stop 之后看这一轮有没有 /handoff 的输出（异步；失败只记日志，不影响 hook 处理）。
      const stop = stopFromEnvelope(env);
      if (stop) {
        void captureCommandHandoff({ sessions, tickets, ingest, ingestFeature, afterFeatureCommand }, stop).then(
          (r) => {
            // 换新在等这个 session 的 /handoff 收进来（ticket 的和 feature 总控的都算）。校验没过（degraded）的没写进记忆，
            // 清空以后接不上，不算：换新等到超时停下，什么都不再输入。
            if (r?.stored && !r.degraded) refresher.handoffStored(stop.sessionId);
            if (r?.stored) notify();
            // feature 总控（设计文档 2026-10-28）：没存下时记一笔；子 ticket 的 handoff 照样在后台跑（afterFeatureCommand）。
            else if (r && "featureId" in r) {
              const where = `/handoff in feature ${r.featureId} coordinator session ${stop.sessionId}`;
              if (r.reason === "wrong_block") logger(`${where}: printed a ticket butler-handoff block instead of a butler-feature-handoff block; not stored`);
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
      // 设计 / 自我 review 的 skill 调用记进 PR 进度。必须在 ignored 提前返回之前：PostToolUse 在 applyHookEnvelope 里恒为 ignored。
      const stageObs = stageEventFromHook(env, sessions);
      if (stageObs && prStages.add(stageObs.event, stageObs.dedupeKey)) notify();
      if (effect.kind === "ignored") return;
      // 总控开的子 session 等这个信号才交任务（信任文件夹之类的启动对话框已经过去）。
      // 终端按 BUTLER_SESSION 记：--resume 有时换 session id，唤醒（WS-M B）和交任务等的都是终端的 id。
      if (effect.kind === "session_started") pty.markStarted(env.butlerSession ?? effect.sessionId);
      // claude 收下了一条输入（UserPromptSubmit）：deliver 回车以后等的就是它（BTL-190 第 9 点）。终端按 BUTLER_SESSION 记，
      // /clear 以后 hook 里的 session id 已经换了。
      // 同一个时机：用户在终端里回答了，这个 session 卡片上还没答的「待你决定」都算答过（换新、Butler 刚递回答时不算，BTL-190 第 2+3 点）。
      if (effect.kind === "waiting" && !effect.waiting) {
        pty.markSubmitted(env.butlerSession ?? effect.sessionId);
        procs?.terminalActive(env.butlerSession ?? effect.sessionId);
        inboxService.promptSubmitted(env.butlerSession ?? effect.sessionId);
        // 马上重读活动：实况窗口里它立刻算在干活（BTL-190 第 7 点）。
        void activityMonitor.promptSubmitted(env.butlerSession ?? effect.sessionId).catch((e: unknown) => logger("re-reading the activity on prompt submit failed", e));
      }
      // claude 停下来等输入了：有“对方已经合完”的通知就趁现在发（设计文档 2026-11-04：不打断忙着的 session）。
      // 同一个时机也递还没递出去的 CI 结论（先重读活动），并且马上查一次这个仓库的 PR 和 CI（刚停下的 session 常常刚 push）。
      // 终端重新打开（--resume）的 session 停在输入框等着（hook-events 记成 waiting）：和停下来一样，马上递卡片上答好的回答等。
      // 全新启动的也一样（hook-events 记成 waiting）：没人打过字就不会有 Stop，不在这里送的话，等着的回答和汇报要等到用户先说一句话。
      if ((effect.kind === "waiting" && effect.waiting) || (effect.kind === "session_started" && (effect.resumed === true || effect.fresh === true))) {
        sessionStopped(env.butlerSession ?? effect.sessionId);
      }
      notify();
      // 还没归属 ticket、又缺 cwd / 分支 / 首条提示的 session：触发一次发现（每个 session 每次运行最多一次）。
      if (effect.kind !== "nested") {
        const s = sessions.get(effect.sessionId);
        if (s && needsDiscovery(s, discoveryRequested)) {
          discoveryPending.add(s.id);
          scheduleDiscovery();
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
    windowShown: () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
    ownedFile: paths.procsOwned,
    pinned: (head) => sessions.head(head)?.pinned === true,
    restart: (head) => hibernator?.restart(head) ?? Promise.resolve(),
    onSample: (s) => hibernator?.onSample(s),
    sampleNeeded: () => memoryPressureOn(settings),
    log: logger,
    changed: notify,
  });
  const procServices = procs;
  // e2e（后台窗口模式下才算数）：BUTLER_HIBERNATE_AFTER_MS 把四种等待的分钟数都换成这么多毫秒，安静期也一起缩短。
  const hibernateAfterMs = BACKGROUND_WINDOWS ? Number(process.env.BUTLER_HIBERNATE_AFTER_MS) || 0 : 0;
  const butlerTerminals = () =>
    pty.openIds().flatMap((termId) => {
      const head = sessions.head(termId);
      return head && head.origin === "butler" ? [{ termId, head }] : [];
    });
  const scope = { ticketsOfFeature: (id: number) => tickets.listByFeature(id).map((t) => t.key), featuresOfEpic: (id: number) => features.listByEpic(id).map((f) => f.id) };
  const prPending = (key: string | null, ci: "pending" | "review"): boolean =>
    key != null &&
    prWatcher.statusOf(key).some((p) =>
      ci === "pending" ? (p.state === "open" || p.state === null) && p.ci === "pending" : p.state === "open" && p.ci !== "pending" && p.review !== "approved",
    );
  hibernator = new Hibernator({
    enabled: () => hibernateOn(settings),
    minutes: (state) => (hibernateAfterMs > 0 ? hibernateAfterMs / 60_000 : hibernateMinutes(settings, state)),
    endWatchers: () => hibernateEndWatchersOn(settings),
    pressureOn: () => memoryPressureOn(settings),
    pressureLine: () => memoryPressureFreePercent(settings),
    terminals: butlerTerminals,
    candidate: (t) => {
      const a = activityMonitor.get(t.head.id);
      const typed = pty.lastUserInputAt(t.termId);
      const terms = butlerTerminals();
      return {
        head: t.head, termId: t.termId, pinned: t.head.pinned === true,
        transcript: transcriptState(paths.claudeProjects, t.head.id),
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
  /** 按种类 --resume 一个休眠的 head（不 force：分支对不上就算唤醒失败，交给用户）。 */
  const openHibernated = async (head: Session): Promise<{ ok: true; termId: string } | { ok: false; reason: string }> => {
    const r = head.butler && head.ticketKey === null ? await sessionService.openButler({ sessionId: head.id })
      : head.ticketKey !== null ? await sessionService.open({ ticketKey: head.ticketKey, sessionId: head.id })
      : head.featureId !== null ? await sessionService.openFeature({ featureId: head.featureId, sessionId: head.id })
      : head.epicId !== null ? await sessionService.openEpic({ epicId: head.epicId, sessionId: head.id })
      : ({ ok: false, reason: "kind" } as const);
    return r.ok ? { ok: true, termId: r.termId } : { ok: false, reason: r.reason };
  };
  windowShownHook = () => procServices.windowShown();
  shutdownSessions = () => {
    hibernator?.stop();
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

  // EpicService 要用 FeatureService 归档 / 恢复 feature，FeatureService 又要通知 EpicService 补仓库：回调里才用到 epicService，构造时还不需要。
  const featureService = new FeatureService({
    features, tickets, epics, db, now: Date.now,
    onEpicChanged: (id) => void memory.syncEpic(id),
    onTicketArchived: (key) => {
      removeTicketMcpConfigs(paths.mcp, key);
      inboxService.dismissScope({ ticketKey: key });
    },
    onRepoAdded: (featureId, repoPath) => epicService.ensureFeatureRepo(featureId, repoPath),
    refreshBeforeArchive: (ids) => featureRunner.refreshBeforeArchive(ids),
    log: logger,
  });
  const epicService = new EpicService({
    epics, features, featureService, db, now: Date.now,
    onEpicChanged: (id) => void memory.syncEpic(id),
    onArchived: (id, featureIds) => {
      removeEpicMcpConfig(paths.mcp, id);
      for (const f of featureIds) removeFeatureMcpConfig(paths.mcp, f);
      // 归档了的 epic 和它下面的 feature：还未决的「待你决定」和汇报都收起来（BTL-190 第 2+3 点）。
      inboxService.dismissScope({ epicId: id });
      for (const f of featureIds) inboxService.dismissScope({ featureId: f });
      // 一起归档的 feature 逐个排队整理：第一个整理完之后没有新东西，后面的不再跑。
      for (const f of featureIds) digestArchivedFeature(f);
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
  const keepAwakeSwitch = keepAwake;
  registerIpc({
    keepAwake: keepAwakeSwitch,
    onArchived: (key) => {
      removeTicketMcpConfigs(paths.mcp, key);
      inboxService.dismissScope({ ticketKey: key });
    },
    // 快照里有给 agent 看的文字：换语言、改检查相关的设置都要重写。
    languageChanged: () => {
      applyLanguage();
      checkSnapshots.schedule();
    },
    settingChanged: (key) => {
      if (key === "checksEnabled" || key === "checksEditTimeoutSec" || key === "checksPushTimeoutSec" || key === "ticketPattern") checkSnapshots.schedule();
    },
    // 共享 MCP（WS-M H）：打开就启动 hub（之后开的 session 用它）；关掉时接着它的 session 退完了再停。
    sharedMcpChanged: () => {
      if (sharedMcpOn(settings)) {
        if (existsSync(bundledHubPath())) mcpHub.start();
      } else mcpHub.stopWhenIdle();
    },
    onFeatureArchived: (id) => {
      removeFeatureMcpConfig(paths.mcp, id);
      inboxService.dismissScope({ featureId: id });
      digestArchivedFeature(id);
    },
    recheckCleanup: (key) => cleanupIfMerged(cleanupDeps, handoffs, key),
    autostart,
    tickets, ticketService, featureService, epicService, sessionService, activity: activityMonitor, pty, health, followups, handoffs, settings, runner, featureRunner, scheduler, jobs, gateRepo,
    keys, terms, audit, memory,
    llmStatus: () => llmStatus({ settings, keys, audit, now: Date.now }),
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
    checks: {
      act: (a) => checksService.act(a),
      view: (scope) => checksService.view(scope),
      hits: (key) => checksService.hits(key),
      draft: (lessonId) => checkDrafter.draft(lessonId),
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
    ciResend: async (item) => {
      const r = await ciDelivery.resend(item);
      ciStuckChanged();
      return r;
    },
    prStages: new PrStagesService({
      tickets: { get: (key) => tickets.get(key), byFeature: (id) => tickets.listByFeature(id, { includeArchived: true }) },
      features: {
        byEpic: (epicId) => features.listByEpic(epicId, { includeArchived: true }),
        get: (id) => features.get(id),
      },
      stages: prStages,
      prs: ticketPrs,
      reports: (key) => inboxRepo.reportsForTicket(key),
      skillTrackingSince: () => skillTrackingSince(settings),
    }),
    // 允许的主机和 lessons 的 openSource 一样，只认 git remote 认出来的仓库（lessons_repos），不认 ticket_prs 自己的 slug。
    prOpen: (url) => openKnownPr(url, { prs: ticketPrs, trustedSlugs: () => lessonsRepo.repos().map((r) => r.slug), openExternal: (u) => shell.openExternal(u), log: logger }),
    prWatchList: () => tickets.list().flatMap((t) => prWatcher.statusOf(t.key)),
    terminalVisible: (id, v) => procServices.terminalVisible(id, v),
    terminalInput: (id) => procServices.terminalActive(id),
    memoryHistory: (since) => procServices.monitor.history(since),
    nowView: (merges) => {
      // 合并排队的等待者记的是 BUTLER_SESSION：换成 head 再对；「需要你」的理由一次取齐。
      const queued = new Set([...gateRepo.waitingSessionIds()].map((id) => sessions.head(id)?.id ?? id));
      const reasons = needsYou.reasons();
      return buildNowView({
        tickets: sessionService.ticketViews(),
        features: sessionService.featureViews(),
        epics: sessionService.epicViews(),
        // 休眠着的 Butler 总控照样算（WS-M B）。
        butler: ((b) => (b ? { ...b, termId: sessionService.termIdOf(b.id) } : null))(
          sessionService.runningButler() ?? hibernatedHeads().find((h) => h.butler && h.ticketKey === null) ?? null,
        ),
        activity: (id) => activityMonitor.get(id),
        needsYouReason: (id) => reasons.get(id) ?? null,
        prs: (key) => prWatcher.statusOf(key),
        mergeQueued: (id) => queued.has(id),
        refreshing: (id) => refresher.stepOf(id),
        merges,
        approvalText: M().nowApproval,
        decisions: inboxService.pendingDecisionViews(),
        recent: (id) => activityMonitor.recent(id),
        memory: activityMonitor.memoryLog(),
        notices: [
          ...buildNotices({
            availability: availability.view(),
            recentRuns: lessonRuns.recentFinished(20),
            routing: routing.attention(),
            sharedMcpError: sharedMcpOn(settings) && mcpHub.status().state === "failed" ? mcpHub.status().error : null,
          }),
          ...ciNotices(ciDelivery.undelivered(), (key) => tickets.get(key)?.title ?? null),
        ],
        sessionMemory: (id) => procServices.monitor.memoryOf(id),
        memorySnapshot: procServices.monitor.snapshot(),
        sharedMcp: sharedMcpOn(settings),
      });
    },
    rederive: (key) => {
      rederiveTicketStatus({ tickets, handoffs, followups, now: Date.now, linkedOpen, givenUpPrs }, key);
      // followup 完成 / 忽略 / 恢复：StateCore 里对应的条目跟着 forget / 重写。
      void memory.syncTicket(key);
    },
    detectTrackerTools,
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

  /** 进度页和总控 progress_overview 共用的聚合（ws-b）。 */
  const progressView = (filter: ProgressFilter): ProgressView => {
    const firstCommits = prStages.ticketsWith("first_commit");
    const live = tickets.list();
    return buildProgress({
      now: Date.now(),
      tickets: live,
      features: features.list().map((f) => ({ id: f.id, name: f.name, epicId: f.epicId })),
      epics: epics.list().map((e) => ({ id: e.id, name: e.name })),
      prs: live.flatMap((t) => prWatcher.statusOf(t.key)),
      summary: (id) => {
        const rec = featureHandoffs.latestValid(id);
        return { summary: rec?.payload?.summary ?? null, at: rec?.createdAt ?? null, prStatusAt: rec?.prStatusAt ?? null, stale: featureRunner.hasNewActivity(id) };
      },
      started: (key) => firstCommits.has(key) || sessions.listByTicket(key).length > 0,
    }, filter);
  };
  // 总控 session 开子 session 的请求（设计文档 2026-10-23 第二步）。
  const controlInbox = new ControlInbox({
    requestsDir: paths.controlRequests,
    resultsDir: paths.controlResults,
    handle: controlHandler({
      tickets, sessions, features, ticketService, sessionService, notify,
      epics, featureService, epicRows: (id) => sessionService.epicFeatureRows(id),
      epicHistory: (id) => epicHistory.list(id, EPIC_HISTORY_READ_ENTRIES),
      syncEpic: (id) => void memory.syncEpic(id),
      refreshEpic: (id, except) => featureRunner.refreshEpic(id, except),
      activity: (id) => activityMonitor.get(id),
      activityOutput: (id) => activityMonitor.output(id),
      refresher,
      lastReply: (id) => activityMonitor.lastReply(id),
      inbox: inboxService,
      // Butler 总控（BTL-190 第 5 点）的只读数据。
      butler: {
        epicViews: () => sessionService.epicViews(),
        featureRows: () => sessionService.featureRowsAll(),
        prs: () => tickets.list().flatMap((t) => prWatcher.statusOf(t.key)),
        openHeads: openButlerHeads,
        needsYou: (id) => needsYou.reasons().get(id) ?? null,
        inbox: inboxService,
        progress: progressView,
        summaries: {
          running: (id) => featureRunner.isRunning(id),
          stale: (id) => featureRunner.hasNewActivity(id),
          prStatusAt: (id) => featureHandoffs.latestValid(id)?.prStatusAt ?? null,
          // 和 feature 页的"立即更新"一样：后台跑，完成后刷新界面。
          refresh: (id) => void featureRunner.runManual(id).then(notify, (e: unknown) => logger(`control: refreshing the summary of feature ${id} failed`, e)),
        },
        messages: butlerMessages,
      },
      // 和界面上点 × 一样（IPC pty:kill）：只关终端，session 留在列表里。
      kill: (termId) => pty.kill(termId),
      endHibernated: (id) => {
        const h = sessions.get(id);
        hibernator?.forget(id, "ended by end_session");
        if (h?.waitingForInput) sessions.setWaiting(id, false, h.lastActivityAt ?? 0);
        notify();
      },
      screenNeedsUser: (termId) => pty.screenNeedsUser(termId),
      submit: submitTask,
      // start_feature 给已经在跑的 feature 总控补充说明（BTL-190 第 4 点）：和递汇报同一道 guard。
      guard: deliveryGuard,
      deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
      memoryEnabled: () => memoryOn(settings),
      ticketPattern: () => settings.get("ticketPattern"),
      sessionModel: (m) => routing.sessionModel(m),
      log: logger,
    }),
    log: logger,
  });

  win = createWindow();
  tray = createTray();
  inbox.start();
  controlInbox.start();
  gateInbox.start();
  // hook 看到 alive.json（并且 pid 还活着）才来问；写不了就当 Butler 没开着，hook 一律放行。
  try {
    writeFileSync(paths.gateAlive, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  } catch (e) {
    logger("merge gate: could not write alive.json; merges are not checked", e);
  }
  holdWatcher.start(Number(process.env.BUTLER_GATE_CHECK_MS) || HOLD_CHECK_MS);
  // 等 git 和 gh 的路径按登录 shell 的 PATH 解析好再查：第一轮就可能看到合并、触发 worktree 清理。已经开始退出就不再启动。
  void healthReady.then(() => {
    if (headlessAbort.signal.aborted) return;
    prWatcher.start();
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
      if (!headlessAbort.signal.aborted) lessonRunner.start();
    })
    .catch((e: unknown) => logger("lessons: starting the runner failed", e));
  activityMonitor.start();
  procServices.start();
  usageScanner.start(usageScanMs(process.env));
  void runDiscovery();
  // 启动时补齐记忆：老数据、上次退出时没写完的。
  void memory.syncAll();
  const discoveryTimer = setInterval(() => void runDiscovery(), DISCOVERY_INTERVAL_MS);
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
    void butlerMessages.flush();
  }, activityIntervals(process.env).tickMs);

  // 调度：启动（health 探测完成后）、唤醒、解锁时检查到期任务；每分钟 tick，覆盖 16:00 和整晚没锁屏的情况。
  void healthReady.then(() => checkSchedule("startup"));
  powerMonitor.on("resume", () => {
    // 睡着的时间不算闲置（BTL-190 第 8 点）：不然一开盖子所有 session 一起被关。
    sessionCleanup.resumed();
    void checkSchedule("resume");
  });
  powerMonitor.on("unlock-screen", () => void checkSchedule("unlock"));
  // macOS / Linux 关机：和 Windows 的 session-end 一样，不再拦着关窗口。
  powerMonitor.on("shutdown", () => quitState.requestQuit());
  // 合上盖子（进入睡眠）时关掉防休眠，醒来后保持关闭，要用再手动打开。
  powerMonitor.on("suspend", () => keepAwakeSwitch.set(false));
  // 共享 MCP 开着就现在启动 hub，免得第一批 session 还在等它起来、先用了 stdio（WS-M H）。
  if (sharedMcpOn(settings) && existsSync(bundledHubPath())) mcpHub.start();
  const scheduleTimer = setInterval(() => void checkSchedule("tick"), TICK_MS);

  app.on("will-quit", () => {
    // 正常情况下 before-quit 已经停过；没经过 before-quit 的退出也要在关数据库之前停下。
    refresher.stop();
    hibernator?.stop();
    mcpHub.stop();
    clearInterval(discoveryTimer);
    clearInterval(refreshTimer);
    clearInterval(scheduleTimer);
    availability.dispose();
    lessonsGate.dispose();
    routing.dispose();
    clearInterval(upgradeTimer);
    if (hookDiscoveryTimer) clearTimeout(hookDiscoveryTimer);
    activityMonitor.stop();
    void procServices.stop();
    usageScanner.stop();
    memory.stop();
    inbox.stop();
    controlInbox.stop();
    // 先删 alive.json：之后的 hook 不再等一个要退出的 Butler。
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
    pty.killAll();
    keepAwakeSwitch.set(false);
    tray?.destroy();
    closing = true;
    db.close();
  });
}

process.on("uncaughtException", (e) => logger("uncaughtException", e));
process.on("unhandledRejection", (e) => logger("unhandledRejection", e));

if (process.argv.includes("--smoke")) {
  void runSmoke()
    .then((code) => app.exit(code))
    .catch(() => app.exit(1));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
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
      // 数据比程序新：给一句能看懂的话，不贴调用栈。
      const text = e instanceof NewerDatabaseError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
      dialog.showErrorBox(M().startupFailed, text);
      app.exit(1);
    });
}
