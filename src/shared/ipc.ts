
export const IPC = {
  ticketsList: "tickets:list",
  ticketsCreate: "tickets:create",
  ticketsSetStatus: "tickets:setStatus",
  ticketsArchive: "tickets:archive",
  ticketsSwitchBranch: "tickets:switchBranch",
  ticketsUpdate: "tickets:update",
  ticketsArchived: "tickets:archived",
  ticketsUnarchive: "tickets:unarchive",
  ticketsAddRepo: "tickets:addRepo",
  ticketsUpdateRepo: "tickets:updateRepo",
  ticketsRemoveRepo: "tickets:removeRepo",
  featuresList: "features:list",
  featuresSummaryRun: "features:summaryRun",
  featuresCreate: "features:create",
  featuresRename: "features:rename",
  featuresAddRepo: "features:addRepo",
  featuresRemoveRepo: "features:removeRepo",
  featuresArchive: "features:archive",
  featuresArchived: "features:archived",
  featuresUnarchive: "features:unarchive",
  featuresOpenSession: "features:openSession",
  featuresMove: "features:move",
  epicsList: "epics:list",
  epicsCreate: "epics:create",
  epicsRename: "epics:rename",
  epicsAddRepo: "epics:addRepo",
  epicsRemoveRepo: "epics:removeRepo",
  epicsArchive: "epics:archive",
  epicsArchived: "epics:archived",
  epicsUnarchive: "epics:unarchive",
  epicsOpenSession: "epics:openSession",
  /** Butler 总控（BTL-190 第 5 点）。 */
  butlerView: "butler:view",
  butlerOpenSession: "butler:openSession",
  reposScan: "repos:scan",
  ticketsRecheckCleanup: "tickets:recheckCleanup",
  sessionsOpen: "sessions:open",
  sessionsUnclaimed: "sessions:unclaimed",
  sessionsClaim: "sessions:claim",
  sessionsDismiss: "sessions:dismiss",
  sessionsHide: "sessions:hide",
  sessionsUnhide: "sessions:unhide",
  /** 界面上的“换新”按钮（计划 16）：能开始就在后台换新，马上返回。 */
  sessionsRefresh: "sessions:refresh",
  /** 「清理闲置」按钮（BTL-190 第 8 点）：把这些 session 里闲置的关掉（在后台写 handoff、结束终端），马上返回开始关的个数。 */
  sessionsCloseIdle: "sessions:closeIdle",
  /** 隐藏列表里的「全部删除」（BTL-190 第 8 点）：删掉这些隐藏的 session 行，返回删掉的个数。transcript 不动。 */
  sessionsDeleteHidden: "sessions:deleteHidden",
  /** 「钉住」（WS-M B）：钉住的 session 不休眠、不降优先级。 */
  sessionsPin: "sessions:pin",
  /** 唤醒一个休眠的 session（--resume），等到它起来或者失败；返回 WakeResult。 */
  sessionsWake: "sessions:wake",
  sessionOpenFix: "sessions:openFix",
  /** session 撞限后「换下一档继续」（3.0 模型路由）：结束终端，用 --resume + --model 接着。 */
  sessionsSwitchModel: "sessions:switchModel",
  sessionsDismissLimit: "sessions:dismissLimit",
  /** 撞限的交互 session（session 行上的提示）。 */
  sessionsLimits: "sessions:limits",
  activityDismiss: "activity:dismiss",
  usageSummary: "usage:summary",
  ptySnapshot: "pty:snapshot",
  ptyKill: "pty:kill",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  /** 终端出现在屏幕上 / 不在了（WS-M D、E）。 */
  ptyVisible: "pty:visible",
  /** 内存历史曲线（WS-M A）。 */
  memUsageHistory: "memusage:history",
  ptyData: "pty:data",
  ptyExit: "pty:exit",
  stateChanged: "state:changed",
  /** 实况窗口（BTL-190 第 7 点）：session 新的一次工具调用、记忆读写、回合开始 / 结束（ActivityEvent）。 */
  activityEvent: "activity:event",
  healthGet: "health:get",
  healthInstallHooks: "health:installHooks",
  healthUninstallHooks: "health:uninstallHooks",
  dialogPickDir: "dialog:pickDir",
  mergeEvents: "merge:events",
  /** PrWatcher 跟着的 PR 和 CI（未归档 ticket 的）：计划 14 的界面用。 */
  prWatchList: "prwatch:list",
  /** 「现在」页的整份数据（计划 14）。 */
  nowView: "now:view",
  /** PR 进度（六步进度条和时间线）：一个 ticket、feature 或 epic 范围内每个仓库一行。 */
  prStages: "prStages:list",
  /** 在系统浏览器里打开一个 ticket 链接过的 PR（主进程检查主机）。 */
  prOpen: "pr:open",
  lessonsState: "lessons:state",
  lessonsAct: "lessons:act",
  lessonsRuns: "lessons:runs",
  lessonsRun: "lessons:run",
  lessonsPending: "lessons:pending",
  /** 批次历史（契约 4.4）：列表和一个批次的明细。撤销走 lessons:act 的 undoBatch。 */
  lessonsBatches: "lessons:batches",
  lessonsBatch: "lessons:batch",
  /** 三层准入策略（契约 4.2）。 */
  policiesGet: "policies:get",
  policiesSet: "policies:set",
  /** 导入导出（契约 4.3）。文件选择框在主进程里开。 */
  configStatus: "config:status",
  /** 确定性检查（契约 4.5）：某一层看到的检查、一条检查的命中、页面上的操作、从规矩生成草稿。 */
  checksView: "checks:view",
  checksHits: "checks:hits",
  checksAct: "checks:act",
  checksDraft: "checks:draft",
  /** 仓库现状（工作流 E2）：页面数据、扫描 / 取消 / 建检查 / 标记文件表的改动、某一层的标记文件表、一个范围的摘要。 */
  baselinesView: "baselines:view",
  baselinesAct: "baselines:act",
  baselinesRules: "baselines:rules",
  baselinesSummary: "baselines:summary",
  /** 存量扫描：列表、开始 / 取消、一次扫描的明细。 */
  legacyView: "legacy:view",
  legacyAct: "legacy:act",
  legacyViolations: "legacy:violations",
  /** 导出成 lint：导出记录、导出 / 丢弃 / 推送 / 开 PR / 打开 worktree。 */
  checkExportList: "checkExport:list",
  checkExportAct: "checkExport:act",
  configExport: "config:export",
  configImportPreview: "config:importPreview",
  configImportRetarget: "config:importRetarget",
  configImportApply: "config:importApply",
  configBackupNow: "config:backupNow",
  configOpenBackups: "config:openBackups",
  /** Claude 可用状态（限流、模型不可用）和复盘的暂停。 */
  availabilityGet: "availability:get",
  availabilityAct: "availability:act",
  /** 设置页「模型路由」（3.0）。 */
  routingView: "routing:view",
  routingAct: "routing:act",
  /** 重发一条递不出去的 CI 结论（工作流 W）：马上再试一次，返回结果（sent 或没递的原因）。 */
  ciResend: "ci:resend",
  /** 「待你决定」和汇报（BTL-190 第 2+3 点）：一个 feature、一个 epic 或者全部的未决条目和最近的汇报。 */
  inboxList: "inbox:list",
  /** 在卡片上回答一条「待你决定」：记下答案，等提问的 session 停下来送进去。 */
  inboxAnswer: "inbox:answer",
  /** 「不用了」：结束一条「待你决定」，什么都不送。 */
  inboxDismiss: "inbox:dismiss",
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
  externalAuditList: "externalAudit:list",
  progressGet: "progress:get",
  /** 「效果」页（ws-h）：和总控 metrics_overview 同一份。 */
  metricsView: "metrics:view",
  butlerMessages: "butler:messages",
  memoryView: "memory:view",
  memoryWhy: "memory:why",
  memoryChanged: "memory:changed",
  appAutostartGet: "app:autostartGet",
  appLanguage: "app:language",
  appAutostartSet: "app:autostartSet",
  appKeepAwakeGet: "app:keepAwakeGet",
  appKeepAwakeSet: "app:keepAwakeSet",
  appKeepAwakeChanged: "app:keepAwakeChanged",
  clipboardRead: "clipboard:read",
  clipboardWrite: "clipboard:write",
} as const;

