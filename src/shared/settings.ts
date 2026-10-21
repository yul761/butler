/** 渲染进程可以读写的设置。其余设置（claudePath、branchTemplate 等）由计划 4 的设置页处理。 */
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
] as const;

export type EditableSettingKey = (typeof EDITABLE_SETTINGS)[number];
export type EditableSettings = Record<EditableSettingKey, string>;

export function isEditableSetting(key: string): key is EditableSettingKey {
  return (EDITABLE_SETTINGS as readonly string[]).includes(key);
}
