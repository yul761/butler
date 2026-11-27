import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import type { WorkflowControl } from "../workflow/workflow-control";
import { controlHandler, type ControlHandlerDeps } from "./control-handler";

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id, ticketKey: null, cwd: "/w", origin: "shipherd", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: false, replacedBy: null,
  dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, shipherd: false, lessonRunId: null, ...o,
});

/** 工作流程的总控工具（BTL-273）：from 要是这个作用域的总控。 */
function setup(withWorkflow = true) {
  const heads: Record<string, Session> = {
    coord: session("coord", { featureId: 4, coordinator: true }),
    other: session("other", { featureId: 5, coordinator: true }),
    global: session("global", { shipherd: true }),
    dev: session("dev", { ticketKey: "A-1", featureId: 4 }),
    fixer: session("fixer", { featureId: 4, fixesSession: "dev" }),
    plain: session("plain", { featureId: 4 }),
  };
  const calls: unknown[][] = [];
  const workflow = {
    coordinator: (req: unknown, caller: unknown) => (calls.push(["coordinator", (req as { op: string }).op, caller]), { v: 1, ok: true, value: {} }),
    ticketStep: (req: unknown, t: { key: string }) => (calls.push(["step", t.key]), { v: 1, ok: true, value: {} }),
    summary: (key: string) => (key === "A-1" ? { source: "feature:4", preset: null, current: "open_pr", done: 2, total: 5 } : null),
  } as unknown as WorkflowControl;
  const t = (key: string, featureId: number) => ({ key, title: null, status: "in_progress", statusManual: null, archivedAt: null, featureId, blockId: null, repos: [] });
  const handle = controlHandler({
    tickets: {
      get: (key: string) => ({ key, archivedAt: null }), list: () => [t("A-1", 4), t("B-1", 4)], listByFeature: () => [t("A-1", 4), t("B-1", 4)],
    } as unknown as ControlHandlerDeps["tickets"],
    features: { get: (id: number) => ({ id, name: `e${id}`, repos: [], archivedAt: id === 6 ? 1 : null }), list: () => [] } as unknown as ControlHandlerDeps["features"],
    ticketService: { workDir: () => "/w" } as never, sessionService: { termIdOf: (id: string) => (heads[id] ? `t-${id}` : null) } as never,
    sessions: { head: (id: string) => heads[id] ?? null } as unknown as ControlHandlerDeps["sessions"],
    kill: () => undefined, screenNeedsUser: () => false, submit: async () => "sent", notify: () => undefined,
    shipherd: {} as ControlHandlerDeps["shipherd"],
    ...(withWorkflow && { workflow }),
  });
  return { handle, calls };
}

describe("controlHandler workflow tools (BTL-273)", () => {
  it("passes the coordinator's own scope", async () => {
    const t = setup();
    expect(await t.handle({ v: 1, featureId: 4, from: "coord", op: "set_workflow", steps: null })).toMatchObject({ ok: true });
    expect(await t.handle({ v: 1, shipherd: true, from: "global", op: "get_workflow" })).toMatchObject({ ok: true });
    expect(await t.handle({ v: 1, ticketKey: "A-1", from: "dev", op: "workflow_step_done", step: "implement" })).toMatchObject({ ok: true });
    expect(t.calls).toEqual([["coordinator", "set_workflow", { featureId: 4 }], ["coordinator", "get_workflow", { shipherd: true }], ["step", "A-1"]]);
  });

  it("refuses a request whose from isn't that scope's coordinator, or an archived epic", async () => {
    const t = setup();
    for (const [req, why] of [
      [{ v: 1, featureId: 4, from: "other", op: "set_workflow", steps: null }, "another epic's coordinator"],
      [{ v: 1, featureId: 4, from: "dev", op: "set_workflow", steps: null }, "a ticket session"],
      [{ v: 1, featureId: 4, from: null, op: "set_workflow", steps: null }, "no from"],
      [{ v: 1, shipherd: true, from: "coord", op: "set_workflow", steps: null }, "an epic coordinator posing as global"],
      [{ v: 1, featureId: 6, from: "ghost", op: "get_workflow" }, "unknown session"],
    ] as const) {
      expect(await t.handle(req as never), why).toMatchObject({ ok: false });
    }
    expect(t.calls).toEqual([]);
  });

  it("a fix session (or any non-coordinator) on the epic can read the workflow but not change it", async () => {
    const t = setup();
    for (const from of ["fixer", "plain"]) {
      expect(await t.handle({ v: 1, featureId: 4, from, op: "set_workflow", steps: null }), from).toMatchObject({ ok: false });
      expect(await t.handle({ v: 1, featureId: 4, from, op: "set_workflow", steps: ["implement", "open_pr"] }), from).toMatchObject({ ok: false });
    }
    expect(t.calls).toEqual([]);
    expect(await t.handle({ v: 1, featureId: 4, from: "fixer", op: "get_workflow" })).toMatchObject({ ok: true });
    expect(await t.handle({ v: 1, featureId: 4, from: "fixer", op: "list_workflow_presets" })).toMatchObject({ ok: true });
    expect(t.calls).toEqual([["coordinator", "get_workflow", { featureId: 4 }], ["coordinator", "list_workflow_presets", { featureId: 4 }]]);
  });

  it("says the workflow isn't available when it isn't wired", async () => {
    const t = setup(false);
    expect(await t.handle({ v: 1, featureId: 4, from: "coord", op: "list_workflow_presets" })).toMatchObject({ ok: false });
    expect(await t.handle({ v: 1, ticketKey: "A-1", from: "dev", op: "workflow_step_done", step: "implement" })).toMatchObject({ ok: false });
  });

  it("list_tickets says where each ticket is in its workflow, for both coordinators", async () => {
    const t = setup();
    const want = [
      { key: "A-1", workflow: { source: "feature:4", current: "open_pr", done: 2, total: 5 } },
      { key: "B-1", workflow: null },
    ];
    expect(await t.handle({ v: 1, featureId: 4, from: "coord", op: "list_tickets" })).toMatchObject({ ok: true, value: want });
    expect(await t.handle({ v: 1, shipherd: true, from: "global", op: "list_tickets" })).toMatchObject({ ok: true, value: want });
  });
});
