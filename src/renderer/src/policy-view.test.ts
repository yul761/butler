import { describe, expect, it } from "vitest";
import { ADMISSION_POLICY_DEFAULTS, ADMISSION_POLICY_KEYS, POLICY_GROUPS, type AdmissionPolicyView } from "../../shared/admission-policy";
import { parsePolicyInput, policyGroups, policyInputValue, policyOverridesFromDraft, policyScopeFromKey, policyScopeKey } from "./policy-view";
import { STRINGS } from "./strings";

const view = (overrides: Record<string, unknown> = {}): AdmissionPolicyView => ({
  scope: { kind: "global" },
  keys: ADMISSION_POLICY_KEYS.map((d) => ({
    key: d.key, effective: (overrides[d.key] as never) ?? ADMISSION_POLICY_DEFAULTS[d.key], origin: { kind: overrides[d.key] === undefined ? "default" : "global" }, override: (overrides[d.key] as never) ?? null,
  })),
  conflicts: [], version: 1, calibrated: false,
});

describe("policy editor", () => {
  it("has a description for every key and group in both languages", () => {
    for (const lang of ["zh", "en"] as const) {
      const S = STRINGS[lang];
      for (const d of ADMISSION_POLICY_KEYS) expect((S.policyKey as Record<string, string>)[d.key], `${lang} ${d.key}`).toBeTruthy();
      for (const g of POLICY_GROUPS) expect(S.policyGroup[g]).toBeTruthy();
      expect(Object.keys(S.policyKey)).toHaveLength(ADMISSION_POLICY_KEYS.length);
    }
  });

  it("parses inputs by key kind; empty means inherit", () => {
    expect(parsePolicyInput("score.admitLine", " 0.75 ")).toBe(0.75);
    expect(parsePolicyInput("score.admitLine", "1.5")).toBeUndefined();
    expect(parsePolicyInput("batch.sampleSize", "2.5")).toBeUndefined();
    expect(parsePolicyInput("batch.sampleSize", "30")).toBe(30);
    expect(parsePolicyInput("shadow.autoPromote", "true")).toBe(true);
    expect(parsePolicyInput("demote.to", "review")).toBe("review");
    expect(parsePolicyInput("demote.to", "nope")).toBeUndefined();
    expect(parsePolicyInput("score.admitLine", "")).toBeNull();
    expect(parsePolicyInput("no.such", "1")).toBeUndefined();
    expect(policyInputValue(null)).toBe("");
    expect(policyInputValue(false)).toBe("false");
  });

  it("builds the whole layer from overrides plus the draft", () => {
    const v = view({ "score.admitLine": 0.8, "shadow.autoPromote": true });
    expect(policyOverridesFromDraft(v, {})).toEqual({ ok: true, changed: false, overrides: { "score.admitLine": 0.8, "shadow.autoPromote": true } });
    expect(policyOverridesFromDraft(v, { "score.admitLine": "", "batch.sampleSize": "40" })).toEqual({ ok: true, changed: true, overrides: { "shadow.autoPromote": true, "batch.sampleSize": 40 } });
    expect(policyOverridesFromDraft(v, { "score.admitLine": "0.8" })).toMatchObject({ ok: true, changed: false });
    expect(policyOverridesFromDraft(v, { "score.dropLine": "x" })).toEqual({ ok: false, badKey: "score.dropLine" });
  });

  it("groups keys in design order and round-trips layer keys", () => {
    const groups = policyGroups(view());
    expect(groups.map((g) => g.group)).toEqual([...POLICY_GROUPS]);
    expect(groups.flatMap((g) => g.keys)).toHaveLength(ADMISSION_POLICY_KEYS.length);
    for (const s of [{ kind: "global" }, { kind: "product", productId: 3 }, { kind: "repo", slug: "o/web" }] as const) expect(policyScopeFromKey(policyScopeKey(s))).toEqual(s);
  });
});
