import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, powerMonitor, Tray, type MessageBoxOptions } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Brief } from "../shared/brief";
import { IPC } from "../shared/ipc";
import { APP_ID, shouldSetAppId } from "./app-id";
import { BriefService } from "./brief/brief-service";
import { narrateBrief } from "./brief/narrate";
import { runHeadless } from "./claude/headless";
import { probeMcpTools } from "./claude/mcp-probe";
import { projectMcpConfigs } from "./claude/project-mcp";
import { headlessEnv } from "./claude/spawn";
import { AuditRepo } from "./db/audit-repo";
import { BriefsRepo } from "./db/briefs-repo";
import { NewerDatabaseError, openDatabase } from "./db/database";
import { FollowupsRepo } from "./db/followups-repo";
import { HandoffsRepo } from "./db/handoffs-repo";
import { JobsRepo } from "./db/jobs-repo";
import { MarksRepo } from "./db/marks-repo";
import { MemorySyncRepo } from "./db/memory-sync-repo";
import { SecretsRepo } from "./db/secrets-repo";
import { SessionsRepo } from "./db/sessions-repo";
import { SettingsRepo } from "./db/settings-repo";
import { TermsRepo } from "./db/terms-repo";
import { TicketsRepo } from "./db/tickets-repo";
import { auditCutoff, stalePendingCost } from "./gateway/budget";
import { PrivacyGateway } from "./gateway/gateway";
import { KeyStore } from "./gateway/key-store";
import { autostartState } from "./autostart";
import { electronSecretBox } from "./gateway/safe-storage";
import { llmStatus } from "./gateway/status";
import { captureCommandHandoff, stopFromEnvelope } from "./handoff/capture";
import { ingestHandoff, rederiveTicketStatus, type IngestInput } from "./handoff/ingest";
import { HandoffRunner } from "./handoff/runner";
import { HealthService } from "./hooks/health";
import { applyHookEnvelope } from "./hooks/hook-events";
import { createFileLogger, type Logger } from "./logger";
import { memoryServers, removeTicketMcpConfigs, sessionsServer, writeTicketMcpConfig } from "./memory/mcp-config";
import { MemoryService, nightlyDistill } from "./memory/memory-service";
import { controlHandler } from "./control/control-handler";
import { ControlInbox } from "./control/control-inbox";
import { HookInbox } from "./hooks/inbox";
import { registerIpc } from "./ipc/register";
import { ensureDirs, resolvePaths } from "./paths";
import { isWorkingDay, localDate } from "./schedule/calendar";
import { BackgroundRunner, morningJob, nightlyJob, type DailyJobDeps } from "./schedule/daily-jobs";
import { Scheduler, TICK_MS, type ScheduleTrigger } from "./schedule/scheduler";
import { findTranscript, needsDiscovery, scanClaudeProjects, syncDiscovered, transcriptState, UNCLAIMED_WINDOW_MS, type HeadCache } from "./sessions/discovery";
import { PtyManager } from "./sessions/pty-manager";
import { nodePtyFactory } from "./sessions/pty-node";
import { SessionService } from "./sessions/session-service";
import { llmConfig, memoryOn, scheduleConfig, SettingError } from "./settings/settings-values";
import { runSmoke } from "./smoke";
import { N } from "./strings";
import { pathKey } from "./util/env";
import { applyGitResolution, resolveGit } from "./util/git-path";
import { TicketService } from "./tickets/ticket-service";
import { canSend } from "./safe-send";
import { createQuitState } from "./quit-state";
import { TRAY_ICONS } from "./tray-icons";
import { CSP_VIOLATION_LOG_PREFIX, isCspViolationMessage } from "./csp-log";

const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** hook 发现没有 ticket 的 session 后，稍等片刻再扫描磁盘（合并连续事件）。 */
const HOOK_DISCOVERY_DEBOUNCE_MS = 3000;
/** 系统空闲超过这么多秒就不算“正在用电脑”（用于 tick 触发早间简报）。 */
const ACTIVE_IDLE_SECONDS = 120;
/** 发送前确认最多等这么久，超时视为拒绝：早间任务串行执行，对话框一直开着会挡住后面的任务。 */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 保留最近一条通知的引用，否则它可能在用户点击前被回收。 */
let lastNotification: Notification | null = null;
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
  w.on("ready-to-show", () => w.show());
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
  t.setToolTip("Butler");
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Butler", click: showWindow },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  t.on("click", showWindow);
  return t;
}

function showEveningNotification(brief: Brief): void {
  if (!Notification.isSupported()) return;
  lastNotification?.close();
  const n = new Notification({ title: N.eveningTitle, body: N.eveningBody(brief.evening.length) });
  n.on("click", () => {
    showWindow();
    safeSend(IPC.appNavigate, { page: "home", kind: "evening" });
  });
  n.show();
  lastNotification = n;
}

