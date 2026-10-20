import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import { openDatabase } from "./db/database";
import { SessionsRepo } from "./db/sessions-repo";
import { SettingsRepo } from "./db/settings-repo";
import { TicketsRepo } from "./db/tickets-repo";
import { HealthService } from "./hooks/health";
import { applyHookEnvelope } from "./hooks/hook-events";
import { HookInbox } from "./hooks/inbox";
import { registerIpc } from "./ipc/register";
import { ensureDirs, resolvePaths } from "./paths";
import { scanClaudeProjects, syncDiscovered, UNCLAIMED_WINDOW_MS } from "./sessions/discovery";
import { PtyManager } from "./sessions/pty-manager";
import { nodePtyFactory } from "./sessions/pty-node";
import { SessionService } from "./sessions/session-service";
import { runSmoke } from "./smoke";
import { TicketService } from "./tickets/ticket-service";
import { circleBitmap } from "./tray-bitmap";

const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function bundledHookPath(): string {
  const name = process.platform === "win32" ? "butler-hook.exe" : "butler-hook";
  return app.isPackaged ? join(process.resourcesPath, "hook", name) : join(app.getAppPath(), "build", "hook", name);
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
  // 关窗口只是藏到托盘，终端进程继续运行。
  w.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(__dirname, "../renderer/index.html"));
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

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();
  await ensureDirs(paths);
  const db = openDatabase(paths.db);
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const settings = new SettingsRepo(db);
  const ticketService = new TicketService({ tickets, settings, now: Date.now });
  const health = new HealthService({ paths, platform: process.platform, env: process.env, settings, bundledHookBin: bundledHookPath() });
  await health.refresh();

  const notify = () => win?.webContents.send(IPC.stateChanged);
  const pty = new PtyManager(nodePtyFactory, {
    data: (id, data) => win?.webContents.send(IPC.ptyData, id, data),
    exit: (id, code) => {
      win?.webContents.send(IPC.ptyExit, id, code);
      notify();
    },
  });
  const sessionService = new SessionService({
    tickets, sessions, settings, ticketService, pty,
    claude: () => health.claude(),
    newId: randomUUID,
    now: Date.now,
    platform: process.platform,
    baseEnv: process.env,
  });

  const runDiscovery = async () => {
    try {
      syncDiscovered(await scanClaudeProjects(paths.claudeProjects, Date.now() - UNCLAIMED_WINDOW_MS), sessions, Date.now());
      notify();
    } catch (e) {
      console.error("discovery failed", e);
    }
  };

  const inbox = new HookInbox({
    dir: paths.inbox,
    badDir: paths.inboxBad,
    log: (m) => console.warn(m),
    handle: (env) => {
      const effect = applyHookEnvelope(env, { sessions, tickets });
      if (effect.kind !== "ignored") notify();
    },
  });

  registerIpc({ tickets, ticketService, sessionService, pty, health, window: () => win, now: Date.now, notify });

  win = createWindow();
  tray = createTray();
  inbox.start();
  void runDiscovery();
  const discoveryTimer = setInterval(() => void runDiscovery(), DISCOVERY_INTERVAL_MS);

  app.on("will-quit", () => {
    clearInterval(discoveryTimer);
    inbox.stop();
    pty.killAll();
    tray?.destroy();
    db.close();
  });
}

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
