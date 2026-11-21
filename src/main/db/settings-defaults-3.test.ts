import { describe, expect, it } from "vitest";
import { ADMISSION_POLICY_DEFAULTS } from "../../shared/admission-policy";
import { COST_POLICY_DEFAULTS } from "../../shared/cost";
import { EXTERNAL_ACTION_SETTINGS } from "../../shared/external";
import { INTAKE_POLICY_DEFAULTS } from "../../shared/intake";
import { LOOP_POLICY_DEFAULTS } from "../../shared/loop-policy";
import { STACK_POLICY_DEFAULTS } from "../../shared/stacks";
import { SETTING_DEFAULTS } from "./settings-repo";

/**
 * 工作流 R（总设计第 2、8 节）：什么都不配置的用户看到的是 2.1.0 的行为。3.0.0 里每个会自己动起来的新功能，
 * 总开关默认关；每个对外动作默认关。这里把它们一次钉住，以后谁改了默认值会在这里挂。
 */
describe("3.0.0 defaults: nothing new acts on its own", () => {
  it("keeps every outward action off", () => {
    for (const key of Object.values(EXTERNAL_ACTION_SETTINGS)) expect(SETTING_DEFAULTS[key], key).toBe("0");
  });

  it("keeps every new master switch off", () => {
    for (const key of [
      "routingAutoSwitch", "backgroundPriority", "hibernateEnabled", "memoryPressureEnabled", "sharedMcp",
      "refreshMemoryMb", "preReviewEnabled", "lessonsAutoAdmit", "lessonsPrinciples", "lessonsCoreGuide",
      "interruptChoiceRule", "interruptChoiceDefaults", "interruptSelfServe", "notifyDetails", "configBackupIntervalDays",
      "sessionMaxRunning", "showOutsideSessions",
    ] as const) expect(SETTING_DEFAULTS[key], key).toBe("0");
    expect(SETTING_DEFAULTS.routingQuotas).toBe("");
    expect(SETTING_DEFAULTS.intakeSource).toBe("none");
    expect(SETTING_DEFAULTS.bgWindow).toBe("anytime");
    // 4.0（BTL-247）：全局档位默认手动。
    expect(SETTING_DEFAULTS.automationLevel).toBe("manual");
  });

  it("keeps every new policy's own switch off", () => {
    expect(LOOP_POLICY_DEFAULTS["comments.enabled"]).toBe(false);
    expect(LOOP_POLICY_DEFAULTS["ci.enabled"]).toBe(false);
    expect(STACK_POLICY_DEFAULTS.autoRebase).toBe(false);
    expect(INTAKE_POLICY_DEFAULTS.enabled).toBe(false);
    expect(ADMISSION_POLICY_DEFAULTS["shadow.autoPromote"]).toBe(false);
    expect(ADMISSION_POLICY_DEFAULTS["admission.autoConfirm"]).toBe(false);
    expect(ADMISSION_POLICY_DEFAULTS["conflict.autoPickHigherHits"]).toBe(false);
    expect(COST_POLICY_DEFAULTS.sessionCap).toBeNull();
    expect(COST_POLICY_DEFAULTS.ticketCap).toBeNull();
  });
});
