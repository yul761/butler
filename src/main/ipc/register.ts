import { clipboard, dialog, ipcMain, type BrowserWindow } from "electron";
import { ITEM_MARKS, type BriefKind, type BriefView, type ItemMark } from "../../shared/brief";
import { IPC } from "../../shared/ipc";
import {
  FOLLOWUP_STATUSES, type AutostartState, type CreateTicketInput, type FollowupStatus, type JobStateView, type McpProbe, type OpenSessionRequest, type TicketStatus,
} from "../../shared/types";
import type { AuditPage, LlmStatus, SensitiveTerm } from "../../shared/llm";
import type { BriefService } from "../brief/brief-service";
import type { AuditRepo } from "../db/audit-repo";
import type { MemoryService } from "../memory/memory-service";
import { JOB_MORNING, JOB_NIGHTLY, type JobsRepo } from "../db/jobs-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TermsRepo } from "../db/terms-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { KeyStore } from "../gateway/key-store";
import { auditPage } from "../gateway/status";
import type { HandoffRunner } from "../handoff/runner";
import type { HealthService } from "../hooks/health";
import { addDays, localDate } from "../schedule/calendar";
import type { Scheduler } from "../schedule/scheduler";
import type { PtyManager } from "../sessions/pty-manager";
import type { SessionService } from "../sessions/session-service";
import { memoryOn } from "../settings/settings-values";
import { TicketError, type TicketService } from "../tickets/ticket-service";
import { toIpcResult } from "./result";
import { memoryHandlers } from "./memory-handlers";
import { settingsHandlers } from "./settings-handlers";
import {
  addRepoArg, apiKeyArg, auditCursorArg, boolArg, clipboardTextArg, repoIdArg, termsArg, ticketKeyArg, updateRepoArg, updateTicketArg,
} from "./validate";

export interface IpcDeps {
  tickets: TicketsRepo;
  ticketService: TicketService;
  sessionService: SessionService;
  pty: PtyManager;
  health: HealthService;
  followups: FollowupsRepo;
  handoffs: HandoffsRepo;
  settings: SettingsRepo;
  briefService: BriefService;
  runner: HandoffRunner;
  scheduler: Scheduler;
  jobs: JobsRepo;
  keys: KeyStore;
  terms: TermsRepo;
  audit: AuditRepo;
  memory: Pick<MemoryService, "view" | "why">;
  autostart: { get(): AutostartState; set(on: boolean): AutostartState };
  llmStatus: () => LlmStatus;
  /** 早间刷新进行中。 */
  briefRefreshing: () => boolean;
  /** 正在生成“今日重点”。 */
  briefNarrating: () => boolean;
  /** followup 状态变化后重新推导 ticket 状态。 */
  rederive: (ticketKey: string) => void;
  detectTrackerTools: () => Promise<McpProbe>;
  window: () => BrowserWindow | null;
  now: () => number;
  notify: () => void;
  /** 记忆开关真的变了之后调用（on 是新的状态）：通知记忆标签，打开时补同步一次。 */
  memoryToggled: (on: boolean) => void;
  /** ticket 归档之后：清掉它留下的 MCP 配置文件。 */
  onArchived?: (ticketKey: string) => void;
  /** 退出已开始：后台任务的 IPC 直接返回。 */
  aborted: () => boolean;
}

