import { describe, expect, it } from "vitest";
import { FeatureHandoffSchema, HandoffSchema, upgradeLegacyPr } from "./handoff";

describe("upgradeLegacyPr", () => {
  it("turns the old single pr into prs and leaves new payloads alone", () => {
    const pr = { number: 1, url: "u", state: "open", review: null };
    expect(upgradeLegacyPr({ status: "active", pr })).toEqual({ status: "active", prs: [pr] });
    expect(upgradeLegacyPr({ status: "active", pr: null })).toEqual({ status: "active", prs: [] });
    expect(upgradeLegacyPr({ status: "active", prs: [pr], pr: null })).toEqual({ status: "active", prs: [pr], pr: null });
    expect(upgradeLegacyPr(null)).toBeNull();
    expect(upgradeLegacyPr([1])).toEqual([1]);
  });

  it("makes an old /handoff output valid again", () => {
    const old = {
      ticket: "P-1", status: "in_review", done_today: [], next_steps: [], blockers: [], jira: null, followups: [], decisions: [], learnings: [],
      open_questions: [], pr: { number: 3, url: "https://github.com/a/b/pull/3", state: "open", review: "pending" },
    };
    expect(HandoffSchema.safeParse(old).success).toBe(false);
    expect(HandoffSchema.safeParse(upgradeLegacyPr(old)).success).toBe(true);
  });
});

describe("FeatureHandoffSchema", () => {
  const ok = { summary: "整体进展", blockers: [], next_steps: [], decisions: [], open_questions: [] };
  it("accepts a valid summary and null-ticket next steps", () => {
    expect(FeatureHandoffSchema.safeParse(ok).success).toBe(true);
    expect(FeatureHandoffSchema.safeParse({ ...ok, next_steps: [{ ticket: null, text: "x" }] }).success).toBe(true);
  });
  it("rejects an empty summary", () => {
    expect(FeatureHandoffSchema.safeParse({ ...ok, summary: "" }).success).toBe(false);
  });
});