/** 渲染进程 → 主进程，有返回值（ipcRenderer.invoke）。 */
export const INVOKE_CHANNELS: readonly string[] = [
  IPC.ticketsList, IPC.ticketsCreate, IPC.ticketsSetStatus, IPC.ticketsArchive, IPC.ticketsSwitchBranch,
  IPC.ticketsUpdate, IPC.ticketsArchived, IPC.ticketsUnarchive, IPC.ticketsAddRepo, IPC.ticketsUpdateRepo, IPC.ticketsRemoveRepo,
  IPC.featuresList, IPC.featuresCreate, IPC.featuresRename, IPC.featuresAddRepo, IPC.featuresRemoveRepo, IPC.featuresArchive,
  IPC.featuresSummaryRun, IPC.featuresArchived, IPC.featuresUnarchive, IPC.featuresOpenSession, IPC.featuresMove, IPC.reposScan, IPC.ticketsRecheckCleanup,
  IPC.epicsList, IPC.epicsCreate, IPC.epicsRename, IPC.epicsAddRepo, IPC.epicsRemoveRepo, IPC.epicsArchive, IPC.epicsArchived, IPC.epicsUnarchive, IPC.epicsOpenSession,
  IPC.butlerView, IPC.butlerOpenSession, IPC.butlerMessages, IPC.progressGet, IPC.metricsView,
  IPC.sessionsOpen, IPC.sessionsUnclaimed, IPC.sessionsClaim, IPC.sessionsDismiss, IPC.sessionsHide, IPC.sessionsUnhide, IPC.sessionsRefresh, IPC.sessionsCloseIdle, IPC.sessionsDeleteHidden, IPC.sessionsPin, IPC.sessionsWake, IPC.sessionOpenFix, IPC.activityDismiss, IPC.usageSummary,
  IPC.ptySnapshot, IPC.ptyKill, IPC.healthGet, IPC.healthInstallHooks, IPC.healthUninstallHooks, IPC.dialogPickDir,
  IPC.mergeEvents, IPC.prWatchList, IPC.prStages, IPC.prOpen, IPC.lessonsState, IPC.lessonsAct, IPC.lessonsRuns, IPC.lessonsRun, IPC.lessonsPending,
  IPC.lessonsBatches, IPC.lessonsBatch, IPC.policiesGet, IPC.policiesSet, IPC.checksView, IPC.checksHits, IPC.checksAct, IPC.checksDraft,
  IPC.baselinesView, IPC.baselinesAct, IPC.baselinesRules, IPC.baselinesSummary, IPC.legacyView, IPC.legacyAct, IPC.legacyViolations, IPC.checkExportList, IPC.checkExportAct, IPC.configStatus, IPC.configExport, IPC.configImportPreview, IPC.configImportRetarget,
  IPC.configImportApply, IPC.configBackupNow, IPC.configOpenBackups, IPC.availabilityGet, IPC.availabilityAct, IPC.ciResend, IPC.routingView, IPC.routingAct, IPC.sessionsSwitchModel, IPC.sessionsDismissLimit, IPC.sessionsLimits, IPC.nowView, IPC.inboxList, IPC.inboxAnswer, IPC.inboxDismiss,
  IPC.followupsList, IPC.followupsSetStatus, IPC.handoffsList, IPC.handoffsRun, IPC.jobsRunNightly,
  IPC.settingsGet, IPC.settingsSet, IPC.settingsReset, IPC.settingsDetectTrackerTools,
  IPC.llmStatus, IPC.llmKeySave, IPC.llmKeyClear, IPC.termsList, IPC.termsSave, IPC.auditList, IPC.externalAuditList,
  IPC.memoryView, IPC.memoryWhy, IPC.memUsageHistory,
  IPC.appAutostartGet, IPC.appAutostartSet, IPC.appKeepAwakeGet, IPC.appKeepAwakeSet, IPC.appLanguage, IPC.clipboardRead, IPC.clipboardWrite,
];
/** 渲染进程 → 主进程，单向高频（键盘输入、尺寸变化）。 */
export const SEND_CHANNELS: readonly string[] = [IPC.ptyWrite, IPC.ptyResize, IPC.ptyVisible];
/** 主进程 → 渲染进程。 */
export const EVENT_CHANNELS: readonly string[] = [IPC.ptyData, IPC.ptyExit, IPC.stateChanged, IPC.activityEvent, IPC.memoryChanged, IPC.appKeepAwakeChanged];

export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
