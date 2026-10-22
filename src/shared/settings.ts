/** 渲染进程可以读写的设置。 */
export const EDITABLE_SETTINGS = [
  "nightlyTime",
  "workingDays",
  "trackerTools",
  "headlessProjectMcp",
  "blockedDays",
  "reviewWaitDays",
  "staleDays",
  "handoffPrompt",
  "refreshPrompt",
  "llmLevel",
  "llmBaseUrl",
  "llmModel",
  "llmMonthlyBudgetUsd",
  "llmPrices",
  "llmConfirm",
  "auditRetentionDays",
  "claudePath",
  "branchTemplate",
  "ticketPattern",
  "memoryEnabled",
  "onboardingDone",
] as const;

export type EditableSettingKey = (typeof EDITABLE_SETTINGS)[number];
export type EditableSettings = Record<EditableSettingKey, string>;

export function isEditableSetting(key: string): key is EditableSettingKey {
  return (EDITABLE_SETTINGS as readonly string[]).includes(key);
}
