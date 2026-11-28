import { describe, expect, it } from "vitest";
import { LOOP_POLICY_DEFAULTS } from "../../shared/loop-policy";
import { presetWorkflow, type Workflow } from "../../shared/workflow";
import { loopWithWorkflow, preReviewWithWorkflow } from "./overrides";

const w = (...ids: string[]): Workflow => ({ steps: ids.map((id) => ({ id })) as Workflow["steps"], notes: "" });

describe("workflow overrides (BTL-273)", () => {
  it("a workflow decides whether pre-review runs; without one the old switch does", () => {
    expect(preReviewWithWorkflow(null, true)).toBe(true);
    expect(preReviewWithWorkflow(null, false)).toBe(false);
    expect(preReviewWithWorkflow(presetWorkflow("strict"), false)).toBe(true);
    expect(preReviewWithWorkflow(presetWorkflow("fast"), true)).toBe(false);
  });

  it("a workflow with review steps turns comment forwarding on, and never turns it off", () => {
    const off = { ...LOOP_POLICY_DEFAULTS, "comments.enabled": false };
    expect(loopWithWorkflow(null, off)["comments.enabled"]).toBe(false);
    expect(loopWithWorkflow(w("implement", "open_pr", "bot_review", "address_comments"), off)["comments.enabled"]).toBe(true);
    expect(loopWithWorkflow(w("implement", "open_pr"), off)["comments.enabled"]).toBe(false);
    const on = { ...LOOP_POLICY_DEFAULTS, "comments.enabled": true };
    expect(loopWithWorkflow(w("implement", "open_pr"), on)).toBe(on);
  });
});
