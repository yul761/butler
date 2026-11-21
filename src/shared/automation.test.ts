import { describe, expect, it } from "vitest";
import {
  AUTOMATION_PRESETS, automationDisplay, externalOverride, GOVERNED_SETTINGS, isAutomationLevel, overlayIntake, overlayLoop, overlayStack, preReviewOn, presetLayer, stackLevel,
  type GovernedCurrent,
} from "./automation";
import { INTAKE_POLICY_DEFAULTS } from "./intake";
import { LOOP_POLICY_DEFAULTS } from "./loop-policy";
import { STACK_POLICY_DEFAULTS } from "./stacks";

const offSettings = Object.fromEntries(GOVERNED_SETTINGS.map((k) => [k, "0"])) as GovernedCurrent["settings"];
const blank = (): GovernedCurrent => ({ settings: { ...offSettings }, layers: [] });

describe("automation presets", () => {
  it("only knows manual and semi (full auto is later)", () => {
    expect(isAutomationLevel("manual")).toBe(true);
    expect(isAutomationLevel("semi")).toBe(true);
    expect(isAutomationLevel("full")).toBe(false);
    expect(isAutomationLevel(undefined)).toBe(false);
  });

  it("manual equals the defaults of a fresh install", () => {
    const m = AUTOMATION_PRESETS.manual;
    expect(Object.values(m.settings).every((v) => v === "0")).toBe(true);
    for (const [k, v] of Object.entries(m.loop)) expect(v).toEqual((LOOP_POLICY_DEFAULTS as unknown as Record<string, unknown>)[k]);
    expect(m.stacks.autoRebase).toBe(STACK_POLICY_DEFAULTS.autoRebase);
    expect(m.intake).toEqual({ enabled: INTAKE_POLICY_DEFAULTS.enabled, autoStart: INTAKE_POLICY_DEFAULTS.autoStart });
    expect(automationDisplay("manual", blank())).toEqual({ display: "manual", differs: [] });
  });

  it("semi covers the W7 list and never replies to or resolves comments", () => {
    const s = AUTOMATION_PRESETS.semi;
    expect(s.loop["comments.enabled"]).toBe(true);
    expect(s.loop["comments.reply"]).toBe(false);
    expect(s.loop["comments.resolve"]).toBe(false);
    expect(s.settings.externalCommentReply).toBe("0");
    expect(s.settings.externalCommentResolve).toBe("0");
    expect(s.loop["ci.enabled"]).toBe(true);
    expect(s.loop["ci.maxReruns"]).toBe(1);
    expect(s.settings.externalCiRerun).toBe("1");
    expect(s.stacks.autoRebase).toBe(true);
    expect([s.settings.externalBranchPush, s.settings.externalForcePush, s.settings.externalPrOpen]).toEqual(["1", "1", "1"]);
    expect(s.settings.preReviewEnabled).toBe("1");
    expect(s.intake).toEqual({ enabled: true, autoStart: true });
  });
});

describe("presetLayer", () => {
  it("keeps other keys and removes governed overrides that equal the default", () => {
    const existing = { "ci.enabled": true, "ci.flakyTests": ["a"], "comments.reply": false };
    expect(presetLayer("loop", existing, "manual")).toEqual({ "ci.flakyTests": ["a"] });
    expect(presetLayer("loop", existing, "semi")).toEqual({
      "ci.flakyTests": ["a"], "comments.enabled": true, "comments.reply": false, "comments.resolve": false, "ci.enabled": true, "ci.maxReruns": 1,
    });
    expect(presetLayer("intake", { autoStart: false, maxSize: "small" }, "semi")).toEqual({ enabled: true, maxSize: "small" });
  });
});

