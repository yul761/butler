import { describe, expect, it } from "vitest";
import type { HealthReport } from "../../shared/types";
import { canAdvance, needsOnboarding, nextStep, prevStep, stepNumber, WIZARD_STEPS } from "./wizard";

const report = (claude: Partial<HealthReport["claude"]>): HealthReport => ({
  claude: { path: "/usr/local/bin/claude", version: "2.1.306", flags: {}, missingFlags: [], error: null, ...claude },
  hooks: "missing",
  hookBinInstalled: false,
  handoffCommand: "missing",
  butlerHome: "/h/.butler",
  claudeSettingsPath: "/h/.claude/settings.json",
  memory: { enabled: true, dataDir: "/h/.butler/statecore", mcpBundle: true, statecorePlugin: false },
});

describe("first-run wizard (design 9, 10)", () => {
  it("walks the steps in the design's order", () => {
    expect(WIZARD_STEPS).toEqual(["claude", "hooks", "tracker", "privacy", "done"]);
    expect(nextStep("claude")).toBe("hooks");
    expect(nextStep("done")).toBe("done");
    expect(prevStep("hooks")).toBe("claude");
    expect(prevStep("claude")).toBe("claude");
    expect(stepNumber("claude")).toEqual({ n: 1, total: 4 });
    expect(stepNumber("privacy")).toEqual({ n: 4, total: 4 });
  });

  it("blocks the first step until a working claude is found", () => {
    expect(canAdvance("claude", null)).toBe(false);
    expect(canAdvance("claude", report({ path: null, error: "claude_not_found" }))).toBe(false);
    expect(canAdvance("claude", report({ error: "spawn failed" }))).toBe(false);
    expect(canAdvance("claude", report({}))).toBe(true);
    // 其余步骤都可以先跳过。
    for (const s of ["hooks", "tracker", "privacy"] as const) expect(canAdvance(s, null)).toBe(true);
    expect(canAdvance("done", report({}))).toBe(false);
  });

  it("shows the wizard only once settings are loaded and onboarding is not done", () => {
    expect(needsOnboarding(null)).toBe(false);
    expect(needsOnboarding({ onboardingDone: "0" })).toBe(true);
    expect(needsOnboarding({ onboardingDone: "1" })).toBe(false);
  });
});

describe("re-running the wizard from settings", () => {
  it("shows the wizard again as soon as a state-changed refresh reads onboardingDone=0", () => {
    // App.refresh 在每次 state-changed 通知后重新读设置并调用 needsOnboarding。
    const reads = [{ onboardingDone: "1" }, { onboardingDone: "0" }, { onboardingDone: "1" }];
    expect(reads.map(needsOnboarding)).toEqual([false, true, false]);
  });
  it("treats an unexpected value as not done", () => {
    expect(needsOnboarding({ onboardingDone: "" })).toBe(true);
  });
});

describe("re-running the wizard from settings", () => {
  it("shows the wizard again as soon as a state-changed refresh reads onboardingDone=0", () => {
    // App.refresh 在每次 state-changed 通知后重新读设置并调用 needsOnboarding。
    const reads = [{ onboardingDone: "1" }, { onboardingDone: "0" }, { onboardingDone: "1" }];
    expect(reads.map(needsOnboarding)).toEqual([false, true, false]);
  });
  it("treats an unexpected value as not done", () => {
    expect(needsOnboarding({ onboardingDone: "" })).toBe(true);
  });
});
