import type { EditableSettings } from "../../shared/settings";
import type { HealthReport } from "../../shared/types";

/** 设计文档第 9 节的顺序：自检 claude → hook 和 /handoff → tracker MCP → 隐私档位与个人 API → 完成。 */
export const WIZARD_STEPS = ["claude", "hooks", "tracker", "privacy", "done"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** 第一步必须找到能用的 claude（设计文档第 10 节）；其余步骤都可以先跳过，之后在设置页补。 */
export function canAdvance(step: WizardStep, report: HealthReport | null): boolean {
  if (step === "claude") return !!report?.claude.path && report.claude.error === null;
  return step !== "done";
}

export function nextStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.min(WIZARD_STEPS.indexOf(step) + 1, WIZARD_STEPS.length - 1)];
}

export function prevStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.max(WIZARD_STEPS.indexOf(step) - 1, 0)];
}

/** 第几步 / 共几步（完成页不算）。 */
export function stepNumber(step: WizardStep): { n: number; total: number } {
  const total = WIZARD_STEPS.length - 1;
  return { n: Math.min(WIZARD_STEPS.indexOf(step) + 1, total), total };
}

/** 设置读出来了、而且向导还没做完（或被设置页要求重新运行）。 */
export function needsOnboarding(settings: Pick<EditableSettings, "onboardingDone"> | null): boolean {
  return settings !== null && settings.onboardingDone !== "1";
}

/** 是否显示向导：null = 还没读到设置（先不渲染任何页面，避免新用户看到简报闪一下）。 */
export type OnboardingState = boolean | null;
export type OnboardingEvent =
  | { type: "loaded"; settings: Pick<EditableSettings, "onboardingDone"> }
  | { type: "loadFailed" }
  | { type: "rerun" }
  | { type: "finished" };

/**
 * 只在启动时读一次设置；之后只由“重新运行”和“完成/跳过”改变。
 * 读取失败时倾向显示向导（宁可多问一次，也不让新用户落在一个没配置好的界面）。
 * 初次读取的结果不会覆盖更早发生的 rerun / finished。
 */
export function onboardingReducer(state: OnboardingState, ev: OnboardingEvent): OnboardingState {
  switch (ev.type) {
    case "loaded":
      return state === null ? needsOnboarding(ev.settings) : state;
    case "loadFailed":
      return state === null ? true : state;
    case "rerun":
      return true;
    case "finished":
      return false;
  }
}
