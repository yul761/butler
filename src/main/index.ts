import { app, BrowserWindow, dialog, Menu, nativeImage, powerMonitor, powerSaveBlocker, Tray } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeTask } from "../shared/control";
import { parseGateRequest, type GateRequest, type GateResult } from "../shared/gate";
import { IPC } from "../shared/ipc";
import type { Session } from "../shared/types";
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
import { PrWatchRepo } from "./db/pr-watch-repo";
import { SecretsRepo } from "./db/secrets-repo";
import { SessionsRepo } from "./db/sessions-repo";
import { SettingsRepo } from "./db/settings-repo";
import { TermsRepo } from "./db/terms-repo";
import { TicketsRepo } from "./db/tickets-repo";
import { UsageRepo } from "./db/usage-repo";
import { jobOf } from "./handoff/headless-exec";
import type { UsageCounts } from "./usage/usage-parse";
import { UsageScanner, usageScanMs } from "./usage/usage-scanner";
import { HoldWatcher } from "./gate/hold-watcher";
import { HOLD_CHECK_MS, MergeGate } from "./gate/merge-gate";
import { CiDelivery } from "./prwatch/ci-delivery";
import { prHandoff } from "./prwatch/pr-handoff";
import { watchTargets } from "./prwatch/pr-targets";
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
import { EpicHistoryRepo } from "./db/epic-history-repo";
import { EpicsRepo } from "./db/epics-repo";
import { EpicDigestRunner } from "./epics/epic-digest";
import { EPIC_HISTORY_READ_ENTRIES } from "./epics/epic-history-view";
import { EpicService } from "./epics/epic-service";
import { FeaturesRepo } from "./db/features-repo";
import { currentLang, onLangChange, setLang } from "./i18n";
import { writeSessionGuide } from "./claude/session-guide";
import { resolveLang } from "../shared/i18n";
import { FeatureService } from "./tickets/feature-service";
import { HandoffRunner } from "./handoff/runner";
import { hookCommand } from "./hooks/installer";
import { HealthService } from "./hooks/health";
import { applyHookEnvelope } from "./hooks/hook-events";
import { createFileLogger, type Logger } from "./logger";
import { memoryServers, removeEpicMcpConfig, removeFeatureMcpConfig, removeTicketMcpConfigs, SESSIONS_AUTO_ALLOW, sessionsServer, writeButlerMcpConfig, writeEpicMcpConfig, writeFeatureMcpConfig, writeTicketMcpConfig } from "./memory/mcp-config";
import { MemoryService, nightlyDistill } from "./memory/memory-service";
import { controlHandler } from "./control/control-handler";
import { ControlInbox } from "./control/control-inbox";
import { HookInbox } from "./hooks/inbox";
import { InboxRepo } from "./db/inbox-repo";
import { InboxService } from "./inbox/inbox-service";
import { registerIpc } from "./ipc/register";
import { ensureDirs, refreshTailPath, resolvePaths } from "./paths";
import { isWorkingDay, localDate } from "./schedule/calendar";
import { BackgroundRunner, morningJob, nightlyJob, type DailyJobDeps } from "./schedule/daily-jobs";
import { ButlerPatrol } from "./schedule/butler-patrol";
import { Scheduler, TICK_MS, type ScheduleTrigger } from "./schedule/scheduler";
import { ActivityMonitor, activityIntervals } from "./sessions/activity-monitor";
import { sessionRegistryName } from "./sessions/activity-sources";
import { DeliveryGuard, type DeliveryGuardDeps } from "./sessions/delivery-guard";
import { writeRefreshTail } from "./sessions/refresh-tail";
import { autoRefreshNeedsYou, refreshKindOf, SessionRefresher, startRefresh } from "./sessions/session-refresher";
import { SessionCleanup } from "./sessions/session-cleanup";
import { findTranscript, needsDiscovery, scanClaudeProjects, syncDiscovered, transcriptState, UNCLAIMED_WINDOW_MS, type HeadCache } from "./sessions/discovery";
import { PtyManager } from "./sessions/pty-manager";
import { nodePtyFactory } from "./sessions/pty-node";
import { SessionService } from "./sessions/session-service";
import { judgeStuck } from "./sessions/stuck-judge";
import { deliveryNeedsYou, judgeNeedsYou, NeedsYouTracker, type NeedsYouHead } from "./sessions/needs-you";
import { buildNowView } from "./now/now-view";
import { idleCloseMinutes, llmConfig, memoryOn, refreshThreshold, scheduleConfig, SettingError, trackerTools } from "./settings/settings-values";
import { runSmoke } from "./smoke";
import { M } from "./strings";
import { pathKey } from "./util/env";
import { resolveGh } from "./util/gh-path";
import { applyGitResolution, resolveGit } from "./util/git-path";
import { TicketService } from "./tickets/ticket-service";
import { applyGhResolution, branchRuns, failedLog, prInfo, prStatus } from "./tickets/gh";
import type { HeadlessExecDeps } from "./handoff/headless-exec";
import * as git from "./tickets/git";
import { canSend } from "./safe-send";
import { createQuitState } from "./quit-state";
import { KeepAwake } from "./keep-awake";
import { TRAY_ICONS } from "./tray-icons";
import { CSP_VIOLATION_LOG_PREFIX, isCspViolationMessage } from "./csp-log";

