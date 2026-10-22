import { dialog, ipcMain, type BrowserWindow } from "electron";
import { ITEM_MARKS, type BriefKind, type BriefView, type ItemMark } from "../../shared/brief";
import { IPC } from "../../shared/ipc";
import { EDITABLE_SETTINGS, isEditableSetting, type EditableSettings } from "../../shared/settings";
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
import { normalizeSetting, SettingError } from "../settings/settings-values";
import { TicketError, type TicketService } from "../tickets/ticket-service";
import { toIpcResult } from "./result";
import { memoryHandlers } from "./memory-handlers";
import { apiKeyArg, auditCursorArg, boolArg, termsArg } from "./validate";

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
  const settingKey = (key: unknown) => {
    if (typeof key !== "string" || !isEditableSetting(key)) throw new SettingError(`这个设置不能在这里修改：${String(key)}`);
    return key;
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

  handle(IPC.settingsGet, (): EditableSettings => Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, d.settings.get(k)])) as EditableSettings);
  handle(IPC.settingsSet, async (key: string, value: unknown) => {
    const k = settingKey(key);
    d.settings.set(k, normalizeSetting(k, String(value ?? "")));
    if (k === "claudePath") await d.health.refresh();
    d.notify();
  });
  handle(IPC.settingsReset, async (key: string) => {
    const k = settingKey(key);
    d.settings.reset(k);
    if (k === "claudePath") await d.health.refresh();
    d.notify();
  });
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
  const mem = memoryHandlers(d);
  handle(IPC.memoryView, mem.view);
  handle(IPC.memoryWhy, mem.why);

  handle(IPC.appAutostartGet, () => d.autostart.get());
  handle(IPC.appAutostartSet, (on: unknown) => d.autostart.set(boolArg(on)));
}