export function registerIpc(d: IpcDeps): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args: unknown[]) => toIpcResult(() => fn(...args)));

  const setFollowupStatus = (id: string, status: FollowupStatus) => {
    if (!(FOLLOWUP_STATUSES as readonly string[]).includes(status)) throw new Error(`unknown followup status: ${String(status)}`);
    const f = d.followups.get(id);
    if (!f) throw new TicketError("not_found", "找不到这条 follow-up");
    const now = d.now();
    d.followups.setStatus(id, status, now, status === "snoozed" ? addDays(localDate(now), 1) : null);
    d.rederive(f.ticketKey);
  };

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
    if (!d.tickets.get(key)) throw new TicketError("not_found", `找不到 ticket ${key}`);
    d.tickets.unarchive(key);
    d.notify();
  });
  handle(IPC.ticketsSwitchBranch, async (raw: unknown) => {
    await d.ticketService.switchBranch(d.ticketService.repo(repoIdArg(raw)));
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

  // 终端的复制粘贴：xterm 在 Windows 上把 Ctrl+V 当成 ^V 发给 claude，渲染进程拦下按键后经这里读写系统剪贴板。
  handle(IPC.clipboardRead, () => clipboard.readText());
  handle(IPC.clipboardWrite, (text: unknown) => clipboard.writeText(clipboardTextArg(text)));

  handle(IPC.dialogPickDir, async () => {
    const w = d.window();
    const options = { properties: ["openDirectory" as const] };
    const r = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  handle(IPC.briefsLatest, (kind: BriefKind): BriefView => ({
    brief: d.briefService.latest(kind === "evening" ? "evening" : "morning"),
    refreshing: d.briefRefreshing(),
    narrating: d.briefNarrating(),
  }));
  handle(IPC.briefsRegenerate, async (): Promise<JobStateView | null> => {
    if (d.aborted()) return null;
    await d.scheduler.runMorningNow();
    d.notify();
    // 调度器把失败记在 jobs 表里而不是抛出：把结果交给界面显示。
    return d.jobs.get(JOB_MORNING);
  });
  handle(IPC.briefsMark, (key: string, mark: ItemMark) => {
    if (!(ITEM_MARKS as readonly string[]).includes(mark)) throw new Error(`unknown mark: ${String(mark)}`);
    const k = String(key);
    // followup 条目的状态在 followups 表里，不进 item_marks。
    if (k.startsWith("followup:")) setFollowupStatus(k.slice("followup:".length), mark);
    else d.briefService.mark(k, mark);
    d.notify();
  });

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
  handle(IPC.jobsRunNightly, async (): Promise<JobStateView | null> => {
    if (d.aborted()) return null;
    await d.scheduler.runNightlyNow();
    d.notify();
    return d.jobs.get(JOB_NIGHTLY);
  });

  const settingsIpc = settingsHandlers(d);
  handle(IPC.settingsGet, settingsIpc.get);
  handle(IPC.settingsSet, settingsIpc.set);
  handle(IPC.settingsReset, settingsIpc.reset);
  handle(IPC.settingsDetectTrackerTools, () => d.detectTrackerTools());

  // 个人 API：key 只进不出，界面只拿到打码后的 LlmStatus。参数一律在运行时检查（渲染进程不可信）。
  handle(IPC.llmStatus, (): LlmStatus => d.llmStatus());
  handle(IPC.llmKeySave, (key: unknown): LlmStatus => {
    d.keys.save(apiKeyArg(key));
    d.notify();
    return d.llmStatus();
  });
  handle(IPC.llmKeyClear, (): LlmStatus => {
    d.keys.clear();
    d.notify();
    return d.llmStatus();
  });
  handle(IPC.termsList, (): SensitiveTerm[] => d.terms.list());
  handle(IPC.termsSave, (terms: unknown): SensitiveTerm[] => {
    d.terms.replaceAll(termsArg(terms));
    d.notify();
    return d.terms.list();
  });
  handle(IPC.auditList, (beforeId: unknown): AuditPage =>
    auditPage({ settings: d.settings, keys: d.keys, audit: d.audit, now: d.now }, auditCursorArg(beforeId)));

  // StateCore 记忆（设计文档 8.4）：只读。
  const mem = memoryHandlers({ tickets: d.tickets, memory: d.memory, enabled: () => memoryOn(d.settings) });
  handle(IPC.memoryView, mem.view);
  handle(IPC.memoryWhy, mem.why);

  handle(IPC.appAutostartGet, () => d.autostart.get());
  handle(IPC.appAutostartSet, (on: unknown) => d.autostart.set(boolArg(on)));
}
