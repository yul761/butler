import { describe, expect, it } from "vitest";
import { SETTING_DEFAULTS } from "../main/db/settings-repo";
import {
  applyFeatureToggle,
  FEATURE_IDS,
  FEATURE_POLICY_KEYS,
  FEATURES,
  featureRows,
  type FeaturePolicyState,
  type FeatureRow,
  type PolicyOverrideEntry,
} from "./feature-rows";
import { INTAKE_POLICY_DEFAULTS, INTAKE_POLICY_KEYS } from "./intake";
import { LOOP_POLICY_DEFAULTS, LOOP_POLICY_KEYS } from "./loop-policy";
import { EDITABLE_SETTINGS, type EditableSettings } from "./settings";
import { STACK_POLICY_DEFAULTS, STACK_POLICY_KEYS } from "./stacks";

const defaults = (): EditableSettings =>
  Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, String(SETTING_DEFAULTS[k])])) as EditableSettings;
const empty: FeaturePolicyState = { globals: {}, overrides: [] };
const row = (rows: FeatureRow[], id: string): FeatureRow => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};
const repo = (slug: string, family: PolicyOverrideEntry["family"], key: string, value: boolean): PolicyOverrideEntry => ({
  family, key, scope: { kind: "repo", slug }, label: slug, value,
});

