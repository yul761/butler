import { DEFAULT_HANDOFF_PROMPT, DEFAULT_REFRESH_PROMPT } from "../handoff/templates";
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
  blockedDays: "2",
  reviewWaitDays: "2",
  staleDays: "5",
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
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: SettingKey): string {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
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
