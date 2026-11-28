import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { presetWorkflow } from "../../shared/workflow";
import { WorkflowRepo } from "./workflow-repo";

describe("WorkflowRepo", () => {
  it("stores one workflow per layer and clears it", () => {
    const r = new WorkflowRepo(memDb());
    expect(r.setLayer({ kind: "global" }, presetWorkflow("strict"), 1)).toBe(true);
    expect(r.setLayer({ kind: "global" }, presetWorkflow("strict"), 2)).toBe(false);
    expect(r.setLayer({ kind: "repo", slug: "A/B" }, presetWorkflow("fast"), 3)).toBe(true);
    expect(r.setLayer({ kind: "feature", featureId: 4 }, presetWorkflow("fast"), 3)).toBe(true);
    expect(r.setLayer({ kind: "ticket", ticketKey: "X-1" }, presetWorkflow("fast"), 3)).toBe(true);
    expect(r.layer({ kind: "repo", slug: "a/b" })?.workflow).toEqual(presetWorkflow("fast"));
    expect(r.layer({ kind: "global" })?.updatedAt).toBe(1);
    expect(r.layers().map((l) => l.scope.kind).sort()).toEqual(["feature", "global", "repo", "ticket"]);
    expect(r.setLayer({ kind: "global" }, null, 4)).toBe(true);
    expect(r.layer({ kind: "global" })).toBeNull();
  });

  it("a broken stored workflow counts as not set", () => {
    const db = memDb();
    db.prepare(`INSERT INTO workflow_layers (scope_kind, workflow, updated_at) VALUES ('global', '{"steps":["nope"]}', 1)`).run();
    expect(new WorkflowRepo(db).layer({ kind: "global" })).toBeNull();
  });

  it("keeps the first completion time", () => {
    const r = new WorkflowRepo(memDb());
    expect(r.markDone("X-1", "implement", 5, "session", "a")).toBe(true);
    expect(r.markDone("X-1", "implement", 9, "session", "b")).toBe(false);
    expect(r.done("X-1")).toEqual([{ step: "implement", doneAt: 5, detail: "a", source: "session" }]);
    expect(r.unmark("X-1", "implement")).toBe(true);
    expect(r.done("X-1")).toEqual([]);
  });

  it("only one caller claims a bot review round, and a finished round is not overwritten", () => {
    const r = new WorkflowRepo(memDb());
    const a = r.claimBotRequest("X-1", 7, 1, "copilot", "s1", 10);
    expect(a?.status).toBe("requesting");
    expect(r.claimBotRequest("X-1", 7, 1, "copilot", "s1", 11)).toBeNull();
    expect(r.finishBotRequest(a!.id, "requested", null, 12)).toBe(true);
    expect(r.finishBotRequest(a!.id, "failed", "late", 13)).toBe(false);
    expect(r.botRequests("X-1")[0]).toMatchObject({ status: "requested", requestedAt: 12, error: null });
    expect(r.markBotReviewed(a!.id, 20, 3)).toBe(true);
    expect(r.markBotReviewed(a!.id, 21, 0)).toBe(false);
    expect(r.botRequests("X-1")[0]).toMatchObject({ reviewedAt: 20, reviewComments: 3 });
  });
});
