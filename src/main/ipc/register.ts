import { clipboard, dialog, ipcMain, type BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc";
import {
  FOLLOWUP_STATUSES, type AutostartState, type FollowupStatus, type JobStateView, type McpProbe, type MergeEvent, type NowView, type OpenSessionRequest, type TicketStatus, type WatchedPr,
} from "../../shared/types";
import type { AuditPage, LlmStatus, SensitiveTerm } from "../../shared/llm";
import type { EpicService } from "../epics/epic-service";
import type { AuditRepo } from "../db/audit-repo";
import type { MemoryService } from "../memory/memory-service";
import { JOB_NIGHTLY, type JobsRepo } from "../db/jobs-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MergeGateRepo } from "../db/merge-gate-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { UsageRepo } from "../db/usage-repo";
import { summarizeUsage, USAGE_WINDOW_MS } from "../usage/usage-summary";
import type { TermsRepo } from "../db/terms-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { KeyStore } from "../gateway/key-store";
import { auditPage } from "../gateway/status";
import type { HandoffRunner } from "../handoff/runner";
import type { FeatureSummaryRunner } from "../handoff/feature-runner";
import type { HealthService } from "../hooks/health";
import { addDays, localDate } from "../schedule/calendar";
import type { Scheduler } from "../schedule/scheduler";
import type { ActivityMonitor } from "../sessions/activity-monitor";
import type { PtyManager } from "../sessions/pty-manager";
import type { SessionService } from "../sessions/session-service";
import { memoryOn } from "../settings/settings-values";
import type { FeatureService } from "../tickets/feature-service";
import { scanRepos } from "../tickets/git";
import { TicketError, type TicketService } from "../tickets/ticket-service";
import type { CleanupOutcome } from "../tickets/worktree-cleanup";
import { currentLang } from "../i18n";
import { toIpcResult } from "./result";
import { memoryHandlers } from "./memory-handlers";
import { settingsHandlers } from "./settings-handlers";
import {
  addRepoArg, apiKeyArg, auditCursorArg, boolArg, clipboardTextArg, createEpicArg, createFeatureArg, createTicketArg, dirArg, epicIdArg, epicNameArg, featureIdArg, featureNameArg, moveTargetArg,
  openEpicArg, openFeatureArg, openFixArg, repoIdArg, sessionIdArg, termsArg, ticketKeyArg, updateRepoArg, updateTicketArg,
} from "./validate";
import { M } from "../strings";

export interface IpcDeps {
  tickets: TicketsRepo;
  ticketService: TicketService;
  featureService: FeatureService;
  epicService: EpicService;
  sessionService: SessionService;
  activity: Pick<ActivityMonitor, "dismiss">;
  usage: Pick<UsageRepo, "since">;
  sessions: Pick<SessionsRepo, "get">;
  pty: PtyManager;
  health: HealthService;
  followups: FollowupsRepo;
  handoffs: HandoffsRepo;
  settings: SettingsRepo;
  gateRepo: Pick<MergeGateRepo, "recentEvents">;
  /** PrWatcher 跟着的 PR 和 CI。 */
  prWatchList: () => WatchedPr[];
  /** 「现在」页：session、活动、PR、合并排队和「需要你」拼成的一份（buildNowView），merges 是“最近合并”。 */
  nowView: (merges: MergeEvent[]) => NowView;
  runner: HandoffRunner;
  featureRunner: Pick<FeatureSummaryRunner, "runManual">;
  scheduler: Scheduler;
  jobs: JobsRepo;
  keys: KeyStore;
  terms: TermsRepo;
  audit: AuditRepo;
  memory: Pick<MemoryService, "view" | "why">;
  autostart: { get(): AutostartState; set(on: boolean): AutostartState };
  /** 防休眠开关（只在内存里，启动时是关的）。 */
  keepAwake: { isOn(): boolean; set(on: boolean): void };
  llmStatus: () => LlmStatus;
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
  /** feature 归档之后：清掉 feature 总控的 MCP 配置文件。 */
  onFeatureArchived?: (featureId: number) => void;
  /** “重新检查”：PR 已合并时按规则再清理一次这个 ticket 的 worktree（设计文档 2026-10-26）。 */
  recheckCleanup: (ticketKey: string) => Promise<CleanupOutcome[]>;
  /** language 设置保存或恢复默认之后：重新解析当前语言（设计文档 2026-10-26）。 */
  languageChanged?: () => void;
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
    if (!f) throw new TicketError("not_found", M().followupNotFound);
    const now = d.now();
    d.followups.setStatus(id, status, now, status === "snoozed" ? addDays(localDate(now), 1) : null);
    d.rederive(f.ticketKey);
  };

  handle(IPC.ticketsList, () => d.sessionService.ticketViews());
  handle(IPC.ticketsCreate, async (raw: unknown) => {
    const t = await d.ticketService.create(createTicketArg(raw));
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
    if (!d.tickets.get(key)) throw new TicketError("not_found", M().ticketNotFound(key));
    d.tickets.unarchive(key);
    d.notify();
  });
  handle(IPC.ticketsSwitchBranch, async (raw: unknown) => {
    await d.ticketService.switchBranch(d.ticketService.repo(repoIdArg(raw)));
  });

  handle(IPC.ticketsRecheckCleanup, async (raw: unknown) => {
    const out = await d.recheckCleanup(ticketKeyArg(raw));
    d.notify();
    return out;
  });

  // feature（设计文档 2026-10-26）
  handle(IPC.featuresList, () => d.sessionService.featureViews());
  handle(IPC.featuresCreate, async (raw: unknown) => {
    const f = await d.featureService.create(createFeatureArg(raw));
    d.notify();
    return f;
  });
  handle(IPC.featuresRename, (id: unknown, name: unknown) => {
    const f = d.featureService.rename(featureIdArg(id), featureNameArg(name));
    d.notify();
    return f;
  });
  handle(IPC.featuresAddRepo, async (id: unknown, path: unknown) => {
    const r = await d.featureService.addRepo(featureIdArg(id), dirArg(path));
    d.notify();
    return r;
  });
  handle(IPC.featuresRemoveRepo, (featureRepoId: unknown) => {
    d.featureService.removeRepo(repoIdArg(featureRepoId));
    d.notify();
  });
  handle(IPC.featuresArchive, async (raw: unknown) => {
    const id = featureIdArg(raw);
    // epic 下的 feature 要先生成汇总，最多等两分钟。
    await d.featureService.archive(id, { terminalsOpen: () => d.sessionService.hasFeatureTerminal(id) });
    d.onFeatureArchived?.(id);
    d.notify();
  });
  handle(IPC.featuresArchived, () => d.featureService.listArchived());
  handle(IPC.featuresUnarchive, (raw: unknown) => {
    d.featureService.unarchive(featureIdArg(raw));
    d.notify();
  });
  handle(IPC.featuresOpenSession, async (raw: unknown) => {
    const r = await d.sessionService.openFeature(openFeatureArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.featuresMove, (id: unknown, target: unknown) => {
    d.epicService.moveFeature(featureIdArg(id), moveTargetArg(target));
    d.notify();
  });

  // epic（设计文档 2026-11-01）
  handle(IPC.epicsList, () => d.sessionService.epicViews());
  handle(IPC.epicsCreate, async (raw: unknown) => {
    const e = await d.epicService.create(createEpicArg(raw));
    d.notify();
    return e;
  });
  handle(IPC.epicsRename, (id: unknown, name: unknown) => {
    const e = d.epicService.rename(epicIdArg(id), epicNameArg(name));
    d.notify();
    return e;
  });
  handle(IPC.epicsAddRepo, async (id: unknown, path: unknown) => {
    const r = await d.epicService.addRepo(epicIdArg(id), dirArg(path));
    d.notify();
    return r;
  });
  handle(IPC.epicsRemoveRepo, (epicRepoId: unknown) => {
    d.epicService.removeRepo(repoIdArg(epicRepoId));
    d.notify();
  });
  handle(IPC.epicsArchive, async (raw: unknown) => {
    const id = epicIdArg(raw);
    // 下面的 feature 要先生成汇总，最多等两分钟。终端查两次（等之前、等之后），所以传函数。
    await d.epicService.archive(id, {
      terminalsOpen: () => d.sessionService.hasEpicTerminal(id),
      featureTerminalsOpen: (featureId) => d.sessionService.hasFeatureTerminal(featureId),
    });
    d.notify();
  });
  handle(IPC.epicsArchived, () => d.epicService.listArchived());
  handle(IPC.epicsUnarchive, (raw: unknown) => {
    d.epicService.unarchive(epicIdArg(raw));
    d.notify();
  });
  handle(IPC.epicsOpenSession, async (raw: unknown) => {
    const r = await d.sessionService.openEpic(openEpicArg(raw));
    d.notify();
    return r;
  });

  handle(IPC.reposScan, (raw: unknown) => scanRepos(dirArg(raw)));

  handle(IPC.sessionsOpen, async (req: OpenSessionRequest) => {
    const r = await d.sessionService.open(req);
    d.notify();
    return r;
  });
  handle(IPC.sessionOpenFix, async (raw: unknown) => {
    const r = await d.sessionService.openFix(openFixArg(raw));
    d.notify();
    return r;
  });
  handle(IPC.sessionsUnclaimed, () => d.sessionService.unclaimed());
  handle(IPC.sessionsClaim, (id: string, key: string) => {
    d.sessionService.claim(id, key);
    d.notify();
  });
  handle(IPC.sessionsHide, (raw: unknown) => {
    d.sessionService.hide(sessionIdArg(raw));
    d.notify();
  });
  handle(IPC.sessionsUnhide, (raw: unknown) => {
    d.sessionService.unhide(sessionIdArg(raw));
    d.notify();
  });
  handle(IPC.sessionsDismiss, (id: string) => {
    d.sessionService.dismiss(id);
    d.notify();
  });

  handle(IPC.usageSummary, () => {
    const since = Date.now() - USAGE_WINDOW_MS;
    return summarizeUsage(d.usage.since(since), (id) => (id && d.sessions.get(id)?.coordinator ? "coordinator" : "ticket"), since);
  });
  handle(IPC.activityDismiss, (raw: unknown) => d.activity.dismiss(sessionIdArg(raw)));

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

  // 「现在」页的“最近合并”：最近 7 天、最多 20 条。
  const recentMerges = (): MergeEvent[] => d.gateRepo.recentEvents(d.now() - 7 * 24 * 3600 * 1000, 20);
  handle(IPC.mergeEvents, recentMerges);
  handle(IPC.prWatchList, (): WatchedPr[] => d.prWatchList());
  handle(IPC.nowView, (): NowView => d.nowView(recentMerges()));

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
  // 手动“立即更新”feature 汇总：和 ticket 的手动 handoff 一样，跑完刷新界面。
  handle(IPC.featuresSummaryRun, async (raw: unknown) => {
    const outcome = await d.featureRunner.runManual(featureIdArg(raw));
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
  handle(IPC.appLanguage, () => currentLang());
  handle(IPC.appAutostartSet, (on: unknown) => d.autostart.set(boolArg(on)));
  handle(IPC.appKeepAwakeGet, () => d.keepAwake.isOn());
  handle(IPC.appKeepAwakeSet, (on: unknown) => {
    d.keepAwake.set(boolArg(on));
    return d.keepAwake.isOn();
  });
}
