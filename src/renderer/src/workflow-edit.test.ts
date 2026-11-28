import { describe, expect, it } from "vitest";
import { parseWorkflow, type WorkflowStep } from "../../shared/workflow";
import { addableSteps, insertStep, layerTitle, moveStep, removeStep, scopeFor, setStepOption } from "./workflow-edit";

const ids = (s: WorkflowStep[]) => s.map((x) => x.id);

describe("workflow editor (BTL-273)", () => {
  it("adds a step where it belongs in the usual order, so the result stays valid", () => {
    let s: WorkflowStep[] = [{ id: "implement" }, { id: "open_pr" }, { id: "merge" }];
    s = insertStep(s, "ci_green");
    s = insertStep(s, "self_review");
    s = insertStep(s, "bot_review");
    expect(ids(s)).toEqual(["implement", "self_review", "open_pr", "ci_green", "bot_review", "merge"]);
    expect(parseWorkflow({ steps: s }).ok).toBe(true);
    expect(addableSteps(s)).toEqual(["pre_review", "address_comments", "re_review", "human_review"]);
    // 已经有的不重复加
    expect(insertStep(s, "merge")).toBe(s);
  });

  it("moves and removes steps", () => {
    const s: WorkflowStep[] = [{ id: "implement" }, { id: "open_pr" }, { id: "ci_green" }, { id: "bot_review" }];
    expect(ids(moveStep(s, 3, -1))).toEqual(["implement", "open_pr", "bot_review", "ci_green"]);
    expect(moveStep(s, 0, -1)).toBe(s);
    expect(moveStep(s, 3, 1)).toBe(s);
    expect(ids(removeStep(s, 1))).toEqual(["implement", "ci_green", "bot_review"]);
  });

  it("sets an option and drops it again when blank or default", () => {
    const s: WorkflowStep[] = [{ id: "open_pr" }, { id: "merge" }];
    expect(setStepOption(s, 0, { draft: true })[0]).toEqual({ id: "open_pr", draft: true });
    expect(setStepOption(setStepOption(s, 0, { draft: true }), 0, { draft: false })[0]).toEqual({ id: "open_pr" });
    expect(setStepOption(s, 1, { note: "  " })[1]).toEqual({ id: "merge" });
    expect(setStepOption(s, 1, { mergeBy: "user" })[1]).toEqual({ id: "merge", mergeBy: "user" });
  });

  it("builds a scope from the picker and names layers", () => {
    expect(scopeFor("global", "")).toEqual({ kind: "global" });
    expect(scopeFor("product", "9")).toEqual({ kind: "product", productId: 9 });
    expect(scopeFor("repo", "o/a")).toEqual({ kind: "repo", slug: "o/a" });
    expect(scopeFor("feature", "4")).toEqual({ kind: "feature", featureId: 4 });
    expect(scopeFor("ticket", "A-1")).toEqual({ kind: "ticket", ticketKey: "A-1" });
    expect(scopeFor("product", "")).toBeNull();
    expect(layerTitle({ kind: "global" }, "")).toBe("全局");
    expect(layerTitle({ kind: "feature", featureId: 4 }, "4.3.0")).toBe("epic · 4.3.0");
  });
});
