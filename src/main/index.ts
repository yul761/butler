import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, powerMonitor, Tray } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Brief } from "../shared/brief";
import { IPC } from "../shared/ipc";
import { BriefService } from "./brief/brief-service";
import { runHeadless } from "./claude/headless";
import { probeMcpTools } from "./claude/mcp-probe";
import { headlessEnv } from "./claude/spawn";
import { BriefsRepo } from "./db/briefs-repo";
import { openDatabase } from "./db/database";
import { FollowupsRepo } from "./db/followups-repo";
import { HandoffsRepo } from "./db/handoffs-repo";
import { JobsRepo } from "./db/jobs-repo";
import { MarksRepo } from "./db/marks-repo";
import { SessionsRepo } from "./db/sessions-repo";
import { SettingsRepo } from "./db/settings-repo";
import { TicketsRepo } from "./db/tickets-repo";
import { captureCommandHandoff, stopFromEnvelope } from "./handoff/capture";
import { ingestHandoff, rederiveTicketStatus, type IngestInput } from "./handoff/ingest";
import { HandoffRunner } from "./handoff/runner";
import { HealthService } from "./hooks/health";
import { applyHookEnvelope } from "./hooks/hook-events";
import { createFileLogger, type Logger } from "./logger";
import { HookInbox } from "./hooks/inbox";
import { registerIpc } from "./ipc/register";
import { ensureDirs, resolvePaths } from "./paths";
import { isWorkingDay, localDate } from "./schedule/calendar";
import { morningJob, nightlyJob, type DailyJobDeps } from "./schedule/daily-jobs";
import { Scheduler, TICK_MS, type ScheduleTrigger } from "./schedule/scheduler";
import { findTranscript, needsDiscovery, scanClaudeProjects, syncDiscovered, transcriptState, UNCLAIMED_WINDOW_MS } from "./sessions/discovery";
import { PtyManager } from "./sessions/pty-manager";
import { nodePtyFactory } from "./sessions/pty-node";
import { SessionService } from "./sessions/session-service";
import { scheduleConfig } from "./settings/settings-values";
import { runSmoke } from "./smoke";
import { N } from "./strings";
import { TicketService } from "./tickets/ticket-service";
import { canSend } from "./safe-send";
import { circleBitmap } from "./tray-bitmap";

const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** hook 发现没有 ticket 的 session 后，稍等片刻再扫描磁盘（合并连续事件）。 */
const HOOK_DISCOVERY_DEBOUNCE_MS = 3000;
/** 系统空闲超过这么多秒就不算“正在用电脑”（用于 tick 触发早间简报）。 */
const ACTIVE_IDLE_SECONDS = 120;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 保留最近一条通知的引用，否则它可能在用户点击前被回收。 */
let lastNotification: Notification | null = null;
let quitting = false;
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
const isolatedHome = process.env.BUTLER_HOME?.trim();
if (isolatedHome) app.setPath("userData", join(isolatedHome, "electron"));

function safeSend(channel: string, ...args: unknown[]): void {
  if (win && canSend(win)) win.webContents.send(channel, ...args);
}

