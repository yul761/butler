
export const IPC = {
  ticketsList: "tickets:list",
  ticketsGlance: "tickets:glance",
  ticketsCreate: "tickets:create",
  ticketsSetStatus: "tickets:setStatus",
  /** 关掉 ticket（不做了，BTL-270）：参数 key、{ reason, closePrs?, endSessions? }。 */
  ticketsClose: "tickets:close",
  /** 撤销关闭（BTL-270）：参数 key。 */
  ticketsReopen: "tickets:reopen",
  /** 关闭以后重试剩下的（BTL-270）：参数 key、{ prUrls, sessionIds }（上次没关成的 PR、没结束的 session）。 */
  ticketsCloseRetry: "tickets:closeRetry",
  /** 关闭框打开时列出这个 ticket 开着的 PR：能关的（逐个勾选）和关不了的（写明原因）（BTL-270）。参数 key。 */
  ticketsClosePreview: "tickets:closePreview",
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
  /** Shipherd 总控（BTL-190 第 5 点）。 */
  shipherdView: "shipherd:view",
  shipherdOpenSession: "shipherd:openSession",
  reposScan: "repos:scan",
  ticketsRecheckCleanup: "tickets:recheckCleanup",
  sessionsOpen: "sessions:open",
  sessionsUnclaimed: "sessions:unclaimed",
  sessionsUnclaimedCount: "sessions:unclaimedCount",
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
  /** 挂回一个摘下过的终端，只取摘下之后的输出（BTL-242）；补不上回整份快照（reset）。 */
  ptySince: "pty:since",
  ptyKill: "pty:kill",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  /** 终端出现在屏幕上 / 不在了（WS-M D、E）。 */
  ptyVisible: "pty:visible",
  /** 终端的 xterm 实例销毁了（BTL-242）：主进程不再给它推 pty:data。pty:snapshot 订阅。 */
  ptyDetach: "pty:detach",
  /** 性能诊断（BTL-242）：渲染进程每分钟报一次 long task；快照给 e2e 测量；导出写一份诊断文件。 */
  diagRenderer: "diag:renderer",
  diagSnapshot: "diag:snapshot",
  /** 「发送反馈」（BTL-254）：打开预填好的 new issue 页；脱敏诊断先预览再存。 */
  feedbackOpen: "feedback:open",
  feedbackDiagPreview: "feedback:diagPreview",
  feedbackDiagSave: "feedback:diagSave",
  diagExport: "diag:export",
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
  /** 「谁该动」看板（UI 重做第 1 层）。 */
  turnBoard: "turn:board",
  turnSendToAgent: "turn:send-to-agent",
  /** 切到首页时调一次：补查请你 review 的 PR（turn:board 不触发查询）。 */
  turnHomeOpened: "turn:home-opened",
  turnChanged: "turn:changed",
  /** PR 进度（六步进度条和时间线）：一个 ticket 或 feature 范围内每个仓库一行。 */
  prStages: "prStages:list",
  /** 在系统浏览器里打开一个 ticket 链接过的 PR（主进程检查主机）。 */
  prOpen: "pr:open",
  /** 终端里点的链接（BTL-257）：在系统浏览器里打开，主进程只放行 http / https。 */
  linkOpen: "link:open",
  lessonsState: "lessons:state",
  lessonsAct: "lessons:act",
  lessonsRuns: "lessons:runs",
  lessonsRun: "lessons:run",
  lessonsPending: "lessons:pending",
  /** 批次历史（契约 4.4）：列表和一个批次的明细。撤销走 lessons:act 的 undoBatch。 */
  lessonsBatches: "lessons:batches",
  lessonsBatch: "lessons:batch",
  /** 规矩准入（工作流 D）：向导的运行、估算和动作；校准页；原则重新分组。 */
  admissionState: "admission:state",
  wizardEstimate: "admission:wizard-estimate",
  wizardAct: "admission:wizard-act",
  calibrationSample: "admission:calibration-sample",
  calibrationStats: "admission:calibration-stats",
  calibrationAct: "admission:calibration-act",
  principlesRegroup: "admission:principles-regroup",
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
  /** 回测和自动升降级（工作流 F）：检查页的回测、分数、影子进度；重跑、清除复查、撤销、阈值复查。 */
  backtestView: "backtest:view",
  backtestAct: "backtest:act",
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
  /** 设置页「花费与后台」（工作流 L）：花费上限的一层、熔断状态和记录；改一层；「继续并提高上限」。 */
  costView: "cost:view",
  costSet: "cost:set",
  costResume: "cost:resume",
  /** session 行的熔断提示：现在不是 ok 的熔断状态。 */
  costBreakers: "cost:breakers",
  /** 后台调度的现状（空闲、时段、额度、每种任务）；手动停 / 恢复一种任务。 */
  backgroundStatus: "background:status",
  backgroundAct: "background:act",
  /** 重发一条递不出去的 CI 结论（工作流 W）：马上再试一次，返回结果（sent 或没递的原因）。 */
  ciResend: "ci:resend",
  /** 「待你决定」和汇报（BTL-190 第 2+3 点）：一个 feature 或者全部的未决条目和最近的汇报。 */
  inboxList: "inbox:list",
  /** 在卡片上回答一条「待你决定」：记下答案，等提问的 session 停下来送进去。 */
  inboxAnswer: "inbox:answer",
  /** 「总控已代答」提醒（BTL-269 A2）：改答案（当作更正送进 session）或者知道了。 */
  inboxBehalf: "inbox:behalf",
  followupsList: "followups:list",
  followupsSetStatus: "followups:setStatus",
  handoffsList: "handoffs:list",
  handoffsRun: "handoffs:run",
  jobsRunNightly: "jobs:runNightly",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  settingsReset: "settings:reset",
  settingsDetectTrackerTools: "settings:detectTrackerTools",
  settingsFeaturePolicy: "settings:featurePolicy",
  settingsPolicyPatch: "settings:policyPatch",
  externalAuditList: "externalAudit:list",
  /** 评论闭环和 CI 分类（工作流 I）。 */
  loopPolicyGet: "loop:policy:get",
  loopPolicySet: "loop:policy:set",
  loopCommentsList: "loop:comments:list",
  loopCommentsAct: "loop:comments:act",
  loopFlakyList: "loop:flaky:list",
  loopFlakyAct: "loop:flaky:act",
  loopEffect: "loop:effect",
  /** 打断与通知（工作流 J）：权限档案、自动选择、默认答案、外部通知。 */
  interruptsState: "interrupts:state",
  interruptsAct: "interrupts:act",
  profilesGet: "profiles:get",
  profilesScan: "profiles:scan",
  /** 预审、就绪、风险、简报、review 效果（工作流 G）。 */
  prAssessment: "review:assessment",
  preReviewRun: "review:run",
  briefRegenerate: "review:brief:regenerate",
  briefPost: "review:brief:post",
  prPolicyGet: "review:policy:get",
  prPolicySet: "review:policy:set",
  reviewEffect: "review:effect",
  reviewQueue: "review:queue",
  /** 预审看得见（BTL-271）：一批 ticket / session / PR 的预审徽标、整个预审队列、队列上的取消和插队。 */
  preReviewStatus: "prereview:status",
  preReviewQueue: "prereview:queue",
  preReviewQueueAct: "prereview:queueAct",
  /** 栈式 PR（工作流 K）。 */
  stacksList: "stacks:list",
  stacksRebase: "stacks:rebase",
  stacksLayerMode: "stacks:layerMode",
  stacksRestore: "stacks:restore",
  stacksRemove: "stacks:remove",
  stacksPolicyGet: "stacks:policyGet",
  stacksPolicySet: "stacks:policySet",
  stacksPolicyLayers: "stacks:policyLayers",
  /** 自动接活（工作流 N）。 */
  intakeView: "intake:view",
  intakeEffect: "intake:effect",
  intakePolicyGet: "intake:policyGet",
  intakePolicySet: "intake:policySet",
  intakeClassify: "intake:classify",
  intakePoll: "intake:poll",
  intakeAct: "intake:act",
  /** 「效果」页（ws-h）：和总控 metrics_overview 同一份。 */
  metricsView: "metrics:view",
  /** 信箱（BTL-245）：Shipherd 总控的或一个 feature 的消息（MessageScope），状态已排队 / 已送达 / 已回复。 */
  messagesList: "messages:list",
  memoryView: "memory:view",
  memoryWhy: "memory:why",
  memoryChanged: "memory:changed",
  /** 对话另存（UI 重做第 4 层）：一页对话、搜索、有新内容的推送（推的永远是链根）。 */
  convList: "conv:list",
  convSearch: "conv:search",
  convAppended: "conv:appended",
  /** 对话 tab（UI 重做第 5 层）：分叉讨论、发给开发 session、总控对话区的汇报分页；fork:changed 推的是链根。 */
  forkAsk: "fork:ask",
  forkSendConclusion: "fork:send-conclusion",
  forkReaskFull: "fork:reask-full",
  forkList: "fork:list",
  forkRemember: "fork:remember",
  convSend: "conv:send",
  inboxReports: "inbox:reports",
  forkChanged: "fork:changed",
  appAutostartGet: "app:autostartGet",
  appLanguage: "app:language",
  appAutostartSet: "app:autostartSet",
  appKeepAwakeGet: "app:keepAwakeGet",
  appKeepAwakeSet: "app:keepAwakeSet",
  appKeepAwakeChanged: "app:keepAwakeChanged",
  clipboardRead: "clipboard:read",
  clipboardWrite: "clipboard:write",
  // 自动化档位（BTL-247）：全局档位的显示（读）和 epic 自己选的档位（写）。全局档位本身走 settings:set。
  automationState: "automation:state",
  featuresSetAutomationLevel: "features:setAutomationLevel",
  // 更新提示（BTL-253）：状态（读）、手动检查、跳过这个版本、关闭提示条、在浏览器里打开 release 页。
  updateState: "update:state",
  updateCheck: "update:check",
  updateSkip: "update:skip",
  updateDismiss: "update:dismiss",
  updateOpenRelease: "update:openRelease",
  /** 应用菜单点了要界面做的事（BTL-253 / 254）：参数是 AppMenuAction。 */
  appMenu: "app:menu",
  /** 信箱（BTL-269）：用户在消息列表里点「现在送进去」：参数是消息 id，返回 DeliverNowResult。 */
  messagesDeliverNow: "messages:deliverNow",
  /** 信息流转（BTL-272）：抽出来的要点、原话、对同步的状态变化照做 / 不用 / 撤销 / 知道了。 */
  infoflowList: "infoflow:list",
  infoflowTurn: "infoflow:turn",
  infoflowAct: "infoflow:act",
} as const;

