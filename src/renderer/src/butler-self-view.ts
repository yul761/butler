/** 审计里一条记录都没有（模型调用和对外动作都是 0）。 */
export function auditIsEmpty(a: { llmEntries: number; externalEntries: number }): boolean {
  return a.llmEntries === 0 && a.externalEntries === 0;
}

/** 效果页的 tab，按显示顺序。 */
export const EFFECT_TABS = ["overview", "trend", "spend", "rework", "automation"] as const;
export type EffectTabId = (typeof EFFECT_TABS)[number];
