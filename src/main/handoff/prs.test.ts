import { describe, expect, it } from "vitest";
import type { Pr } from "../../shared/handoff";
import { combinedPr } from "./prs";

const pr = (number: number, state: Pr["state"], review: Pr["review"] = null, repo = "acme/web"): Pr => ({
  number, url: `https://github.com/${repo}/pull/${number}`, state, review,
});

describe("combinedPr", () => {
  it("is null without PRs and the PR itself for one", () => {
    expect(combinedPr([])).toBeNull();
    expect(combinedPr([pr(1, "open", "approved")])).toEqual({ state: "open", review: "approved" });
    expect(combinedPr([pr(1, "merged")])).toEqual({ state: "merged", review: null });
  });

  it("stays open while any PR is open, with the review that needs the most attention", () => {
    expect(combinedPr([pr(1, "merged"), pr(2, "open", "approved")])).toEqual({ state: "open", review: "approved" });
    expect(combinedPr([pr(1, "open", "approved"), pr(2, "open", "changes_requested")])).toEqual({ state: "open", review: "changes_requested" });
    expect(combinedPr([pr(1, "open", "approved"), pr(2, "open", "pending")])).toEqual({ state: "open", review: "pending" });
    expect(combinedPr([pr(1, "open", "approved"), pr(2, "open", null)])).toEqual({ state: "open", review: null });
  });

  it("is merged once nothing is open, ignoring closed PRs unless all are closed", () => {
    expect(combinedPr([pr(1, "merged"), pr(2, "closed")])).toEqual({ state: "merged", review: null });
    expect(combinedPr([pr(1, "closed"), pr(2, "closed")])).toEqual({ state: "closed", review: null });
  });
});
