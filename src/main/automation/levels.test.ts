import { describe, expect, it } from "vitest";
import { GOVERNED_SETTINGS, type AutomationLevel, type GovernedFamily, type GovernedLayer } from "../../shared/automation";
import { LOOP_POLICY_DEFAULTS } from "../../shared/loop-policy";
import { STACK_POLICY_DEFAULTS } from "../../shared/stacks";
import { AutomationLevels } from "./levels";

function fixture(init: { level?: string; settings?: Record<string, string>; layers?: Partial<Record<GovernedFamily, Record<string, unknown>>> } = {}) {
  const settings: Record<string, string> = { automationLevel: init.level ?? "manual", intakeSource: "none", ...Object.fromEntries(GOVERNED_SETTINGS.map((k) => [k, "0"])), ...init.settings };
  const global: Record<GovernedFamily, Record<string, unknown>> = { loop: {}, stacks: {}, intake: {}, ...init.layers };
  const writes: string[] = [];
  const features = new Map<number, AutomationLevel | null>([[1, "semi"], [2, "manual"], [3, null]]);
  const tickets = new Map<string, number | null>([["A-1", 1], ["B-1", 2], ["C-1", 3], ["D-1", null]]);
  const repoLayers: GovernedLayer[] = [];
  const levels = new AutomationLevels({
    setting: (k) => settings[k] ?? "",
    writeSetting: (k, v) => {
      settings[k] = v;
      writes.push(`${k}=${v}`);
    },
    globalLayer: (f) => ({ ...global[f] }),
    writeLayer: (f, l) => {
      global[f] = l;
      writes.push(`layer:${f}`);
    },
    layers: () => [
      ...(["loop", "stacks", "intake"] as const).map((f): GovernedLayer => ({ family: f, scope: "global", label: "", values: global[f] })),
      ...repoLayers,
    ],
    featureLevel: (id) => features.get(id) ?? null,
    ticketFeature: (k) => tickets.get(k) ?? null,
  });
  return { levels, settings, global, writes, repoLayers };
}

describe("AutomationLevels", () => {
  it("defaults to manual and treats a broken stored value as manual", () => {
    expect(fixture().levels.global()).toBe("manual");
    expect(fixture({ level: "full" }).levels.global()).toBe("manual");
    expect(fixture().levels.state()).toEqual({ level: "manual", display: "manual", differs: [], intakeSourceSet: false });
  });

  it("resolves an epic's level, falling back to the global one", () => {
    const { levels } = fixture({ level: "semi" });
    expect(levels.levelForFeature(null)).toBe("semi");
    expect(levels.levelForFeature(2)).toBe("manual");
    expect(levels.levelForFeature(3)).toBe("semi");
    expect(levels.levelForTicket("A-1")).toBe("semi");
    expect(levels.levelForTicket("D-1")).toBe("semi");
    expect(levels.overrideForTicket("C-1")).toBeNull();
    expect(levels.overrideForTicket("D-1")).toBeNull();
    expect(levels.overrideForTicket(null)).toBeNull();
    expect(levels.overrideForTicket("B-1")).toBe("manual");
    expect(levels.overrideForFeature(1)).toBe("semi");
    expect(levels.overrideForFeature(3)).toBeNull();
    expect(levels.overrideForFeature(null)).toBeNull();
  });

  it("writes the semi preset and keeps other keys of the global layer", () => {
    const f = fixture({ layers: { loop: { "ci.flakyTests": ["x"] } } });
    f.levels.apply("semi");
    expect(f.settings.preReviewEnabled).toBe("1");
    expect(f.settings.externalForcePush).toBe("1");
    expect(f.settings.externalCommentReply).toBe("0");
    expect(f.global.loop).toEqual({ "ci.flakyTests": ["x"], "comments.enabled": true, "comments.reply": false, "comments.resolve": false, "ci.enabled": true, "ci.maxReruns": 1 });
    expect(f.global.stacks).toEqual({ autoRebase: true });
    expect(f.global.intake).toEqual({ enabled: true });
    f.settings.automationLevel = "semi";
    expect(f.levels.state().display).toBe("semi");

    f.writes.length = 0;
    f.levels.apply("semi");
    expect(f.writes).toEqual([]);

    f.levels.apply("manual");
    f.settings.automationLevel = "manual";
    expect(f.global.loop).toEqual({ "ci.flakyTests": ["x"] });
    expect(f.levels.state().display).toBe("manual");
  });

  it("shows custom once a governed switch was touched, also in a repo layer", () => {
    const f = fixture({ settings: { externalCiRerun: "1" } });
    expect(f.levels.state()).toMatchObject({ display: "custom", differs: ["externalCiRerun"] });
    const g = fixture();
    g.repoLayers.push({ family: "loop", scope: "repo", label: "o/r", values: { "ci.enabled": true } });
    expect(g.levels.state().differs).toEqual(["loop:ci.enabled@o/r"]);
  });

  it("puts an epic's own level on top for its tickets only", () => {
    const { levels } = fixture({ settings: { externalForcePush: "1", preReviewEnabled: "1" } });
    const base = { ...LOOP_POLICY_DEFAULTS, "ci.enabled": true };
    expect(levels.loop(base, "A-1")["comments.enabled"]).toBe(true);
    expect(levels.loop(base, "B-1")["ci.enabled"]).toBe(false);
    expect(levels.loop(base, "C-1")).toBe(base);
    expect(levels.external("externalForcePush", "B-1")).toBe("0");
    expect(levels.external("externalForcePush", "A-1")).toBe("1");
    expect(levels.external("externalForcePush", "D-1")).toBeUndefined();
    expect(levels.preReview("B-1", true)).toBe(false);
    expect(levels.preReview("D-1", true)).toBe(true);
    expect(levels.stack(STACK_POLICY_DEFAULTS, ["A-1", "A-1"]).autoRebase).toBe(true);
    expect(levels.stack(STACK_POLICY_DEFAULTS, ["A-1", "D-1"]).autoRebase).toBe(false);
    expect(levels.stack({ ...STACK_POLICY_DEFAULTS, autoRebase: true }, ["A-1", "B-1"]).autoRebase).toBe(false);
  });

  it("reports whether an intake source is set", () => {
    expect(fixture({ settings: { intakeSource: "tracker" } }).levels.state().intakeSourceSet).toBe(true);
  });
});
