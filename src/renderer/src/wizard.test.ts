import { describe, expect, it } from "vitest";
import type { HealthReport } from "../../shared/types";
import { canAdvance, needsOnboarding, nextStep, onboardingReducer, type OnboardingState, prevStep, stepNumber, WIZARD_STEPS } from "./wizard";

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

describe("onboarding state (App-level decision)", () => {
  const start = null as OnboardingState;
  it("is unknown until the first settings read, then follows onboardingDone", () => {
    expect(onboardingReducer(start, { type: "loaded", settings: { onboardingDone: "0" } })).toBe(true);
    expect(onboardingReducer(start, { type: "loaded", settings: { onboardingDone: "1" } })).toBe(false);
  });
  it("fails open to the wizard when the initial read fails", () => {
    expect(onboardingReducer(start, { type: "loadFailed" })).toBe(true);
  });
  it("rerun shows the wizard at once and finish hides it", () => {
    expect(onboardingReducer(false, { type: "rerun" })).toBe(true);
    expect(onboardingReducer(true, { type: "finished" })).toBe(false);
  });
  it("a late initial read never overrides rerun or finish", () => {
    expect(onboardingReducer(true, { type: "loaded", settings: { onboardingDone: "1" } })).toBe(true);
    expect(onboardingReducer(false, { type: "loaded", settings: { onboardingDone: "0" } })).toBe(false);
    expect(onboardingReducer(false, { type: "loadFailed" })).toBe(false);
  });
  it("treats an unexpected value as not done", () => {
    expect(needsOnboarding({ onboardingDone: "" })).toBe(true);
  });
});
