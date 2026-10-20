import { IPC, type IpcResult } from "../../shared/ipc";
import type {
  CreateTicketInput, HealthReport, OpenSessionRequest, OpenSessionResult, Ticket, TicketStatus, TicketView, UnclaimedSession,
} from "../../shared/types";

declare global {
  interface Window {
    butler: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;
      send(channel: string, ...args: unknown[]): void;
      on(channel: string, cb: (...args: never[]) => void): () => void;
    };
  }
}

export class ButlerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await window.butler.invoke(channel, ...args)) as IpcResult<T>;
  if (!r.ok) throw new ButlerError(r.code, r.message);
  return r.value;
}

export const api = {
  listTickets: () => call<TicketView[]>(IPC.ticketsList),
  createTicket: (input: CreateTicketInput) => call<Ticket>(IPC.ticketsCreate, input),
  setStatus: (key: string, status: TicketStatus | null) => call<void>(IPC.ticketsSetStatus, key, status),
  archive: (key: string) => call<void>(IPC.ticketsArchive, key),
  switchBranch: (key: string) => call<void>(IPC.ticketsSwitchBranch, key),
  openSession: (req: OpenSessionRequest) => call<OpenSessionResult>(IPC.sessionsOpen, req),
  unclaimed: () => call<UnclaimedSession[]>(IPC.sessionsUnclaimed),
  claim: (sessionId: string, ticketKey: string) => call<void>(IPC.sessionsClaim, sessionId, ticketKey),
  dismiss: (sessionId: string) => call<void>(IPC.sessionsDismiss, sessionId),
  ptySnapshot: (termId: string) => call<string>(IPC.ptySnapshot, termId),
  ptyKill: (termId: string) => call<void>(IPC.ptyKill, termId),
  ptyWrite: (termId: string, data: string) => window.butler.send(IPC.ptyWrite, termId, data),
  ptyResize: (termId: string, cols: number, rows: number) => window.butler.send(IPC.ptyResize, termId, cols, rows),
  health: () => call<HealthReport>(IPC.healthGet),
  installHooks: () => call<HealthReport>(IPC.healthInstallHooks),
  uninstallHooks: () => call<HealthReport>(IPC.healthUninstallHooks),
  pickDirectory: () => call<string | null>(IPC.dialogPickDir),
  onPtyData: (cb: (termId: string, data: string) => void) => window.butler.on(IPC.ptyData, cb),
  onPtyExit: (cb: (termId: string, code: number) => void) => window.butler.on(IPC.ptyExit, cb),
  onStateChanged: (cb: () => void) => window.butler.on(IPC.stateChanged, cb),
};
