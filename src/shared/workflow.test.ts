import { describe, expect, it } from "vitest";
import {
  mergeByOf, parseScopeRef, parseWorkflow, pendingBefore, presetOf, presetWorkflow, progressOf, WORKFLOW_PRESETS, workflowWantsComments,
  type WorkflowStepId,
} from "./workflow";

describe("parseWorkflow", () => {
  it("accepts both presets", () => {
    for (const p of WORKFLOW_PRESETS) {
      const r = parseWorkflow(presetWorkflow(p));
      expect(r.ok).toBe(true);
      if (r.ok) expect(presetOf(r.workflow)).toBe(p);
    }
  });

  it("accepts bare step names and trims notes", () => {
    const r = parseWorkflow({ steps: ["implement", { id: "open_pr", note: "  先开 draft  ", draft: true }, "ci_green", { id: "merge", mergeBy: "user" }], notes: " x " });
    expect(r).toEqual({
      ok: true,
      workflow: { steps: [{ id: "implement" }, { id: "open_pr", note: "先开 draft", draft: true }, { id: "ci_green" }, { id: "merge", mergeBy: "user" }], notes: "x" },
    });
  });

  it("rejects unknown, duplicate and misordered steps", () => {
    expect(parseWorkflow({ steps: [] })).toEqual({ ok: false, problem: { code: "empty" } });
    expect(parseWorkflow({ steps: ["deploy"] })).toEqual({ ok: false, problem: { code: "unknown_step", step: "deploy" } });
    expect(parseWorkflow({ steps: ["implement", "implement"] })).toEqual({ ok: false, problem: { code: "duplicate", step: "implement" } });
    expect(parseWorkflow({ steps: ["implement", "ci_green", "open_pr"] })).toEqual({ ok: false, problem: { code: "needs_pr", step: "ci_green" } });
    expect(parseWorkflow({ steps: ["implement", "ci_green"] })).toEqual({ ok: false, problem: { code: "needs_pr", step: "ci_green" } });
    expect(parseWorkflow({ steps: ["open_pr", "implement"] })).toEqual({ ok: false, problem: { code: "before_pr", step: "implement" } });
    expect(parseWorkflow({ steps: ["open_pr", "merge", "ci_green"] })).toEqual({ ok: false, problem: { code: "merge_last" } });
    expect(parseWorkflow({ steps: ["open_pr", "re_review"] })).toEqual({ ok: false, problem: { code: "re_review_needs_bot" } });
  });

  it("rejects options on the wrong step and out-of-range rounds", () => {
    expect(parseWorkflow({ steps: [{ id: "implement", draft: true }] })).toMatchObject({ ok: false, problem: { code: "bad_option", option: "draft" } });
    expect(parseWorkflow({ steps: ["open_pr", "bot_review", { id: "re_review", maxRounds: 9 }] })).toMatchObject({ ok: false, problem: { code: "bad_option", option: "maxRounds" } });
    expect(parseWorkflow({ steps: ["open_pr", { id: "merge", mergeBy: "robot" }] })).toMatchObject({ ok: false, problem: { code: "bad_option", option: "mergeBy" } });
  });

  it("rejects an over-long note instead of cutting it", () => {
    expect(parseWorkflow({ steps: [{ id: "implement", note: "x".repeat(2001) }] })).toEqual({ ok: false, problem: { code: "too_long", step: "implement" } });
  });
});

describe("progress", () => {
  const w = presetWorkflow("strict");
  it("the first step not done is current", () => {
    const done = new Map<WorkflowStepId, { at: number; detail: string | null }>([["implement", { at: 1, detail: null }], ["pre_review", { at: 2, detail: null }]]);
    const p = progressOf(w, done);
    expect(p.current).toBe("self_review");
    expect(p.steps.map((s) => s.state).slice(0, 4)).toEqual(["done", "current", "done", "todo"]);
  });

  it("pendingBefore lists what is still missing before a step", () => {
    expect(pendingBefore(w, "open_pr", new Set(["implement", "pre_review"]))).toEqual(["self_review"]);
    expect(pendingBefore(presetWorkflow("fast"), "merge", new Set(["implement", "open_pr", "ci_green"]))).toEqual([]);
  });

  it("who merges", () => {
    expect(mergeByOf(presetWorkflow("fast"))).toBe("coordinator");
    expect(mergeByOf(presetWorkflow("strict"))).toBe("user");
    expect(mergeByOf({ steps: [{ id: "implement" }, { id: "open_pr" }], notes: "" })).toBe("user");
  });

  it("comments are wanted only with review steps", () => {
    expect(workflowWantsComments(presetWorkflow("fast"))).toBe(false);
    expect(workflowWantsComments(presetWorkflow("strict"))).toBe(true);
    expect(workflowWantsComments(null)).toBe(false);
  });
});

describe("parseScopeRef", () => {
  it("reads the text forms", () => {
    expect(parseScopeRef("global")).toEqual({ kind: "global" });
    expect(parseScopeRef("epic: 4.3.0")).toEqual({ kind: "feature", ref: "4.3.0" });
    expect(parseScopeRef("repo:yul761/shipherd")).toEqual({ kind: "repo", ref: "yul761/shipherd" });
    expect(parseScopeRef("ticket:BTL-1")).toEqual({ kind: "ticket", ref: "BTL-1" });
    expect(parseScopeRef("product:Shipherd")).toEqual({ kind: "product", ref: "Shipherd" });
    expect(parseScopeRef("team:x")).toBeNull();
    expect(parseScopeRef("ticket:")).toBeNull();
  });
});

describe("parseWorkflowScope (IPC)", () => {
  it("accepts each scope kind and refuses junk", async () => {
    const { parseWorkflowScope } = await import("./workflow");
    expect(parseWorkflowScope({ kind: "global" })).toEqual({ kind: "global" });
    expect(parseWorkflowScope({ kind: "product", productId: 3 })).toEqual({ kind: "product", productId: 3 });
    expect(parseWorkflowScope({ kind: "repo", slug: "O/A" })).toEqual({ kind: "repo", slug: "o/a" });
    expect(parseWorkflowScope({ kind: "feature", featureId: 4 })).toEqual({ kind: "feature", featureId: 4 });
    expect(parseWorkflowScope({ kind: "ticket", ticketKey: "A-1" })).toEqual({ kind: "ticket", ticketKey: "A-1" });
    for (const bad of [null, "global", { kind: "moon" }, { kind: "product", productId: "3" }, { kind: "repo", slug: "nope" }, { kind: "feature", featureId: -1 }, { kind: "ticket", ticketKey: "" }]) {
      expect(parseWorkflowScope(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
