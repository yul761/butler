import { describe, expect, it } from "vitest";
import { FEATURE_IDS, FEATURES } from "./feature-rows";
import { EDITABLE_SETTINGS } from "./settings";
import { ADVANCED_GROUPS, SETTING_PLACEMENT, sectionTarget } from "./settings-layout";

/** 设置键很少、主要靠三层策略的分组：没有设置键也可以。 */
const POLICY_GROUPS = ["cost", "loop", "review", "stacks"];

describe("settings layout", () => {
  it("places every editable setting", () => {
    expect(Object.keys(SETTING_PLACEMENT).sort()).toEqual([...EDITABLE_SETTINGS].sort());
  });

  it("puts every advanced key into a real group, and every group has something", () => {
    const used = new Set<string>();
    for (const p of Object.values(SETTING_PLACEMENT)) {
      if (p.tab !== "advanced") continue;
      expect(ADVANCED_GROUPS as readonly string[]).toContain(p.group);
      used.add(p.group);
    }
    for (const g of ADVANCED_GROUPS) if (!POLICY_GROUPS.includes(g)) expect(used.has(g), g).toBe(true);
  });

  it("keeps outward actions in their own group", () => {
    for (const k of EDITABLE_SETTINGS) if (k.startsWith("external")) expect(SETTING_PLACEMENT[k]).toEqual({ tab: "advanced", group: "external" });
  });

  it("places each feature's setting keys in the group the row links to", () => {
    for (const id of FEATURE_IDS) {
      for (const sw of FEATURES[id].switches) {
        if (sw.kind !== "setting") continue;
        expect(SETTING_PLACEMENT[sw.key], `${id}:${sw.key}`).toEqual({ tab: "advanced", group: FEATURES[id].group });
      }
    }
  });

  it("maps old and new sections to a tab and group", () => {
    expect(sectionTarget(undefined)).toEqual({ tab: "basic", group: null });
    expect(sectionTarget("health")).toEqual({ tab: "health", group: null });
    expect(sectionTarget("routing")).toEqual({ tab: "advanced", group: "routing" });
    expect(sectionTarget("cost")).toEqual({ tab: "advanced", group: "cost" });
    expect(sectionTarget("features")).toEqual({ tab: "features", group: null });
    expect(sectionTarget("advanced")).toEqual({ tab: "advanced", group: null });
  });
});
