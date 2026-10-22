export const IPC = {
  ticketsList: "tickets:list",
  ticketsCreate: "tickets:create",
  ticketsSetStatus: "tickets:setStatus",
  ticketsArchive: "tickets:archive",
  ticketsSwitchBranch: "tickets:switchBranch",
  sessionsOpen: "sessions:open",
  sessionsUnclaimed: "sessions:unclaimed",
  sessionsClaim: "sessions:claim",
  sessionsDismiss: "sessions:dismiss",
  ptySnapshot: "pty:snapshot",
  ptyKill: "pty:kill",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyData: "pty:data",
  ptyExit: "pty:exit",
  stateChanged: "state:changed",
  healthGet: "health:get",
  healthInstallHooks: "health:installHooks",
  healthUninstallHooks: "health:uninstallHooks",
  dialogPickDir: "dialog:pickDir",
  briefsLatest: "briefs:latest",
  briefsRegenerate: "briefs:regenerate",
  briefsMark: "briefs:mark",
  followupsList: "followups:list",
  followupsSetStatus: "followups:setStatus",
  handoffsList: "handoffs:list",
  handoffsRun: "handoffs:run",
  jobsRunNightly: "jobs:runNightly",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  settingsReset: "settings:reset",
  settingsDetectTrackerTools: "settings:detectTrackerTools",
  llmStatus: "llm:status",
  llmKeySave: "llm:keySave",
  llmKeyClear: "llm:keyClear",
  termsList: "terms:list",
  termsSave: "terms:save",
  auditList: "audit:list",
  memoryView: "memory:view",
  memoryWhy: "memory:why",
  appNavigate: "app:navigate",
  appAutostartGet: "app:autostartGet",
  appAutostartSet: "app:autostartSet",
} as const;

/** 渲染进程 → 主进程，有返回值（ipcRenderer.invoke）。 */
export const INVOKE_CHANNELS: readonly string[] = [
  IPC.ticketsList, IPC.ticketsCreate, IPC.ticketsSetStatus, IPC.ticketsArchive, IPC.ticketsSwitchBranch,
  IPC.sessionsOpen, IPC.sessionsUnclaimed, IPC.sessionsClaim, IPC.sessionsDismiss,
  IPC.ptySnapshot, IPC.ptyKill, IPC.healthGet, IPC.healthInstallHooks, IPC.healthUninstallHooks, IPC.dialogPickDir,
  IPC.briefsLatest, IPC.briefsRegenerate, IPC.briefsMark,
  IPC.followupsList, IPC.followupsSetStatus, IPC.handoffsList, IPC.handoffsRun, IPC.jobsRunNightly,
  IPC.settingsGet, IPC.settingsSet, IPC.settingsReset, IPC.settingsDetectTrackerTools,
  IPC.llmStatus, IPC.llmKeySave, IPC.llmKeyClear, IPC.termsList, IPC.termsSave, IPC.auditList,
  IPC.memoryView, IPC.memoryWhy,
  IPC.appAutostartGet, IPC.appAutostartSet,
];
/** 渲染进程 → 主进程，单向高频（键盘输入、尺寸变化）。 */
export const SEND_CHANNELS: readonly string[] = [IPC.ptyWrite, IPC.ptyResize];
/** 主进程 → 渲染进程。 */
export const EVENT_CHANNELS: readonly string[] = [IPC.ptyData, IPC.ptyExit, IPC.stateChanged, IPC.appNavigate];

export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