describe("feature rows", () => {
  it("has a row for every feature and every key is real", () => {
    expect([...FEATURE_IDS].sort()).toEqual(Object.keys(FEATURES).sort());
    const policyKeys: Record<string, Set<string>> = { loop: new Set(), stacks: new Set(), intake: new Set() };
    for (const id of FEATURE_IDS) {
      for (const sw of FEATURES[id].switches) {
        if (sw.kind === "setting") {
          expect(EDITABLE_SETTINGS as readonly string[]).toContain(sw.key);
          continue;
        }
        policyKeys[sw.family].add(sw.key);
        if (sw.family === "loop") {
          expect(LOOP_POLICY_KEYS.map((d) => d.key) as string[]).toContain(sw.key);
          expect((LOOP_POLICY_DEFAULTS as unknown as Record<string, unknown>)[sw.key]).toBe(false);
        } else if (sw.family === "stacks") {
          expect(STACK_POLICY_KEYS as readonly string[]).toContain(sw.key);
          expect((STACK_POLICY_DEFAULTS as unknown as Record<string, unknown>)[sw.key]).toBe(false);
        } else {
          expect(INTAKE_POLICY_KEYS as readonly string[]).toContain(sw.key);
          expect((INTAKE_POLICY_DEFAULTS as unknown as Record<string, unknown>)[sw.key]).toBe(false);
        }
      }
    }
    for (const fam of ["loop", "stacks", "intake"] as const) {
      expect([...FEATURE_POLICY_KEYS[fam]].sort()).toEqual([...policyKeys[fam]].sort());
    }
  });

  it("shows every row off for a user who changed nothing", () => {
    const rows = featureRows(defaults(), empty);
    expect(rows.map((r) => r.id)).toEqual([...FEATURE_IDS]);
    for (const r of rows) {
      expect(r.state, r.id).toBe("off");
      expect(r.on, r.id).toBe(0);
      expect(r.otherScopes, r.id).toEqual({ repos: 0, products: 0, differing: 0 });
      expect(r.needsSetup, r.id).toBeNull();
    }
  });

  it("never turns on an outward action", () => {
    for (const id of FEATURE_IDS) {
      for (const w of applyFeatureToggle(id, true)) {
        if (w.kind === "setting") expect(w.key.startsWith("external"), `${id}:${w.key}`).toBe(false);
        else expect(["comments.reply", "comments.resolve"]).not.toContain(w.key);
      }
    }
    expect(applyFeatureToggle("review_comments", true)).toEqual([{ kind: "policy", family: "loop", key: "comments.enabled", value: true }]);
  });

  it("writes all keys of a multi-key row together", () => {
    expect(applyFeatureToggle("lessons_auto", true)).toEqual([
      { kind: "setting", key: "lessonsAutoAdmit", value: "1" },
      { kind: "setting", key: "lessonsPrinciples", value: "1" },
      { kind: "setting", key: "lessonsCoreGuide", value: "1" },
    ]);
    expect(applyFeatureToggle("lessons_auto", false).map((w) => w.kind === "setting" && w.value)).toEqual(["0", "0", "0"]);
    const fewer = applyFeatureToggle("fewer_interrupts", true).map((w) => (w.kind === "setting" ? w.key : w.key));
    expect(fewer).toEqual(["interruptChoiceRule", "interruptSelfServe"]);
    expect(fewer).not.toContain("interruptChoiceDefaults");
  });

  it("reports a half-enabled row as partial, with the count", () => {
    let r = row(featureRows({ ...defaults(), lessonsAutoAdmit: "1" }, empty), "lessons_auto");
    expect(r).toMatchObject({ state: "partial", on: 1, total: 3 });
    r = row(featureRows({ ...defaults(), lessonsAutoAdmit: "1", lessonsPrinciples: "1", lessonsCoreGuide: "1" }, empty), "lessons_auto");
    expect(r).toMatchObject({ state: "on", on: 3, total: 3 });
    r = row(featureRows({ ...defaults(), interruptSelfServe: "1" }, empty), "fewer_interrupts");
    expect(r).toMatchObject({ state: "partial", on: 1, total: 2 });
  });

  it("counts layers that override, and notes the ones that disagree with the global value", () => {
    const policy: FeaturePolicyState = {
      globals: { "loop:ci.enabled": false },
      overrides: [
        repo("a/one", "loop", "ci.enabled", true),
        repo("a/two", "loop", "ci.enabled", true),
        repo("a/three", "loop", "ci.enabled", false),
        { family: "loop", key: "ci.enabled", scope: { kind: "product", productId: 7 }, label: "P", value: true },
        repo("a/one", "loop", "comments.enabled", true),
      ],
    };
    const rows = featureRows(defaults(), policy);
    expect(row(rows, "ci_triage").otherScopes).toEqual({ repos: 3, products: 1, differing: 3 });
    expect(row(rows, "ci_triage").state).toBe("off");
    expect(row(rows, "review_comments").otherScopes).toEqual({ repos: 1, products: 0, differing: 1 });
  });

  it("counts the same scope once per row", () => {
    const policy: FeaturePolicyState = { globals: {}, overrides: [repo("a/one", "loop", "ci.enabled", true), repo("a/one", "loop", "ci.enabled", true)] };
    expect(row(featureRows(defaults(), policy), "ci_triage").otherScopes).toEqual({ repos: 1, products: 0, differing: 1 });
  });

  it("handles hundreds of overrides", () => {
    const overrides = Array.from({ length: 500 }, (_, i) => repo(`o/r${i}`, "stacks", "autoRebase", i % 2 === 0));
    const r = row(featureRows(defaults(), { globals: {}, overrides }), "stacks");
    expect(r.otherScopes.repos).toBe(500);
    expect(r.otherScopes.differing).toBe(250);
  });

  it("flags intake that is on but has no source", () => {
    const on: FeaturePolicyState = { globals: { "intake:enabled": true }, overrides: [] };
    expect(row(featureRows({ ...defaults(), intakeSource: "none" }, on), "intake").needsSetup).toBe("intake_source");
    expect(row(featureRows({ ...defaults(), intakeSource: "file" }, on), "intake").needsSetup).toBeNull();
    expect(row(featureRows({ ...defaults(), intakeSource: "none" }, empty), "intake").needsSetup).toBeNull();
  });

  it("treats a policy global as off when the state has no entry for it", () => {
    expect(row(featureRows(defaults(), empty), "ci_triage").state).toBe("off");
    expect(row(featureRows(defaults(), { globals: { "loop:ci.enabled": true }, overrides: [] }), "ci_triage").state).toBe("on");
  });
});