/**
 * 发送前确认（设计文档 7.6）：展示完整的出站内容，默认按钮和取消都是“不发送”。
 * 把主窗口带到前台并作为父窗口；没有主窗口时视为拒绝。最多等 CONFIRM_TIMEOUT_MS，超时视为拒绝；
 * app 正在退出时立即返回 false，对话框打开中开始退出也会被关掉，不会挡住退出。
 */
async function confirmSend(outbound: string, quit: AbortSignal): Promise<boolean> {
  if (quitState.quitting || quit.aborted) return false;
  const signal = AbortSignal.any([AbortSignal.timeout(CONFIRM_TIMEOUT_MS), quit]);
  const options: MessageBoxOptions = {
    type: "question",
    buttons: [N.confirmSend, N.confirmCancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: N.confirmTitle,
    message: N.confirmMessage,
    detail: outbound,
    signal,
  };
  // 没有主窗口时（窗口还没建好、或正在退出）直接视为拒绝：macOS 上无父窗口的对话框不响应 abort，
  // 超时和退出都关不掉它（Electron 44 实测），会一直挡着。
  const w = win && !win.isDestroyed() ? win : null;
  if (!w) {
    logger("confirm-before-send: no main window, treated as declined");
    return false;
  }
  showWindow();
  const r = await dialog.showMessageBox(w, options);
  // 被超时或退出关掉的对话框一律当作拒绝。
  return r.response === 0 && !signal.aborted;
}

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();
  await ensureDirs(paths);
  logger = createFileLogger(join(paths.logs, "main.log"), undefined, app.isPackaged ? undefined : teeToConsole);
  if (!app.isPackaged) process.stderr.on("error", () => { teeBroken = true; });
  // 先用 Butler 自己的 PATH 定下 git 的绝对路径；登录 shell 的 PATH 读到之后再更新一次。
  applyGitResolution(resolveGit(process.env[pathKey(process.env)] ?? "", process.platform), process.platform, (m) => logger(m));
  const db = openDatabase(paths.db);
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const settings = new SettingsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const jobs = new JobsRepo(db);
  const memory = new MemoryService({
    dataDir: paths.statecore,
    tickets,
    handoffs,
    followups,
    sync: new MemorySyncRepo(db),
    enabled: () => memoryOn(settings),
    now: Date.now,
    // 记忆标签开着时能看到新写入的内容：只发记忆专用的事件，标签不跟着每次 stateChanged 重新打开 StateCore（最终审查 4）。
    onSynced: (key) => safeSend(IPC.memoryChanged, key),
    log: logger,
  });
  const ticketService = new TicketService({ tickets, settings, now: Date.now, workspacesDir: paths.workspaces });
  const health = new HealthService({ paths, platform: process.platform, env: process.env, settings, bundledHookBin: bundledHookPath(), memoryMcpScript: bundledMemoryMcpPath() });
  const notify = () => safeSend(IPC.stateChanged);
  // 健康探测可能很慢（登录 shell、claude --version）：后台进行，窗口先出来。
  const healthReady: Promise<void> = health.refresh().then(
    () => {
      applyGitResolution(resolveGit(health.claude().pathValue, process.platform), process.platform, (m) => logger(m));
      notify();
    },
    (e: unknown) => {
      logger("initial health refresh failed", e);
    },
  );
  /** will-quit 关数据库之前置位：之后才到的终端退出事件（killAll 是异步的）不再碰数据库。没处理的空 session 下次启动时清掉。 */
  let closing = false;
  const pty = new PtyManager(nodePtyFactory, {
    data: (id, data) => safeSend(IPC.ptyData, id, data),
    exit: (id, code) => {
      safeSend(IPC.ptyExit, id, code);
      if (closing) return;
      try {
        sessionService.handleExit(id);
      } catch (e) {
        logger("handleExit failed", e);
      }
      notify();
    },
  }, Date.now, logger);
  const memoryMcpScript = bundledMemoryMcpPath();
  let memoryMcpMissingLogged = false;
  let sessionsMcpMissingLogged = false;
  /**
   * 每次打开 session 时重写这个 ticket 的 --mcp-config 文件（设计文档 4.2、8.4）：记忆开着时挂记忆 server；
   * 总控 session 另外挂 butler-sessions（设计文档 2026-10-23 第二步），和记忆开关无关。什么都不挂时返回 null。
   */
  const memoryMcpConfig = (ticketKey: string, opts: { coordinator: boolean }): string | null => {
    const launcher = (script: string) => ({ command: process.execPath, script });
    let servers = {};
    if (memoryOn(settings)) {
      if (existsSync(memoryMcpScript)) servers = memoryServers({ launcher: launcher(memoryMcpScript), statecoreDir: paths.statecore, ticketKey });
      else if (!memoryMcpMissingLogged) {
        logger(`memory MCP bundle missing at ${memoryMcpScript}; sessions start without memory (run pnpm build:memory-mcp)`);
        memoryMcpMissingLogged = true;
      }
    }
    if (opts.coordinator) {
      const script = bundledSessionsMcpPath();
      if (existsSync(script)) {
        servers = { ...servers, ...sessionsServer({ launcher: launcher(script), ticketKey, requestsDir: paths.controlRequests, resultsDir: paths.controlResults }) };
      } else if (!sessionsMcpMissingLogged) {
        logger(`sessions MCP bundle missing at ${script}; the coordinator cannot start sessions (run pnpm build:memory-mcp)`);
        sessionsMcpMissingLogged = true;
      }
    }
    if (Object.keys(servers).length === 0) return null;
    return writeTicketMcpConfig({ mcpDir: paths.mcp, ticketKey, servers, coordinator: opts.coordinator });
  };
  const sessionService = new SessionService({
    tickets, sessions, settings, ticketService, pty,
    ready: () => healthReady,
    transcriptExists: (id) => transcriptState(paths.claudeProjects, id) !== "absent",
    transcriptState: (id) => transcriptState(paths.claudeProjects, id),
    claude: () => health.claude(),
    newId: randomUUID,
    now: Date.now,
    platform: process.platform,
    baseEnv: process.env,
    mcpConfig: memoryMcpConfig,
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
  const ingest = (input: IngestInput) => {
    const r = ingestHandoff({ db, tickets, handoffs, followups, now: Date.now, newFollowupId: () => `f_${randomBytes(4).toString("hex")}` }, input);
    // 设计文档 5.4：入库后同步写入 StateCore（异步，失败只记日志）。
    if (r.stored && !r.degraded) void memory.syncTicket(input.ticketKey);
    return r;
  };
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
    log: logger,
  });
  const briefs = new BriefsRepo(db);
  const briefService = new BriefService({
    tickets, sessions, handoffs, followups, marks: new MarksRepo(db), briefs, settings,
    now: Date.now, unclaimedCount: () => sessionService.unclaimed().length,
  });

  const audit = new AuditRepo(db);
  // 审计的启动收尾，先于一切读写审计的代码：上次退出时没发完的请求记为 failed（请求体保留，可能已经发出），
  // 再按保留期清理一次（不删本月的记录，预算要用；之后 gateway 每次调用前也会清理）。
  try {
    const stale = audit.failStalePending(N.auditStalePending, stalePendingCost(llmConfig(settings).prices));
    if (stale > 0) logger(`marked ${stale} audit row(s) left pending by the previous run as failed`);
    audit.prune(auditCutoff(Date.now(), llmConfig(settings).retentionDays));
  } catch (e) {
    logger("audit housekeeping at startup failed", e);
  }
  const terms = new TermsRepo(db);
  const keys = new KeyStore({ secrets: new SecretsRepo(db), box: electronSecretBox, now: Date.now, log: logger });
  const gateway = new PrivacyGateway({
    settings, audit, terms, keys, now: Date.now,
    confirm: (outbound) => confirmSend(outbound, headlessAbort.signal),
    log: logger,
  });
  let briefNarrating = false;

  let briefRefreshing = false;
  // 同时只跑一次蒸馏；退出时 headlessAbort 让 gateway 拒绝 / 中止调用，蒸馏在下一个 scope 之前停下。
  const distiller = new BackgroundRunner({
    name: "memory distill",
    run: (signal) => nightlyDistill({ memory, gateway, signal, log: logger }),
    signal: headlessAbort.signal,
    log: logger,
  });
  const dailyDeps: DailyJobDeps = {
    runner,
    briefs: briefService,
    jobs,
    now: Date.now,
    isWorkingDay: () => isWorkingDay(localDate(Date.now()), scheduleConfig(settings).workingDays),
    setRefreshing: (v) => {
      briefRefreshing = v;
      notify();
    },
    aborted: () => headlessAbort.signal.aborted,
    narrate: async (brief) => {
      briefNarrating = true;
      notify();
      try {
        await narrateBrief(
          {
            narrate: (src, signal) => gateway.narrate(src, signal),
            briefs,
            source: (b) => briefService.narrativeSource(b),
            off: () => gateway.isOff(),
            signal: headlessAbort.signal,
            log: logger,
          },
          brief,
        );
      } finally {
        briefNarrating = false;
        notify();
      }
    },
    // full 档位的记忆蒸馏：在后台跑，不挡调度链；每次运行都重新向 gateway 要模型（改档位不用重启），模型只经 withScope 交给嵌入式 StateCore。
    distill: () => distiller.start(),
    onEvening: (brief) => {
      // 退出开始后不再弹通知。
      if (headlessAbort.signal.aborted) return;
      notify();
      showEveningNotification(brief);
    },
  };
  const scheduler = new Scheduler({
    jobs,
    config: () => scheduleConfig(settings),
    now: Date.now,
    userActive: () => powerMonitor.getSystemIdleTime() < ACTIVE_IDLE_SECONDS,
    nightly: (slot) => nightlyJob(dailyDeps, slot),
    morning: () => morningJob(dailyDeps),
    onChange: notify,
    log: logger,
  });
  /** 退出开始后不再发起新的调度任务。 */
  const checkSchedule = (trigger: ScheduleTrigger) => (headlessAbort.signal.aborted ? Promise.resolve() : scheduler.check(trigger));

  const detectTrackerTools = async () => {
    await healthReady;
    const { path, pathValue } = health.claude();
    if (!path) throw new Error("找不到 claude 命令，请先在“环境检查”里确认 claude 路径");
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
      syncDiscovered(found, sessions, Date.now());
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

  const inbox = new HookInbox({
    dir: paths.inbox,
    badDir: paths.inboxBad,
    log: (m) => logger(m),
    handle: (env) => {
      const effect = applyHookEnvelope(env, {
        sessions, tickets, transcriptState: (id) => transcriptState(paths.claudeProjects, id),
        placement: (key, cwd) => ticketService.placement(key, cwd),
      });
      // Stop 之后看这一轮有没有 /handoff 的输出（异步；失败只记日志，不影响 hook 处理）。
      const stop = stopFromEnvelope(env);
      if (stop) {
        void captureCommandHandoff({ sessions, tickets, ingest }, stop).then(
          (r) => {
            if (r?.stored) notify();
            // session 没有归属 ticket、输出里的 ticket 号也不存在：记一笔，免得用户以为采集坏了。
            else if (r && r.reason === "no_ticket") logger(`/handoff output in session ${stop.sessionId} names no known ticket; not stored`);
          },
          (e: unknown) => logger("capture /handoff failed", e),
        );
      }
      if (effect.kind === "ignored") return;
      // 总控开的子 session 等这个信号才交任务（信任文件夹之类的启动对话框已经过去）。
      if (effect.kind === "session_started") pty.markStarted(effect.sessionId);
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

  shutdownSessions = () => pty.killAll();

  const autostart = {
    get: () => autostartState({ packaged: app.isPackaged, platform: process.platform, openAtLogin: () => app.getLoginItemSettings().openAtLogin }),
    set: (on: boolean) => {
      if (!autostart.get().supported) throw new SettingError("只有安装好的 Butler 才能设置开机自启");
      app.setLoginItemSettings({ openAtLogin: on });
      return autostart.get();
    },
  };

  registerIpc({
    onArchived: (key) => removeTicketMcpConfigs(paths.mcp, key),
    autostart,
    tickets, ticketService, sessionService, pty, health, followups, handoffs, settings, briefService, runner, scheduler, jobs,
    keys, terms, audit, memory,
    llmStatus: () => llmStatus({ settings, keys, audit, now: Date.now }),
    briefRefreshing: () => briefRefreshing,
    briefNarrating: () => briefNarrating,
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
      tickets, sessions, ticketService, sessionService, notify,
      submit: (termId, message) => pty.deliver(termId, message, { singleLine: process.platform === "win32" }),
      log: logger,
    }),
    log: logger,
  });

  win = createWindow();
  tray = createTray();
  inbox.start();
  controlInbox.start();
  void runDiscovery();
  // 启动时补齐记忆：老数据、上次退出时没写完的。
  void memory.syncAll();
  const discoveryTimer = setInterval(() => void runDiscovery(), DISCOVERY_INTERVAL_MS);

  // 调度：启动（health 探测完成后）、唤醒、解锁时检查到期任务；每分钟 tick，覆盖 16:00 和整晚没锁屏的情况。
  void healthReady.then(() => checkSchedule("startup"));
  powerMonitor.on("resume", () => void checkSchedule("resume"));
  powerMonitor.on("unlock-screen", () => void checkSchedule("unlock"));
  // macOS / Linux 关机：和 Windows 的 session-end 一样，不再拦着关窗口。
  powerMonitor.on("shutdown", () => quitState.requestQuit());
  const scheduleTimer = setInterval(() => void checkSchedule("tick"), TICK_MS);

  app.on("will-quit", () => {
    clearInterval(discoveryTimer);
    clearInterval(scheduleTimer);
    if (hookDiscoveryTimer) clearTimeout(hookDiscoveryTimer);
    memory.stop();
    inbox.stop();
    controlInbox.stop();
    pty.killAll();
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
    .then(bootstrap)
    .catch((e: unknown) => {
      // 数据比程序新：给一句能看懂的话，不贴调用栈。
      const text = e instanceof NewerDatabaseError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
      dialog.showErrorBox("Butler 启动失败", text);
      app.exit(1);
    });
}
