import { dialog, ipcMain, type BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc";
import type { CreateTicketInput, OpenSessionRequest, TicketStatus } from "../../shared/types";
import type { TicketsRepo } from "../db/tickets-repo";
import type { HealthService } from "../hooks/health";
import type { PtyManager } from "../sessions/pty-manager";
import type { SessionService } from "../sessions/session-service";
import { TicketError, type TicketService } from "../tickets/ticket-service";
import { toIpcResult } from "./result";

export interface IpcDeps {
  tickets: TicketsRepo;
  ticketService: TicketService;
  sessionService: SessionService;
  pty: PtyManager;
  health: HealthService;
  window: () => BrowserWindow | null;
  now: () => number;
  notify: () => void;
}

export function registerIpc(d: IpcDeps): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args: unknown[]) => toIpcResult(() => fn(...args)));

  handle(IPC.ticketsList, () => d.sessionService.ticketViews());
  handle(IPC.ticketsCreate, async (input: CreateTicketInput) => {
    const t = await d.ticketService.create(input);
    d.notify();
    return t;
  });
  handle(IPC.ticketsSetStatus, (key: string, status: TicketStatus | null) => {
    d.tickets.setStatusManual(key, status, d.now());
    d.notify();
  });
  handle(IPC.ticketsArchive, (key: string) => {
    d.tickets.archive(key, d.now());
    d.notify();
  });
  handle(IPC.ticketsSwitchBranch, async (key: string) => {
    const t = d.tickets.get(key);
    if (!t) throw new TicketError("not_found", `找不到 ticket ${key}`);
    await d.ticketService.switchBranch(t);
  });

  handle(IPC.sessionsOpen, async (req: OpenSessionRequest) => {
    const r = await d.sessionService.open(req);
    d.notify();
    return r;
  });
  handle(IPC.sessionsUnclaimed, () => d.sessionService.unclaimed());
  handle(IPC.sessionsClaim, (id: string, key: string) => {
    d.sessionService.claim(id, key);
    d.notify();
  });
  handle(IPC.sessionsDismiss, (id: string) => {
    d.sessionService.dismiss(id);
    d.notify();
  });

  handle(IPC.ptySnapshot, (id: string) => d.pty.snapshot(id));
  handle(IPC.ptyKill, (id: string) => d.pty.kill(id));
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => d.pty.write(id, data));
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => d.pty.resize(id, cols, rows));

  handle(IPC.healthGet, () => d.health.refresh());
  handle(IPC.healthInstallHooks, () => d.health.installHooks());
  handle(IPC.healthUninstallHooks, () => d.health.uninstallHooks());

  handle(IPC.dialogPickDir, async () => {
    const w = d.window();
    const options = { properties: ["openDirectory" as const] };
    const r = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
}