/** 渲染进程 → 主进程，有返回值（ipcRenderer.invoke）。 */
export const INVOKE_CHANNELS: readonly string[] = [
  IPC.ticketsList, IPC.ticketsGlance, IPC.ticketsCreate, IPC.ticketsSetStatus, IPC.ticketsClose, IPC.ticketsReopen, IPC.ticketsCloseRetry, IPC.ticketsClosePreview, IPC.ticketsArchive, IPC.ticketsSwitchBranch,
  IPC.ticketsUpdate, IPC.ticketsArchived, IPC.ticketsUnarchive, IPC.ticketsAddRepo, IPC.ticketsUpdateRepo, IPC.ticketsRemoveRepo,
  IPC.featuresList, IPC.featuresCreate, IPC.featuresRename, IPC.featuresAddRepo, IPC.featuresRemoveRepo, IPC.featuresArchive,
  IPC.featuresSummaryRun, IPC.featuresArchived, IPC.featuresUnarchive, IPC.featuresOpenSession, IPC.reposScan, IPC.ticketsRecheckCleanup,
  IPC.shipherdView, IPC.shipherdOpenSession, IPC.messagesList, IPC.metricsView,
  IPC.sessionsOpen, IPC.sessionsUnclaimed, IPC.sessionsUnclaimedCount, IPC.sessionsClaim, IPC.sessionsDismiss, IPC.sessionsHide, IPC.sessionsUnhide, IPC.sessionsRefresh, IPC.sessionsCloseIdle, IPC.sessionsDeleteHidden, IPC.sessionsPin, IPC.sessionsWake, IPC.sessionOpenFix, IPC.activityDismiss, IPC.usageSummary,
  IPC.ptySnapshot, IPC.ptySince, IPC.ptyKill, IPC.healthGet, IPC.healthInstallHooks, IPC.healthUninstallHooks, IPC.dialogPickDir,
  IPC.mergeEvents, IPC.prWatchList, IPC.prStages, IPC.prOpen, IPC.linkOpen, IPC.lessonsState, IPC.lessonsAct, IPC.lessonsRuns, IPC.lessonsRun, IPC.lessonsPending,
  IPC.lessonsBatches, IPC.lessonsBatch, IPC.policiesGet, IPC.policiesSet, IPC.checksView, IPC.checksHits, IPC.checksAct, IPC.checksDraft,
  IPC.baselinesView, IPC.baselinesAct, IPC.baselinesRules, IPC.baselinesSummary, IPC.legacyView, IPC.legacyAct, IPC.legacyViolations, IPC.checkExportList, IPC.checkExportAct, IPC.backtestView, IPC.backtestAct, IPC.configStatus, IPC.configExport, IPC.configImportPreview, IPC.configImportRetarget, IPC.admissionState, IPC.wizardEstimate, IPC.wizardAct, IPC.calibrationSample, IPC.calibrationStats, IPC.calibrationAct, IPC.principlesRegroup,
  IPC.configImportApply, IPC.configBackupNow, IPC.configOpenBackups, IPC.availabilityGet, IPC.availabilityAct, IPC.ciResend, IPC.routingView, IPC.routingAct, IPC.costView, IPC.costSet, IPC.costResume, IPC.costBreakers, IPC.backgroundStatus, IPC.backgroundAct, IPC.sessionsSwitchModel, IPC.sessionsDismissLimit, IPC.sessionsLimits, IPC.nowView, IPC.turnBoard, IPC.turnSendToAgent, IPC.turnHomeOpened, IPC.inboxList, IPC.inboxAnswer, IPC.inboxBehalf,
  IPC.followupsList, IPC.followupsSetStatus, IPC.handoffsList, IPC.handoffsRun, IPC.jobsRunNightly,
  IPC.settingsGet, IPC.settingsSet, IPC.settingsReset, IPC.settingsDetectTrackerTools, IPC.settingsFeaturePolicy, IPC.settingsPolicyPatch,
  IPC.externalAuditList,
  IPC.loopPolicyGet, IPC.loopPolicySet, IPC.loopCommentsList, IPC.loopCommentsAct, IPC.loopFlakyList, IPC.loopFlakyAct, IPC.loopEffect,
  IPC.interruptsState, IPC.interruptsAct, IPC.profilesGet, IPC.profilesScan,
  IPC.stacksList, IPC.stacksRebase, IPC.stacksLayerMode, IPC.stacksRestore, IPC.stacksRemove, IPC.stacksPolicyGet, IPC.stacksPolicySet, IPC.stacksPolicyLayers,
  IPC.intakeView, IPC.intakeEffect, IPC.intakePolicyGet, IPC.intakePolicySet, IPC.intakeClassify, IPC.intakePoll, IPC.intakeAct,
  IPC.prAssessment, IPC.preReviewRun, IPC.briefRegenerate, IPC.briefPost, IPC.prPolicyGet, IPC.prPolicySet, IPC.reviewEffect, IPC.reviewQueue,
  IPC.preReviewStatus, IPC.preReviewQueue, IPC.preReviewQueueAct,
  IPC.memoryView, IPC.memoryWhy, IPC.memUsageHistory, IPC.convList, IPC.convSearch,
  IPC.forkAsk, IPC.forkSendConclusion, IPC.forkReaskFull, IPC.forkList, IPC.forkRemember, IPC.convSend, IPC.inboxReports,
  IPC.appAutostartGet, IPC.appAutostartSet, IPC.appKeepAwakeGet, IPC.appKeepAwakeSet, IPC.appLanguage, IPC.clipboardRead, IPC.clipboardWrite,
  IPC.automationState, IPC.featuresSetAutomationLevel,
  IPC.updateState, IPC.updateCheck, IPC.updateSkip, IPC.updateDismiss, IPC.updateOpenRelease,
  IPC.diagSnapshot, IPC.diagExport,
  IPC.feedbackOpen, IPC.feedbackDiagPreview, IPC.feedbackDiagSave,
  IPC.messagesDeliverNow,
  IPC.infoflowList, IPC.infoflowTurn, IPC.infoflowAct,
];
/** 渲染进程 → 主进程，单向高频（键盘输入、尺寸变化）。 */
export const SEND_CHANNELS: readonly string[] = [IPC.ptyWrite, IPC.ptyResize, IPC.ptyVisible, IPC.ptyDetach, IPC.diagRenderer];
/** 主进程 → 渲染进程。 */
export const EVENT_CHANNELS: readonly string[] = [IPC.ptyData, IPC.ptyExit, IPC.stateChanged, IPC.activityEvent, IPC.memoryChanged, IPC.appKeepAwakeChanged, IPC.convAppended, IPC.turnChanged, IPC.forkChanged, IPC.appMenu];

export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