function bundledHookPath(): string {
  const name = process.platform === "win32" ? "butler-hook.exe" : "butler-hook";
  return app.isPackaged ? join(process.resourcesPath, "hook", name) : join(app.getAppPath(), "build", "hook", name);
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
  // 关窗口只是藏到托盘，终端进程继续运行。
  w.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  // 拖入文件等导航不能替换界面（否则 preload 桥会暴露给任意页面）；也不允许新开窗口。
  w.webContents.on("will-navigate", (e, url) => {
    if (!isOwnUrl(url)) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
  const icon = nativeImage.createFromBitmap(circleBitmap(16, isMac ? [0, 0, 0] : [0xdf, 0x6f, 0x2f]), { width: 16, height: 16 });
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

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();
  await ensureDirs(paths);
  logger = createFileLogger(join(paths.logs, "main.log"), undefined, app.isPackaged ? undefined : teeToConsole);
  if (!app.isPackaged) process.stderr.on("error", () => { teeBroken = true; });
  const db = openDatabase(paths.db);
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const settings = new SettingsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const jobs = new JobsRepo(db);
  const ticketService = new TicketService({ tickets, settings, now: Date.now });
  const health = new HealthService({ paths, platform: process.platform, env: process.env, settings, bundledHookBin: bundledHookPath() });
  const notify = () => safeSend(IPC.stateChanged);
  // 健康探测可能很慢（登录 shell、claude --version）：后台进行，窗口先出来。
  const healthReady: Promise<void> = health.refresh().then(
    () => notify(),
    (e: unknown) => {
      logger("initial health refresh failed", e);
    },
  );
  const pty = new PtyManager(nodePtyFactory, {
    data: (id, data) => safeSend(IPC.ptyData, id, data),
    exit: (id, code) => {
      safeSend(IPC.ptyExit, id, code);
      try {
        sessionService.handleExit(id);
      } catch (e) {
        logger("handleExit failed", e);
      }
      notify();
    },
  }, Date.now, logger);
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
    log: logger,
  });

  const transcriptMtime = (id: string): number | null => {
    const file = findTranscript(paths.claudeProjects, id);
    if (!file) return null;
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };
  const ingest = (input: IngestInput) =>
    ingestHandoff({ db, tickets, handoffs, followups, now: Date.now, newFollowupId: () => `f_${randomBytes(4).toString("hex")}` }, input);
  const runner = new HandoffRunner({
    tickets, sessions, handoffs, followups, settings, ingest,
    workDir: (t) => ticketService.workDir(t),
    run: runHeadless,
    ready: () => healthReady,
    claude: () => health.claude(),
    baseEnv: process.env,
    transcriptMtime,
    now: Date.now,
    newRunId: randomUUID,
    signal: headlessAbort.signal,
    log: logger,
  });
  const briefService = new BriefService({
    tickets, sessions, handoffs, followups, marks: new MarksRepo(db), briefs: new BriefsRepo(db), settings,
    now: Date.now, unclaimedCount: () => sessionService.unclaimed().length,
  });

  let briefRefreshing = false;
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
    const first = tickets.list()[0];
    return probeMcpTools({
      claudePath: path,
      cwd: first ? ticketService.workDir(first) : homedir(),
      env: headlessEnv(process.env, { pathValue, runId: randomUUID() }),
      signal: headlessAbort.signal,
    });
  };

  const runDiscovery = async () => {
    try {
      const found = await scanClaudeProjects(paths.claudeProjects, Date.now() - UNCLAIMED_WINDOW_MS);
      syncDiscovered(found, sessions, Date.now());
      // 只有扫描真的找到了某个待补全 session 的 transcript，才记为本次运行已扫描过。
      for (const f of found) if (discoveryPending.delete(f.id)) discoveryRequested.add(f.id);
      notify();
    } catch (e) {
      logger("discovery failed", e);
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
      const effect = applyHookEnvelope(env, { sessions, tickets, transcriptState: (id) => transcriptState(paths.claudeProjects, id) });
      // Stop 之后看这一轮有没有 /handoff 的输出（异步；失败只记日志，不影响 hook 处理）。
      const stop = stopFromEnvelope(env);
      if (stop) {
        void captureCommandHandoff({ sessions, tickets, ingest }, stop).then(
          (r) => {
            if (r?.stored) notify();
          },
          (e: unknown) => logger("capture /handoff failed", e),
        );
      }
      if (effect.kind === "ignored") return;
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

  registerIpc({
    tickets, ticketService, sessionService, pty, health, followups, handoffs, settings, briefService, runner, scheduler,
    briefRefreshing: () => briefRefreshing,
    rederive: (key) => {
      rederiveTicketStatus({ tickets, handoffs, followups, now: Date.now }, key);
    },
    detectTrackerTools,
    window: () => win,
    now: Date.now,
    notify,
    aborted: () => headlessAbort.signal.aborted,
  });

  win = createWindow();
  tray = createTray();
  inbox.start();
  void runDiscovery();
  const discoveryTimer = setInterval(() => void runDiscovery(), DISCOVERY_INTERVAL_MS);

  // 调度：启动（health 探测完成后）、唤醒、解锁时检查到期任务；每分钟 tick，覆盖 16:00 和整晚没锁屏的情况。
  void healthReady.then(() => checkSchedule("startup"));
  powerMonitor.on("resume", () => void checkSchedule("resume"));
  powerMonitor.on("unlock-screen", () => void checkSchedule("unlock"));
  const scheduleTimer = setInterval(() => void checkSchedule("tick"), TICK_MS);

  app.on("will-quit", () => {
    clearInterval(discoveryTimer);
    clearInterval(scheduleTimer);
    if (hookDiscoveryTimer) clearTimeout(hookDiscoveryTimer);
    inbox.stop();
    pty.killAll();
    tray?.destroy();
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
    quitting = true;
    headlessAbort.abort();
    shutdownSessions();
  });
  // 常驻托盘：窗口全部关闭也不退出。
  app.on("window-all-closed", () => undefined);
  void app
    .whenReady()
    .then(bootstrap)
    .catch((e: unknown) => {
      dialog.showErrorBox("Butler 启动失败", e instanceof Error ? (e.stack ?? e.message) : String(e));
      app.exit(1);
    });
}
