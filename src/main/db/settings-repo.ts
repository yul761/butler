import { DEFAULT_HANDOFF_PROMPT, DEFAULT_REFRESH_PROMPT, defaultHandoffPrompt, defaultRefreshPrompt, PREVIOUS_HANDOFF_PROMPTS, PREVIOUS_REFRESH_PROMPTS } from "../handoff/templates";
import { currentLang } from "../i18n";
import type { Lang } from "../../shared/i18n";
import type { Db } from "./database";

export const SETTING_DEFAULTS = {
  branchTemplate: "feature/{key}",
  ticketPattern: "[A-Z][A-Z0-9]+-\\d+",
  claudePath: "",
  /** 晚间 handoff 的时间（本地，HH:MM）。 */
  nightlyTime: "16:00",
  /** 工作日，JS getDay()：0 = 周日。 */
  workingDays: "1,2,3,4,5",
  /** handoff 允许调用的 tracker MCP 工具，一行一个。 */
  trackerTools: "",
  /** 后台 handoff / 刷新 / 探测也挂上仓库 .mcp.json（已批准的）和本地级的 MCP：1 开 0 关。 */
  headlessProjectMcp: "0",
  /** 开始记 skill 事件的时间（毫秒，字符串）；空表示还没开始。PR 进度据此区分「没记」和「没做」。 */
  skillTrackingSince: "",
  /** 开始记度量（ws-h）的时间（毫秒，字符串）；空表示还没开始。基线截止点和「从什么时候起有人介入数据」看它。 */
  metricsSince: "",
  /** 「效果」页基线的截止点（ws-h）：第一个 Shipherd session 的创建时间，第一次看到时存下，之后不变；空表示还没有。 */
  metricsBaselineCutoff: "",
  handoffPrompt: DEFAULT_HANDOFF_PROMPT,
  refreshPrompt: DEFAULT_REFRESH_PROMPT,
  /** 对外动作审计的保留天数（默认 90）。 */
  auditRetentionDays: "90",
  /** 首次启动向导做完（或跳过）了：1。迁移 4 给已经有 ticket 的老用户直接写 1。 */
  onboardingDone: "0",
  /** StateCore 记忆（设计文档第 8 节）：1 开 0 关。关闭时不写入、不给 claude 挂记忆 MCP。 */
  memoryEnabled: "1",
  /** 上下文（最近一轮的 token 数）超过这么多时自动换新 session（计划 16）；0 = 关。手动和总控触发不看它。 */
  refreshThresholdTokens: "150000",
  /**
   * Shipherd 的 session 停下超过这么多分钟、没有要你决定的事，就写 handoff、结束终端并隐藏（BTL-190 第 8 点）；0 = 关。
   * 「清理闲置」按钮不看它。
   */
  idleCloseMinutes: "180",
  /**
   * 总控开新 session 前按内存放行（工作流 W）：开完以后至少还要剩这么多 MB 可用内存。
   * 空 = 自动（默认）：物理内存的 10%，限在 512 到 2048 MB 之间（autoReserveMb）。
   */
  sessionMemoryReserveMb: "",
  /** 没有实测时，一个新 session（Claude 加它的 MCP server 和子进程）预计占多少 MB。 */
  sessionMemoryEstimateMb: "1024",
  /** 同时开着的终端最多几个，只当保险；0 = 不限（默认，只看内存）。 */
  sessionMaxRunning: "0",
  /** 每天几点让 Shipherd 总控巡检一次（BTL-190 第 5 点），HH:MM；空 = 关（默认）。 */
  shipherdPatrolTime: "",
  /** 界面和提示词的语言：auto | zh | en（设计文档 2026-10-26）。迁移 7 给老用户写 zh。 */
  language: "auto",
  /** 请你 review 的查询：all = 账号能看到的所有仓库，registered = 只看 Shipherd 登记过的（UI 重做第 1 层）。 */
  reviewRequestScope: "all",
  /** 准入策略的版本：每次改策略（任一层）加一，评分时写进 score_policy_version。不在设置页上。 */
  admissionPolicyVersion: "1",
  /** 每隔几天自动备份一次全部配置到 <SHIPHERD_HOME>/backups（契约 4.3）；0 = 关（默认）。 */
  configBackupIntervalDays: "0",
  /** 自动备份留几个（最新的）。 */
  configBackupKeep: "10",
  /** 多少天没导出也没备份就提醒一次；0 = 不提醒。 */
  configExportReminderDays: "30",
  /** 上次手动导出的时间（毫秒，字符串）；空 = 从没导出过。不在设置页上。 */
  configLastExportAt: "",
  /** 确定性检查（契约 4.5）的总开关：1 开 0 关。关掉后编辑和 push 时都不检查。 */
  checksEnabled: "1",
  /** 一次编辑的检查最多用几秒（1–30）；hook 自己的超时是它加 3。 */
  checksEditTimeoutSec: "8",
  /** push 前的检查最多用几秒（10–3600）。 */
  checksPushTimeoutSec: "600",
  /** 仓库现状扫描（工作流 E2）：标记文件和 CI 都认不出时，让 claude 只读地看一遍补上（auto）；off = 不调模型。 */
  baselineInfer: "auto",
  /** 配置文件改过后，开 session 时在后台重扫（只跑不调模型的两层）：1 开 0 关。 */
  baselineAutoRescan: "1",
  /** session guide 里一个仓库的档案最多几个字符（200–4000）。 */
  baselineGuideChars: "1200",
  /** 一次存量扫描最多看几个文件（100–500000），超了记成截断。 */
  legacyScanMaxFiles: "50000",
  /** 模型路由（3.0）：每月配额，JSON 数组 [{ target: "tier:high" | "model:<名字>", unit: "usd" | "tokens", monthly }]；空 = 不限。 */
  routingQuotas: "",
  /** 配额的两个软阈值（百分比，逗号分隔）：到第一个时低价值任务降档，到第二个时只有关键任务用高档。 */
  routingThresholds: "70,90",
  /** 配额周期从每月几号开始（1–28，本地时间）。 */
  routingPeriodStartDay: "1",
  /** 推理强度：JSON 对象，键是任务 id 或档位（high / mid / low），值是 low / medium / high / xhigh / max；空 = 用 CLI 默认。 */
  routingEffort: "",
  /** 每档同时最多几个后台调用：JSON 对象 { "high": 1 }；空 = 不限。 */
  routingMaxConcurrent: "",
  /** 交互 session 撞限时自动切到下一档并继续：1 开 0 关（默认关，只在 session 行上给按钮）。 */
  routingAutoSwitch: "0",
  /** 每分钟采样一次每个 session 的进程树内存（WS-M A）：1 开 0 关。只读，不改任何进程。 */
  memoryMonitor: "1",
  /** 看不见又停着的 session 的进程树降到后台优先级（WS-M E）：1 开 0 关（默认关，先观察）。 */
  backgroundPriority: "0",
  /** 定时清理 Shipherd 自己的 session 留下的孤儿进程（WS-M F）：1 开 0 关。 */
  orphanCleanup: "1",
  /** claude 进程的内存超过这么多 MB 就在下一个空闲点换新（WS-M G）；0 = 关。 */
  refreshMemoryMb: "0",
  /** 停着的 session 过一阵就休眠（WS-M B）：结束 claude 进程，有事要递时再 --resume。1 开 0 关（默认关）。 */
  hibernateEnabled: "0",
  /** 在等你（需要你、有没回答的 ask_user）多少分钟后休眠；0 = 这种不休眠。 */
  hibernateYouMinutes: "30",
  /** 在等 CI（PR 的 CI 在跑、排在合并总控里）多少分钟后休眠；0 = 不休眠。 */
  hibernateCiMinutes: "20",
  /** 在等 review（PR 开着、CI 跑完、还没批准）多少分钟后休眠；0 = 不休眠。 */
  hibernateReviewMinutes: "30",
  /** 别的停着的多少分钟后休眠；0 = 不休眠。 */
  hibernateIdleMinutes: "60",
  /** 休眠时一起结束它起的 watcher 和 dev server（WS-M I）：1 是，0 留着（唤醒或结束时再清）。 */
  hibernateEndWatchers: "1",
  /** 系统可用内存低于下面的比例时，每次采样休眠一个闲着最久的 session（WS-M C）：1 开 0 关（默认关）。不需要打开 hibernateEnabled。 */
  memoryPressureEnabled: "0",
  /** 内存紧张的线：可用内存低于百分之几（1–50）。回到这条线以上 5 个点才停。 */
  memoryPressureFreePercent: "10",
  /** 共享 MCP（WS-M H）：所有 session 的 Shipherd 记忆和 shipherd-sessions 由一个 hub 进程经本机回环 HTTP 提供，不再每个 session 各起一组。1 开 0 关（默认关）。 */
  sharedMcp: "0",
  /** 对外动作（契约 4.8，ws-b）：每种一个开关，1 开 0 关，默认全关。见 src/main/external/actions.ts。 */
  externalCommentReply: "0",
  externalCommentResolve: "0",
  externalPrDescriptionEdit: "0",
  externalPrLabel: "0",
  externalPrOpen: "0",
  externalBranchPush: "0",
  externalPrTitleEdit: "0",
  externalForcePush: "0",
  externalCiRerun: "0",
  externalIssuePost: "0",
  externalPushNotification: "0",
  /** 工作流 G：预审完成后自动把 review 简报贴进 PR 描述。 */
  externalPrBriefPost: "0",
  /** 工作流 N：自动接活缺信息时到 tracker 上提问；开工时把 ticket 改成进行中。 */
  externalIntakeTrackerComment: "0",
  externalIntakeTrackerStatus: "0",
  /** BTL-273：工作流程里 Shipherd 替 session 请 Copilot / Codex review。关着时提醒 session 自己请。 */
  externalPrReviewRequest: "0",
  /** 工作流 G：开发 session 交证据、提 PR 前后台预审（复跑、对照规矩、核对证据），结果送回 session：1 开 0 关。 */
  preReviewEnabled: "0",
  /** 工作流 D：一次分析加了或命中了规矩以后自动判那个仓库（只推荐，除非 admission.autoConfirm）：1 开 0 关。 */
  lessonsAutoAdmit: "0",
  /** 工作流 D：每天把已确认的规矩归成原则，session 说明里写原则 + 案例文件：1 开 0 关。 */
  lessonsPrinciples: "0",
  /** 工作流 D：session 说明最多保留 10 条核心规矩：1 开 0 关。 */
  lessonsCoreGuide: "0",
  /** 校准页「标为已校准」的时间（毫秒，字符串）；空 = 没校准过（策略页显示「未校准的默认值」）。不在设置页上。 */
  admissionCalibratedAt: "",
  /** 原则上一次每日重新分组的时间（毫秒）；重启以后也不会当天再分一次。 */
  lessonsPrinciplesRegroupedAt: "",
  /** 工作流 F：上一次阈值复查的时间（毫秒）；复查按 review.intervalDays 隔开。不在设置页上。 */
  backtestThresholdReviewAt: "",
  /** 后台任务（工作流 L）什么时候跑：anytime（随时，默认）、idle（只在空闲时）、hours（只在 bgHours 里）、idle_or_hours。 */
  bgWindow: "anytime",
  /** 后台任务可以跑的小时（本地时间，可以跨午夜，逗号分开写几段）。 */
  bgHours: "22:00-07:00",
  /** 系统多少分钟没有键鼠输入算空闲（锁屏马上算）。 */
  bgIdleMinutes: "10",
  /** 该让路时：finish（跑着的跑完）或 interrupt（可打断的马上停、放回队列）。 */
  bgYield: "finish",
  /** 额度紧张时：pause_first（先停低优先级后台任务）或 downgrade_first（先交给路由器降档）。 */
  bgQuotaOrder: "pause_first",
  /** 每个配额都用了不到百分之几时算额度充裕，后台任务不看时段；空 = 不用。 */
  bgPlentifulPercent: "",
  /** 每种后台任务的优先级、时段、停用：JSON 对象 { "backtest": { "priority": "low", "window": "idle", "paused": true } }。 */
  bgKinds: "",
  /** 工作流 J：确认过的权限档案规则写进 session 的 --settings：1 开 0 关。没确认过规则时和 2.1.0 一样。 */
  permissionProfiles: "1",
  /** 工作流 J：session 说明里加「没特别理由就选推荐项，用 report(kind: choice) 记下」：1 开 0 关。 */
  interruptChoiceRule: "0",
  /** 工作流 J：选择题按用户设的默认答案自动答：1 开 0 关。 */
  interruptChoiceDefaults: "0",
  /** 工作流 J：session 说明里加「缺信息先自己查（ticket、代码、记忆、总控），查不到再问」：1 开 0 关。 */
  interruptSelfServe: "0",
  /** 工作流 J：外部通知的格式：json（聊天工具的 webhook）或 ntfy。开关是 externalPushNotification。 */
  notifyFormat: "json",
  /** 工作流 J：推哪些事件，逗号分隔。 */
  notifyEvents: "decision_needed,pr_high_risk,pr_ready,cost_breaker,review_comment,intake_decision",
  /** 工作流 J：通知里带上 ticket 号和 PR 号：1 开 0 关（默认只有事件种类和数量）。 */
  notifyDetails: "0",
  /** 工作流 J：安静时段 HH:MM-HH:MM（本地时间，可以跨午夜）；空 = 没有。这段时间里的事件不推。 */
  notifyQuietHours: "",
  /** 工作流 J：第一次有减少打断的功能生效的时间（毫秒）；Effect 页前后对比的分界。不在设置页上。 */
  interruptReductionSince: "",
  /** 工作流 N：自动接活从哪拉 ticket：none（不拉，默认）、tracker（经 intake_fetch 用 trackerTools）、file（读 intakeFilePath 的 JSON）。 */
  intakeSource: "none",
  /** 工作流 N：tracker 来源的查询（自然语言或 tracker 自己的查询语法），比如「分配给我、待办的」。 */
  intakeTrackerQuery: "",
  /** 工作流 N：拉 tracker 时在哪个目录跑（tracker MCP 配在那里）；空 = 仓库映射里的第一个仓库。 */
  intakeTrackerDir: "",
  /** 工作流 N：file 来源的 JSON 文件（绝对路径）。 */
  intakeFilePath: "",
  /** 工作流 N：多少分钟拉一次（5–1440）。 */
  intakePollMinutes: "15",
  /** 工作流 N：ticket → 仓库，一行一条 `匹配 => 绝对路径`（见 src/main/intake/sources.ts 的 parseRepoMap）。 */
  intakeRepoMap: "",
  /** 4.0（BTL-244）：显示 Shipherd 之外开的 session（未认领）。默认关：关着时完全不扫描 ~/.claude/projects 去发现它们。 */
  showOutsideSessions: "0",
  /** 4.0（BTL-247）：全局自动化档位，manual | semi。默认手动 = 4.0 以前的默认；每个 epic 可以另选（features.automation_level）。 */
  automationLevel: "manual",
  /** BTL-253：每天最多一次经你的 gh 查 GitHub 上有没有新版本，有就在顶部提示（只提示，不下载）。只读，默认开（「新行为默认关」的例外）。 */
  updateCheckEnabled: "1",
  /** BTL-253：上次检查更新的时间（毫秒）；空 = 没查过。不在设置页上。 */
  updateLastCheckAt: "",
  /** BTL-253：上次查到的、比当前新的 release（JSON，ReleaseInfo）；空 = 没有。不在设置页上。 */
  updateLatest: "",
  /** BTL-253：「跳过这个版本」跳过的版本号；空 = 没跳过。不在设置页上。 */
  updateSkippedVersion: "",
  /** BTL-256：重启后自动恢复之前在工作的 session（总控管的）。默认关。 */
  autoResumeAfterRestart: "0",
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

type PromptKey = "handoffPrompt" | "refreshPrompt";
const PROMPT_DEFAULTS: Record<PromptKey, (l: Lang) => string> = { handoffPrompt: defaultHandoffPrompt, refreshPrompt: defaultRefreshPrompt };
const LANGS: Lang[] = ["zh", "en"];
/** 以前版本的默认值：存的是它们也当作没改过。 */
const PREVIOUS_PROMPT_DEFAULTS: Record<PromptKey, readonly string[]> = { handoffPrompt: PREVIOUS_HANDOFF_PROMPTS, refreshPrompt: PREVIOUS_REFRESH_PROMPTS };

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: SettingKey): string {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    const lang = PROMPT_DEFAULTS[key as PromptKey];
    if (lang) {
      // 提示词跟着语言走（设计文档 2026-10-26）：没存过，或者存的就是某种语言的默认值（没改过，包括以前版本的默认值），都给当前语言的默认值。
      const v = row?.value;
      const unchanged = v === undefined || LANGS.some((l) => lang(l) === v) || PREVIOUS_PROMPT_DEFAULTS[key as PromptKey].includes(v);
      return unchanged ? lang(currentLang()) : (v as string);
    }
    return row?.value ?? SETTING_DEFAULTS[key];
  }

  set(key: SettingKey, value: string): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  /** 删除覆盖值，回到默认。 */
  reset(key: SettingKey): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }
}
