import { describe, expect, it } from "vitest";
import type { Feature, Ticket } from "../../shared/types";
import { WorkflowRepo } from "../db/workflow-repo";
import { memDb } from "../test-utils";
import { workflowHandlers } from "./workflow-ipc";
import { WorkflowService } from "./workflow-service";

const ticket = (key: string, featureId: number | null, path: string): Ticket => ({
  key, title: `t ${key}`, status: "in_progress" as Ticket["status"], statusManual: null, createdAt: 1, archivedAt: null, featureId,
  repos: [{ id: key.length, ticketKey: key, repoPath: path, workMode: "worktree", worktreePath: null, branch: `feature/${key}`, createdAt: 1, worktreeRemovedAt: null, cleanupBlocked: null }],
});

function setup() {
  const tickets = [ticket("A-1", 4, "/r/a"), ticket("B-1", null, "/r/b")];
  const features = [{ id: 4, name: "4.3.0", archivedAt: null } as Feature];
  const slug = (p: string) => (p === "/r/a" ? "O/A" : "o/b");
  const service = new WorkflowService({
    repo: new WorkflowRepo(memDb()),
    tickets: { get: (k) => tickets.find((t) => t.key === k) ?? null, list: () => tickets },
    featureName: (id) => features.find((f) => f.id === id)?.name ?? null,
    productsOf: () => [], productName: () => null, slugOf: slug,
    prs: { byTicket: () => [] }, stages: { forTicket: () => [] }, preReviews: { latestFor: () => null, latestForBranch: () => null },
    headSha: async () => null, level: () => "semi", mailbox: { send: () => {}, withdraw: () => {} },
    recipient: () => null, coordinator: () => null, session: () => null,
    requestBotReview: async () => ({ ok: true, via: "api" }), reviewCommentCount: async () => 0, ghCwd: () => null, now: () => 1, log: () => {}, onChange: () => {},
  });
  const h = workflowHandlers({
    service, products: () => [{ id: 9, name: "Shipherd" }], features: { list: () => features },
    tickets: { list: () => tickets, get: (k) => tickets.find((t) => t.key === k) ?? null }, slugOf: slug,
  });
  return { h, service };
}

describe("workflow IPC (BTL-273)", () => {
  it("lists the layers and what a new layer can target", () => {
    const t = setup();
    expect(t.h.set({ kind: "global" }, { steps: ["implement", "open_pr"] })).toEqual({ ok: true, changed: true });
    const s = t.h.state();
    expect(s.layers.map((l) => l.scope)).toEqual([{ kind: "global" }]);
    expect(s.targets).toEqual({ products: [{ id: 9, name: "Shipherd" }], repos: ["o/a", "o/b"], features: [{ id: 4, name: "4.3.0" }], tickets: [{ key: "A-1", title: "t A-1" }, { key: "B-1", title: "t B-1" }] });
  });

  it("refuses a bad scope or workflow with a message, and clears with null", () => {
    const t = setup();
    expect(t.h.set({ kind: "moon" }, { steps: ["implement"] })).toEqual({ ok: false, message: "认不出这一层。" });
    expect(t.h.set({ kind: "global" }, { steps: ["implement", "open_pr", "merge", "ci_green"] })).toMatchObject({ ok: false, message: expect.stringContaining("最后") });
    t.h.set({ kind: "feature", featureId: 4 }, { steps: ["implement", "open_pr"] });
    expect(t.h.set({ kind: "feature", featureId: 4 }, null)).toEqual({ ok: true, changed: true });
    expect(t.h.state().layers).toEqual([]);
  });

  it("gives the epic strip and the ticket strip", () => {
    const t = setup();
    expect(t.h.feature(4)).toEqual({ featureId: 4, own: null, tickets: [] });
    t.h.set({ kind: "feature", featureId: 4 }, { steps: ["implement", "self_review", "open_pr"] });
    expect(t.h.feature(4)).toMatchObject({ own: { steps: [{ id: "implement" }, { id: "self_review" }, { id: "open_pr" }] }, tickets: [{ key: "A-1", current: "implement", done: 0, total: 3 }] });
    expect(t.h.ticket("A-1")).toMatchObject({ current: "implement", source: { scope: { kind: "feature", featureId: 4 } } });
    expect(t.h.ticket("B-1")).toMatchObject({ workflow: null });
    expect(t.h.ticket("NOPE")).toBeNull();
    expect(t.h.feature("4")).toBeNull();
  });
});
