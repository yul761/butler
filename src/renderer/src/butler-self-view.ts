/** 审计里一条对外动作的记录都没有。 */
export function auditIsEmpty(externalEntries: number): boolean {
  return externalEntries === 0;
}

/** 效果页的 tab，按显示顺序。 */
export const EFFECT_TABS = ["overview", "trend", "spend", "rework", "automation"] as const;
export type EffectTabId = (typeof EFFECT_TABS)[number];
