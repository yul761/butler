import type { BriefKind, BriefView, ItemMark } from "../../shared/brief";
import { IPC, type IpcResult } from "../../shared/ipc";
import type { MemoryView, WhyEntry } from "../../shared/memory";
import type { AuditPage, LlmStatus, SensitiveTerm } from "../../shared/llm";
import type { EditableSettingKey, EditableSettings } from "../../shared/settings";
import type {
  AutostartState, CreateTicketInput, Followup, FollowupStatus, HandoffOutcome, HandoffRecord, HealthReport, McpProbe, OpenSessionRequest,
  OpenSessionResult, Ticket, TicketRepo, TicketStatus, TicketView, UnclaimedSession, UpdateTicketInput, AddRepoInput, UpdateRepoInput,
  JobStateView, CreateFeatureInput, Feature, FeatureRepo, FeatureView, OpenFeatureSessionRequest, ScanResult,
} from "../../shared/types";

declare global {
  interface Window {
    butler: {
      platform: string;
      pathForFile(file: File): string;
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

export const platform = (): string => window.butler.platform;
export const pathForFile = (file: File): string => window.butler.pathForFile(file);

export const api = {
  listTickets: () => call<TicketView[]>(IPC.ticketsList),
  createTicket: (input: CreateTicketInput) => call<Ticket>(IPC.ticketsCreate, input),
  setStatus: (key: string, status: TicketStatus | null) => call<void>(IPC.ticketsSetStatus, key, status),
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
  scanRepos: (dir: string) => call<ScanResult>(IPC.reposScan, dir),
  unclaimed: () => call<UnclaimedSession[]>(IPC.sessionsUnclaimed),
  claim: (sessionId: string, ticketKey: string) => call<void>(IPC.sessionsClaim, sessionId, ticketKey),
  dismiss: (sessionId: string) => call<void>(IPC.sessionsDismiss, sessionId),
  hideSession: (sessionId: string) => call<void>(IPC.sessionsHide, sessionId),
  unhideSession: (sessionId: string) => call<void>(IPC.sessionsUnhide, sessionId),
  ptySnapshot: (termId: string) => call<{ data: string; exitCode: number | null }>(IPC.ptySnapshot, termId),
  ptyKill: (termId: string) => call<void>(IPC.ptyKill, termId),
  ptyWrite: (termId: string, data: string) => window.butler.send(IPC.ptyWrite, termId, data),
  ptyResize: (termId: string, cols: number, rows: number) => window.butler.send(IPC.ptyResize, termId, cols, rows),
  health: () => call<HealthReport>(IPC.healthGet),
  installHooks: () => call<HealthReport>(IPC.healthInstallHooks),
  uninstallHooks: () => call<HealthReport>(IPC.healthUninstallHooks),
  pickDirectory: () => call<string | null>(IPC.dialogPickDir),
  briefLatest: (kind: BriefKind) => call<BriefView>(IPC.briefsLatest, kind),
  regenerateBrief: () => call<JobStateView | null>(IPC.briefsRegenerate),
  markBriefItem: (key: string, mark: ItemMark) => call<void>(IPC.briefsMark, key, mark),
  followups: (ticketKey: string) => call<Followup[]>(IPC.followupsList, ticketKey),
  setFollowupStatus: (id: string, status: FollowupStatus) => call<void>(IPC.followupsSetStatus, id, status),
  handoffs: (ticketKey: string) => call<HandoffRecord[]>(IPC.handoffsList, ticketKey),
  runHandoff: (ticketKey: string) => call<HandoffOutcome>(IPC.handoffsRun, ticketKey),
  runNightly: () => call<JobStateView | null>(IPC.jobsRunNightly),
  settings: () => call<EditableSettings>(IPC.settingsGet),
  setSetting: (key: EditableSettingKey, value: string) => call<void>(IPC.settingsSet, key, value),
  resetSetting: (key: EditableSettingKey) => call<void>(IPC.settingsReset, key),
  detectTrackerTools: () => call<McpProbe>(IPC.settingsDetectTrackerTools),
  llmStatus: () => call<LlmStatus>(IPC.llmStatus),
  /** key 只发这一次；之后界面只能拿到打码形式。 */
  saveApiKey: (key: string) => call<LlmStatus>(IPC.llmKeySave, key),
  clearApiKey: () => call<LlmStatus>(IPC.llmKeyClear),
  terms: () => call<SensitiveTerm[]>(IPC.termsList),
  saveTerms: (terms: SensitiveTerm[]) => call<SensitiveTerm[]>(IPC.termsSave, terms),
  audit: (beforeId?: number) => call<AuditPage>(IPC.auditList, beforeId),
  memoryView: (ticketKey: string) => call<MemoryView>(IPC.memoryView, ticketKey),
  autostart: () => call<AutostartState>(IPC.appAutostartGet),
  setAutostart: (on: boolean) => call<AutostartState>(IPC.appAutostartSet, on),
  memoryWhy: (ticketKey: string, factId: string) => call<WhyEntry[] | null>(IPC.memoryWhy, ticketKey, factId),
  onNavigate: (cb: (route: { page: "home"; kind?: BriefKind }) => void) => window.butler.on(IPC.appNavigate, cb),
  onPtyData: (cb: (termId: string, data: string) => void) => window.butler.on(IPC.ptyData, cb),
  onPtyExit: (cb: (termId: string, code: number) => void) => window.butler.on(IPC.ptyExit, cb),
  onStateChanged: (cb: () => void) => window.butler.on(IPC.stateChanged, cb),
  /** 记忆写进了 StateCore（ticketKey），或记忆开关变了（null：所有 ticket）。 */
  onMemoryChanged: (cb: (ticketKey: string | null) => void) => window.butler.on(IPC.memoryChanged, cb),
};