const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** hook 发现没有 ticket 的 session 后，稍等片刻再扫描磁盘（合并连续事件）。 */
const HOOK_DISCOVERY_DEBOUNCE_MS = 3000;
/** 系统空闲超过这么多秒就不算“正在用电脑”（用于 tick 触发早间任务）。 */
const ACTIVE_IDLE_SECONDS = 120;

let win: BrowserWindow | null = null;
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
  const health = new HealthService({ paths, platform: process.platform, env: process.env, settings, bundledHookBin: bundledHookPath(), memoryMcpScript: bundledMemoryMcpPath(), log: logger });
  const notify = () => safeSend(IPC.stateChanged);
  // 健康探测可能很慢（登录 shell、claude --version）：后台进行，窗口先出来。
  // 同时把升级后还是旧版本的 butler-hook 换成新的（最终审查 1）：打开 session 要等 healthReady，gate 开不开在那之前就定了。syncHookBinary 不抛错。
  // Butler 旧版本装的 /handoff 也先换成当前版本再探测（C1），健康页报告的是换完的状态。syncHandoffCommand 不抛错。
  const healthReady: Promise<void> = Promise.all([health.syncHandoffCommand().then(() => health.refresh()), health.syncHookBinary()]).then(
    () => {
      applyGitResolution(resolveGit(health.claude().pathValue, process.platform), process.platform, (m) => logger(m));
      applyGhResolution(resolveGh(health.claude().pathValue, process.platform), process.platform, (m) => logger(m));
      notify();
    },
    (e: unknown) => {
      logger("initial health refresh failed", e);
    },
  );
  const usageRepo = new UsageRepo(db);
  /** 某个 session（取 head）最近一轮的上下文大小：计划 16 的自动换新看它。 */
  const contextOf = (sessionId: string): number | null => usageRepo.latestContext(sessions.head(sessionId)?.id ?? sessionId);
  /** headless 运行（handoff、feature 汇总、卡住判断）的用量入库。 */
  const recordHeadlessUsage = ({ runId, label, at, model, usage }: { runId: string; label: string; at: number; model: string | null; usage: UsageCounts }) => {
    try {
      usageRepo.record([{
        messageId: `headless:${runId}`, sessionId: null, agentId: null, source: "headless", job: jobOf(label), at, model, ...usage,
        context: usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead,
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
  const pty = new PtyManager(nodePtyFactory, {
    data: (id, data) => safeSend(IPC.ptyData, id, data),
    exit: (id, code) => {
      safeSend(IPC.ptyExit, id, code);
      if (closing) return;
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
    return servers;
  };
  /** 每次打开 session 时重写这个 ticket 的 --mcp-config 文件（设计文档 4.2、8.4）。什么都不挂时返回 null。 */
  const memoryMcpConfig = (ticketKey: string, opts: { coordinator: boolean; featureId: number | null; epicId: number | null }): string | null => {
    const servers = mcpServers({ ticketKey, featureId: opts.featureId, epicId: opts.epicId }, opts.coordinator ? { ticketKey } : { ticketKey, member: true });
    if (Object.keys(servers).length === 0) return null;
    return writeTicketMcpConfig({ mcpDir: paths.mcp, ticketKey, servers, coordinator: opts.coordinator });
  };
  /** feature 总控：feature 记忆、全局记忆和 feature 模式的 butler-sessions；feature 属于 epic 时加 epic 记忆。 */
  const featureMcpConfig = (featureId: number, epicId: number | null): string | null => {
    const servers = mcpServers({ featureId, epicId }, { featureId, epic: epicId !== null });
    if (Object.keys(servers).length === 0) return null;
    return writeFeatureMcpConfig({ mcpDir: paths.mcp, featureId, servers });
  };
  /** epic session：epic 记忆、全局记忆和 epic 模式的 butler-sessions（list_features、list_repos、create_feature，以及各 feature 的 session）。 */
  const epicMcpConfig = (epicId: number): string | null => {
    const servers = mcpServers({ epicId }, { epicId });
    if (Object.keys(servers).length === 0) return null;
    return writeEpicMcpConfig({ mcpDir: paths.mcp, epicId, servers });
  };
  /** Butler 总控（BTL-190 第 5 点）：只有全局记忆（butler-workspace）和 Butler 模式的 butler-sessions。 */
  const butlerMcpConfig = (): string | null => {
    const servers = mcpServers({}, { butler: true });
    if (Object.keys(servers).length === 0) return null;
    return writeButlerMcpConfig({ mcpDir: paths.mcp, servers });
  };
  /** 卡住判断和「需要你」判断共用的 headless 设置。 */
  const judgeDeps: HeadlessExecDeps = {
    run: runHeadless, ready: () => healthReady, claude: () => health.claude(), baseEnv: process.env, sessions, now: Date.now, newRunId: randomUUID,
    signal: headlessAbort.signal, onUsage: recordHeadlessUsage, log: logger,
  };
  /** 开着终端的 Butler session 的 head（同一个 head 只算一次），带上活动和最后一条回复。activityMonitor 在下面才建好：调用时才用到。 */
  const needsYouHeads = (): NeedsYouHead[] => {
    const heads = new Map<string, NeedsYouHead>();
    for (const termId of pty.openIds()) {
      const h = sessions.head(termId);
      if (!h || h.origin !== "butler" || heads.has(h.id)) continue;
      heads.set(h.id, { id: h.id, cwd: h.cwd, waiting: h.waitingForInput, kind: activityMonitor.get(h.id)?.kind ?? null, reply: activityMonitor.lastReplyOf(h.id) });
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
    log: logger,
  });
  /** 把任务作为第一条消息交给新 session：总控开的子 session 和修复 session 都走这里。 */
  const submitTask = (termId: string, message: string) => pty.deliver(termId, message, { singleLine: process.platform === "win32" });
  const sessionService = new SessionService({
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
    mcpSettings: (dirs) => projectMcpApprovalSettings(dirs, { claudeJson: paths.claudeJson, claudeSettings: paths.claudeSettings, mcpDir: paths.mcp, log: logger, allowTools: SESSIONS_AUTO_ALLOW, gateCommand: health.hookBinCurrent() && existsSync(paths.hookBin) ? hookCommand(paths.hookBin, process.platform) : undefined }),
    guidePath: (kind) => writeSessionGuide(paths.mcp, currentLang(), kind),
    featureMcpConfig,
    epicMcpConfig,
    butlerWorkspace: paths.butlerWorkspace,
    butlerMcpConfig,
    features, epics, featureHandoffs, handoffs, epicHistory,
    // 打开 session 时补同步这个 ticket（最终审查 6）：上次同步失败、或记忆刚打开过，claude 不会读到旧的记忆。走同步队列，失败只写日志。
    syncMemory: (key) => void memory.syncTicket(key),
    log: logger,
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
    const r = ingestHandoff({ db, tickets, handoffs, followups, now: Date.now, newFollowupId: () => `f_${randomBytes(4).toString("hex")}` }, input);
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
    now: Date.now,
    newRunId: randomUUID,
    projectMcp,
    signal: headlessAbort.signal,
    onUsage: recordHeadlessUsage,
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
  const inboxService: InboxService = new InboxService({
    repo: new InboxRepo(db),
    head: (id) => sessions.head(id),
    ticket: (key) => tickets.get(key),
    epicOfFeature: (id) => features.get(id)?.epicId ?? null,
    epicName: (id) => epics.get(id)?.name ?? null,
    termOf: gateTerm,
    openHeads: openButlerHeads,
    answerGuard: new DeliveryGuard({ ...guardDeps, refreshing: (id) => refresher.isRefreshing(id) }),
    reportGuard: deliveryGuard,
    deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
    // 换新输入的 /handoff 和接着做的话也会触发 UserPromptSubmit：那不是用户在终端里回答。
    refreshing: (id) => refresher.isRefreshing(id),
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
      return key != null && prWatcher.statusOf(key).some((p) => p.ci === "pending");
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
  const prWatchRepo = new PrWatchRepo(db);
  const holdWatcher = new HoldWatcher({
    repo: gateRepo, prInfo, git,
    isOpen: (id) => gateTerm(id) !== null,
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
  // CI 的结论递给这个仓库自己的 session（不算总控）：和合并通知走同一道 guard，最多等 1 分钟。
  const ciDelivery = new CiDelivery({
    repo: prWatchRepo,
    guard: deliveryGuard,
    sessionFor: (key, repoId) => {
      for (const t of pty.openIds()) {
        const h = sessions.head(t);
        if (h && h.ticketKey === key && h.repoId === repoId && !h.coordinator) return h.id;
      }
      return null;
    },
    deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
    now: Date.now,
    log: logger,
  });
  /** 递还没递出去的 CI 结论（永不 reject）。 */
  const flushCi = (): Promise<void> => ciDelivery.flush().catch((e: unknown) => logger("ci delivery: flush failed", e));
  const prWatcher = new PrWatcher({
    repo: prWatchRepo,
    targets: () =>
      watchTargets(tickets.list(), {
        workDir: (r) => ticketService.workDir(r),
        sessionOpen: (key, repoId) => sessionService.hasRepoTerminal(key, repoId),
        watched: (repoId) => prWatchRepo.get(repoId),
        handoffHasOpenPr: (key) => handoffs.latestValid(key)?.payload?.prs.some((p) => p.state === "open") ?? false,
      }),
    gh: { prStatus, branchRuns, failedLog },
    // PR 的状态或 review 变了：在最新的 handoff 上换掉 prs，存成一条 refresh。ticket 状态、PR 标签、合并后清理 worktree 都照旧走 ingest。
    onPrChanged: (key) => {
      const base = handoffs.latestValid(key);
      if (!base?.payload) return;
      const next = prHandoff(key, prWatchRepo.byTicket(key), { id: base.id, prs: base.payload.prs });
      if (!next) return;
      // 和早间刷新一样：done_today、followups、decisions、learnings 清空，免得重复计算、重复写进记忆。
      ingest({
        ticketKey: key, sessionId: null, trigger: "refresh",
        payload: { ...base.payload, done_today: [], followups: [], decisions: [], learnings: [], prs: next.prs },
        rawText: null, sourceRef: next.sourceRef,
      });
    },
    onCiSettled: (row) => void ciDelivery.settled(row).catch((e: unknown) => logger("ci delivery: handing over a CI result failed", e)),
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
      if (effect.kind === "ignored") return;
      // 总控开的子 session 等这个信号才交任务（信任文件夹之类的启动对话框已经过去）。
      if (effect.kind === "session_started") pty.markStarted(effect.sessionId);
      // claude 收下了一条输入（UserPromptSubmit）：deliver 回车以后等的就是它（BTL-190 第 9 点）。终端按 BUTLER_SESSION 记，
      // /clear 以后 hook 里的 session id 已经换了。
      // 同一个时机：用户在终端里回答了，这个 session 卡片上还没答的「待你决定」都算答过（换新、Butler 刚递回答时不算，BTL-190 第 2+3 点）。
      if (effect.kind === "waiting" && !effect.waiting) {
        pty.markSubmitted(env.butlerSession ?? effect.sessionId);
        inboxService.promptSubmitted(env.butlerSession ?? effect.sessionId);
        // 马上重读活动：实况窗口里它立刻算在干活（BTL-190 第 7 点）。
        void activityMonitor.promptSubmitted(env.butlerSession ?? effect.sessionId).catch((e: unknown) => logger("re-reading the activity on prompt submit failed", e));
      }
      // claude 停下来等输入了：有“对方已经合完”的通知就趁现在发（设计文档 2026-11-04：不打断忙着的 session）。
      // 同一个时机也递还没递出去的 CI 结论（先重读活动），并且马上查一次这个仓库的 PR 和 CI（刚停下的 session 常常刚 push）。
      // 终端重新打开（--resume）的 session 停在输入框等着（hook-events 记成 waiting）：和停下来一样，马上递卡片上答好的回答等。
      if ((effect.kind === "waiting" && effect.waiting) || (effect.kind === "session_started" && effect.resumed === true)) {
        const stopped = env.butlerSession ?? effect.sessionId;
        void holdWatcher.sessionIdle(stopped);
        // 活动没变时 activityMonitor 不会 notify：停下来以后的「需要你」判断在这里补一次。
        void refreshActivityOf(stopped)
          .catch((e: unknown) => logger(`ci delivery: re-reading the activity of ${stopped} failed`, e))
          .then(() => {
            needsYou.update();
            // 卡片上答好的回答、该送给总控的汇报也趁现在送（永不 reject）。
            void inboxService.flush();
            // 在等 Butler 总控停下来的巡检也趁现在送（BTL-190 第 5 点，永不 reject）。
            if (!headlessAbort.signal.aborted) void butlerPatrol.check();
            return flushCi();
          });
        const repoId = sessions.head(stopped)?.repoId;
        if (repoId != null) prWatcher.soon(repoId);
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
  shutdownSessions = () => {
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
    languageChanged: applyLanguage,
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
    inbox: inboxService,
    prWatchList: () => tickets.list().flatMap((t) => prWatcher.statusOf(t.key)),
    nowView: (merges) => {
      // 合并排队的等待者记的是 BUTLER_SESSION：换成 head 再对；「需要你」的理由一次取齐。
      const queued = new Set([...gateRepo.waitingSessionIds()].map((id) => sessions.head(id)?.id ?? id));
      const reasons = needsYou.reasons();
      return buildNowView({
        tickets: sessionService.ticketViews(),
        features: sessionService.featureViews(),
        epics: sessionService.epicViews(),
        butler: ((b) => (b ? { ...b, termId: sessionService.termIdOf(b.id) } : null))(sessionService.runningButler()),
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
      });
    },
    rederive: (key) => {
      rederiveTicketStatus({ tickets, handoffs, followups, now: Date.now }, key);
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
      },
      // 和界面上点 × 一样（IPC pty:kill）：只关终端，session 留在列表里。
      kill: (termId) => pty.kill(termId),
      screenNeedsUser: (termId) => pty.screenNeedsUser(termId),
      submit: submitTask,
      // start_feature 给已经在跑的 feature 总控补充说明（BTL-190 第 4 点）：和递汇报同一道 guard。
      guard: deliveryGuard,
      deliver: (termId, text, recheck) => pty.deliver(termId, text, { singleLine: process.platform === "win32", timeoutMs: 60_000, recheck }),
      memoryEnabled: () => memoryOn(settings),
      ticketPattern: () => settings.get("ticketPattern"),
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
    if (!headlessAbort.signal.aborted) prWatcher.start();
  });
  activityMonitor.start();
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
    // 等着送的回答和汇报：Stop 那一刻没送成（用户在打字、有草稿）的，按这个节奏再试。
    void inboxService.flush();
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
  const scheduleTimer = setInterval(() => void checkSchedule("tick"), TICK_MS);

  app.on("will-quit", () => {
    // 正常情况下 before-quit 已经停过；没经过 before-quit 的退出也要在关数据库之前停下。
    refresher.stop();
    clearInterval(discoveryTimer);
    clearInterval(refreshTimer);
    clearInterval(scheduleTimer);
    if (hookDiscoveryTimer) clearTimeout(hookDiscoveryTimer);
    activityMonitor.stop();
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
