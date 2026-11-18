import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { StacksRepo } from "./stacks-repo";

const base = { repoPath: "/r", repoSlug: "acme/app", trunk: "main", remote: "origin", name: "s", epicId: null, featureId: 3, source: "mcp" as const };

describe("StacksRepo", () => {
  it("creates a stack with ordered layers and finds a branch", () => {
    let t = 1;
    const r = new StacksRepo(memDb(), () => t++);
    const id = r.create(base, [
      { branch: "a", ticketKey: "T-1", ticketRepoId: 1 },
      { branch: "b", ticketKey: "T-2", ticketRepoId: 2, mode: "draft", state: "draft", prNumber: 7 },
    ]);
    expect(r.layers(id).map((l) => [l.position, l.branch, l.state])).toEqual([[0, "a", "branch_only"], [1, "b", "draft"]]);
    expect(r.findBranch("/r", "b")?.layer.prNumber).toBe(7);
    expect(r.findBranch("/other", "b")).toBeNull();
    r.addLayer(id, { branch: "c", ticketKey: null, ticketRepoId: null });
    expect(r.layers(id).at(-1)).toMatchObject({ branch: "c", position: 2 });
    r.remove(id);
    expect(r.list()).toEqual([]);
    expect(r.findBranch("/r", "a")).toBeNull();
  });

  it("replaces layers keeping the state of branches that stay", () => {
    const r = new StacksRepo(memDb());
    const id = r.create(base, [{ branch: "a", ticketKey: null, ticketRepoId: null }, { branch: "b", ticketKey: null, ticketRepoId: null }]);
    const b = r.layers(id)[1]!;
    r.updateLayer(b.id, { tipSha: "abc", state: "draft" });
    r.replaceLayers(id, [{ branch: "b", ticketKey: null, ticketRepoId: null }, { branch: "c", ticketKey: null, ticketRepoId: null }]);
    expect(r.layers(id).map((l) => [l.branch, l.position, l.tipSha])).toEqual([["b", 0, "abc"], ["c", 1, null]]);
  });

  it("collapses repeated deferrals into one run", () => {
    const r = new StacksRepo(memDb());
    const id = r.create(base, []);
    expect(r.recordRepeatable(id, "daily", "deferred", "dirty")).toBe(true);
    expect(r.recordRepeatable(id, "daily", "deferred", "dirty")).toBe(false);
    expect(r.runs(id)).toHaveLength(1);
    expect(r.lastRun(id)?.detail.repeats).toBe(2);
    expect(r.recordRepeatable(id, "daily", "deferred", "busy")).toBe(true);
    expect(r.runs(id)).toHaveLength(2);
  });

  it("tracks restorable runs and clears old backups", () => {
    let t = 100;
    const r = new StacksRepo(memDb(), () => t);
    const id = r.create(base, []);
    const run = r.startRun(id, "manual", "update_refs");
    r.finishRun(run, { outcome: "rebased", detail: { layers: [{ position: 0, branch: "a", oldTip: "1", newTip: "2", backupRef: "refs/butler/stack-backup/1/1/0" }] } });
    expect(r.lastRestorable(id)?.id).toBe(run);
    t = 200;
    expect(r.backupsBefore(150)).toEqual([{ runId: run, stackId: id, refs: ["refs/butler/stack-backup/1/1/0"] }]);
    r.clearBackups(run);
    expect(r.backupsBefore(150)).toEqual([]);
    expect(r.lastRestorable(id)).toBeNull();
  });
});
