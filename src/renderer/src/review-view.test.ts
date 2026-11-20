import { describe, expect, it } from "vitest";
import type { PrPolicyView } from "../../shared/pr-policy";
import { assessmentTitle, enoughSample, parsePrInput, pathClassOf, prGroups, prInputValue, prOverridesFromDraft } from "./review-view";

const view = (overrides: Record<string, unknown>): PrPolicyView => ({
  scope: { kind: "global" },
  conflicts: [],
  builtinPaths: {} as PrPolicyView["builtinPaths"],
  unions: {} as PrPolicyView["unions"],
  keys: (["readiness.shouldBlocks", "readiness.descriptionMinChars", "evidence.rerun", "risk.paths.auth", "risk.types.floors"] as const).map((key) => ({
    key, group: key.split(".")[0], effective: overrides[key] ?? null, origin: { kind: "default" }, override: (overrides[key] ?? null) as never,
  })) as unknown as PrPolicyView["keys"],
});


describe("pre-review policy editor", () => {
  it("parses each kind of input", () => {
    expect(parsePrInput("readiness.shouldBlocks", "true")).toBe(true);
    expect(parsePrInput("readiness.shouldBlocks", "")).toBeNull();
    expect(parsePrInput("readiness.descriptionMinChars", "120")).toBe(120);
    expect(parsePrInput("readiness.descriptionMinChars", "-1")).toBeUndefined();
    expect(parsePrInput("evidence.rerun", "fast")).toBe("fast");
    expect(parsePrInput("evidence.rerun", "sometimes")).toBeUndefined();
    expect(parsePrInput("risk.paths.auth", "src/iam/**\n\nsrc/iam/**")).toEqual(["src/iam/**"]);
    expect(parsePrInput("risk.types.floors", "spike=low")).toEqual(["spike=low"]);
    expect(parsePrInput("risk.types.floors", "spike=urgent")).toBeUndefined();
    expect(parsePrInput("nope", "1")).toBeUndefined();
    expect(prInputValue(["a", "b"])).toBe("a\nb");
    expect(prInputValue(null)).toBe("");
  });

  it("builds the whole layer from overrides and the draft", () => {
    const v = view({ "readiness.shouldBlocks": true, "risk.paths.auth": ["x/**"] });
    expect(prOverridesFromDraft(v, {})).toEqual({ ok: true, overrides: { "readiness.shouldBlocks": true, "risk.paths.auth": ["x/**"] }, changed: false });
    expect(prOverridesFromDraft(v, { "readiness.shouldBlocks": "", "evidence.rerun": "off" })).toEqual({ ok: true, overrides: { "evidence.rerun": "off", "risk.paths.auth": ["x/**"] }, changed: true });
    expect(prOverridesFromDraft(v, { "readiness.descriptionMinChars": "abc" })).toEqual({ ok: false, badKey: "readiness.descriptionMinChars" });
  });

  it("groups readiness, evidence, then risk keys and names path classes", () => {
    expect(prGroups(view({})).map((g) => [g.group, g.keys.length])).toEqual([["readiness", 2], ["evidence", 1], ["risk", 2]]);
    expect(pathClassOf("risk.paths.publicApi")).toBe("publicApi");
    expect(pathClassOf("risk.paths.auth.builtin")).toBeNull();
  });
});

describe("review queue and effect helpers", () => {
  it("needs five PRs before showing a group and titles PRs or branches", () => {
    expect(enoughSample({ prs: 4, humanComments: 1, rounds: 1, firstReviewMs: 1, submitToMergeMs: 1 })).toBe(false);
    expect(enoughSample({ prs: 5, humanComments: 1, rounds: 1, firstReviewMs: 1, submitToMergeMs: 1 })).toBe(true);
    expect(assessmentTitle({ number: 7, title: "Fix it", target: null })).toBe("#7 Fix it");
    expect(assessmentTitle({ number: null, title: null, target: { repoSlug: "o/r", branch: "feat/x", headSha: "abc" } })).toBe("feat/x");
  });
});
