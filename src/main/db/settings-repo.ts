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
  handoffPrompt: DEFAULT_HANDOFF_PROMPT,
  refreshPrompt: DEFAULT_REFRESH_PROMPT,
  /** 个人 API 的隐私档位：off | metadata | redacted | full（设计文档 7.3，默认 metadata）。 */
  llmLevel: "metadata",
  /** OpenAI 兼容接口的 base URL，例如 https://api.deepseek.com/v1。空表示没有配置（等同 off）。 */
  llmBaseUrl: "",
  llmModel: "",
  /** 每月预算（美元）。 */
  llmMonthlyBudgetUsd: "1",
  /**
   * 价格表：每行“模型（可用 * 通配） 输入价 输出价”，单位是美元 / 百万 token，从上往下第一条匹配的生效。
   * 默认把任何模型都按很贵的价格算：宁可少调用，也不超支。
   */
  llmPrices: "* 15 75",
  /** 发送前确认：1 开 0 关。 */
  llmConfirm: "0",
  /** 审计记录保留天数（设计文档 7.7，默认 90）。 */
  auditRetentionDays: "90",
  /** 首次启动向导做完（或跳过）了：1。迁移 4 给已经有 ticket 的老用户直接写 1。 */
  onboardingDone: "0",
  /** StateCore 记忆（设计文档第 8 节）：1 开 0 关。关闭时不写入、不给 claude 挂记忆 MCP。 */
  memoryEnabled: "1",
  /** 上下文（最近一轮的 token 数）超过这么多时自动换新 session（计划 16）；0 = 关。手动和总控触发不看它。 */
  refreshThresholdTokens: "150000",
  /**
   * Butler 的 session 停下超过这么多分钟、没有要你决定的事，就写 handoff、结束终端并隐藏（BTL-190 第 8 点）；0 = 关。
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
  /** 每天几点让 Butler 总控巡检一次（BTL-190 第 5 点），HH:MM；空 = 关（默认）。 */
  butlerPatrolTime: "",
  /** 界面和提示词的语言：auto | zh | en（设计文档 2026-10-26）。迁移 7 给老用户写 zh。 */
  language: "auto",
  /** 准入策略的版本：每次改策略（任一层）加一，评分时写进 score_policy_version。不在设置页上。 */
  admissionPolicyVersion: "1",
  /** 每隔几天自动备份一次全部配置到 <BUTLER_HOME>/backups（契约 4.3）；0 = 关（默认）。 */
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
  /** 定时清理 Butler 自己的 session 留下的孤儿进程（WS-M F）：1 开 0 关。 */
  orphanCleanup: "1",
  /** claude 进程的内存超过这么多 MB 就在下一个空闲点换新（WS-M G）；0 = 关。 */
  refreshMemoryMb: "2048",
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
  /** 共享 MCP（WS-M H）：所有 session 的 Butler 记忆和 butler-sessions 由一个 hub 进程经本机回环 HTTP 提供，不再每个 session 各起一组。1 开 0 关（默认关）。 */
  sharedMcp: "0",
  /** 对外动作（契约 4.8，ws-b）：每种一个开关，1 开 0 关，默认全关。见 src/main/external/actions.ts。 */
  externalCommentReply: "0",
  externalCommentResolve: "0",
  externalPrDescriptionEdit: "0",
  externalPrLabel: "0",
  externalPrOpen: "0",
  externalPrTitleEdit: "0",
  externalForcePush: "0",
  externalCiRerun: "0",
  externalIssuePost: "0",
  externalPushNotification: "0",
  /** 工作流 D：一次分析加了或命中了规矩以后自动判那个仓库（只推荐，除非 admission.autoConfirm）：1 开 0 关。 */
  lessonsAutoAdmit: "0",
  /** 工作流 D：每天把已确认的规矩归成原则，session 说明里写原则 + 案例文件：1 开 0 关。 */
  lessonsPrinciples: "0",
  /** 工作流 D：session 说明最多保留 10 条核心规矩：1 开 0 关。 */
  lessonsCoreGuide: "0",
  /** 校准页「标为已校准」的时间（毫秒，字符串）；空 = 没校准过（策略页显示「未校准的默认值」）。不在设置页上。 */
  admissionCalibratedAt: "",
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
