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
  blockedDays: "2",
  reviewWaitDays: "2",
  staleDays: "5",
  handoffPrompt: DEFAULT_HANDOFF_PROMPT,
  refreshPrompt: DEFAULT_REFRESH_PROMPT,
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
