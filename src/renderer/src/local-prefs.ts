import { WIZARD_STEPS, type WizardStep } from "./wizard";

/**
 * 只属于这台机器、这个窗口的小记忆（localStorage）：向导停在哪一步、是不是跳过了向导。
 * 读写都可能失败（存储被禁用），失败时当作没有记录。
 */
const STEP_KEY = "butler.wizardStep";
const SKIPPED_KEY = "butler.wizardSkipped";

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 存不下就算了。
  }
}

export const savedWizardStep = (): WizardStep | null => {
  const v = get(STEP_KEY);
  return (WIZARD_STEPS as readonly string[]).includes(v ?? "") ? (v as WizardStep) : null;
};
export const saveWizardStep = (step: WizardStep | null) => set(STEP_KEY, step);
export const wizardSkipped = () => get(SKIPPED_KEY) === "1";
export const setWizardSkipped = (on: boolean) => set(SKIPPED_KEY, on ? "1" : null);