describe("automationDisplay", () => {
  const semiCurrent = (): GovernedCurrent => ({
    settings: { ...AUTOMATION_PRESETS.semi.settings },
    layers: [
      { family: "loop", scope: "global", label: "", values: presetLayer("loop", {}, "semi") },
      { family: "stacks", scope: "global", label: "", values: presetLayer("stacks", {}, "semi") },
      { family: "intake", scope: "global", label: "", values: presetLayer("intake", {}, "semi") },
    ],
  });

  it("shows semi when every governed switch matches", () => {
    expect(automationDisplay("semi", semiCurrent())).toEqual({ display: "semi", differs: [] });
  });

  it("shows custom when a setting, a global policy key or a repo override differs", () => {
    const a = semiCurrent();
    a.settings.externalForcePush = "0";
    expect(automationDisplay("semi", a)).toEqual({ display: "custom", differs: ["externalForcePush"] });

    const b = blank();
    b.layers.push({ family: "loop", scope: "global", label: "", values: { "ci.enabled": true } });
    expect(automationDisplay("manual", b).differs).toEqual(["loop:ci.enabled"]);

    const c = blank();
    c.layers.push({ family: "stacks", scope: "repo", label: "org/repo", values: { autoRebase: true } });
    expect(automationDisplay("manual", c)).toEqual({ display: "custom", differs: ["stacks:autoRebase@org/repo"] });
  });

  it("ignores non-governed keys and overrides that agree with the preset", () => {
    const c = blank();
    c.layers.push({ family: "loop", scope: "product", label: "shop", values: { "ci.enabled": false, "ci.flakyTests": ["x"] } });
    expect(automationDisplay("manual", c).display).toBe("manual");
  });
});

describe("epic overlays", () => {
  it("leaves the policy alone without an epic level", () => {
    const p = { ...LOOP_POLICY_DEFAULTS, "ci.enabled": true };
    expect(overlayLoop(p, null)).toBe(p);
    expect(overlayStack(STACK_POLICY_DEFAULTS, null)).toBe(STACK_POLICY_DEFAULTS);
    expect(externalOverride(null, "externalForcePush")).toBeUndefined();
    expect(preReviewOn(null, true)).toBe(true);
  });

  it("puts the epic preset on top of the layers", () => {
    const p = { ...LOOP_POLICY_DEFAULTS, "ci.enabled": true, "ci.flakyTests": ["t"] };
    expect(overlayLoop(p, "manual")["ci.enabled"]).toBe(false);
    expect(overlayLoop(p, "manual")["ci.flakyTests"]).toEqual(["t"]);
    expect(overlayLoop(LOOP_POLICY_DEFAULTS, "semi")["comments.enabled"]).toBe(true);
    expect(overlayStack(STACK_POLICY_DEFAULTS, "semi").autoRebase).toBe(true);
    expect(externalOverride("semi", "externalForcePush")).toBe("1");
    expect(externalOverride("semi", "externalCommentReply")).toBe("0");
    expect(externalOverride("semi", "externalIssuePost")).toBeUndefined();
    expect(preReviewOn("semi", false)).toBe(true);
    expect(preReviewOn("manual", true)).toBe(false);
  });

  it("maps an epic level onto intake: semi starts on its own, manual only stops the start (BTL-246 §7)", () => {
    const off = { ...INTAKE_POLICY_DEFAULTS, enabled: false, autoStart: false, maxSize: "small" as const };
    expect(overlayIntake(off, null)).toBe(off);
    expect(overlayIntake(off, "semi")).toEqual({ ...off, enabled: true, autoStart: true });
    const on = { ...INTAKE_POLICY_DEFAULTS, enabled: true, autoStart: true };
    expect(overlayIntake(on, "manual")).toEqual({ ...on, autoStart: false });
    expect(overlayIntake(off, "manual")).toEqual(off);
  });

  it("decides a stack's level from all its layers", () => {
    expect(stackLevel([])).toBeNull();
    expect(stackLevel(["semi", "semi"])).toBe("semi");
    expect(stackLevel(["semi", null])).toBeNull();
    expect(stackLevel(["semi", "manual"])).toBe("manual");
    expect(stackLevel([null, "manual"])).toBe("manual");
  });
});
