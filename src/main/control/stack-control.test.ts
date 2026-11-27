import { describe, expect, it, vi } from "vitest";
import type { StackView } from "../../shared/stacks";
import type { Feature, Ticket } from "../../shared/types";
import { StackControl, type StackControlDeps } from "./stack-control";

const repo = "/r/shop";
const other = "/r/api";

const ticket = (key: string, featureId: number | null, repos: [string, string][]): Ticket => ({
  key, title: null, status: "in_progress" as Ticket["status"], statusManual: null, createdAt: 1, archivedAt: null, featureId,
  repos: repos.map(([repoPath, branch], i) => ({ id: i + 1, ticketKey: key, repoPath, workMode: "worktree", worktreePath: null, branch, createdAt: 1, worktreeRemovedAt: null, cleanupBlocked: null })),
});

const feature = (id: number, repos: string[]): Feature => ({
  id, name: `f${id}`, workspaceDir: "/w", createdAt: 1, archivedAt: null, brief: null, automationLevel: null,
  repos: repos.map((repoPath, i) => ({ id: i + 1, featureId: id, repoPath, createdAt: 1 })),
});

const stack = (id: number, over: Partial<StackView>, layers: [string, string | null][]): StackView => ({
  id, name: `s${id}`, repoPath: repo, repoSlug: null, trunk: "main", featureId: null, source: "mcp", mergeMethod: null,
  autoRebase: true, autoRebaseBy: "policy", overviewUrl: null, lastRun: null, restorable: null,
  layers: layers.map(([branch, ticketKey], i) => ({
    id: id * 10 + i, position: i, branch, ticketKey, ticketTitle: null, mode: "branch", state: i === 0 ? "ready" : "branch_only",
    prNumber: null, prUrl: null, behind: 0, lastRebaseAt: null, draftSince: null, mergedAt: null, unpushed: false,
  })),
  ...over,
});

function setup(stacks: StackView[] = []) {
  const tickets = [
    ticket("A-1", 1, [[repo, "a1"]]),
    ticket("A-2", 1, [[repo, "a2"], [other, "a2"]]),
    ticket("B-1", 2, [[repo, "b1"]]),
  ];
  const features = [feature(1, [repo, other]), feature(2, [repo])];
  const service = {
    view: vi.fn(async () => ({ stacks })),
    define: vi.fn(async () => ({ ok: true as const, stackId: 5 })),
    rebaseNow: vi.fn(async () => ({ ok: true as const, message: "rebased" })),
    setLayerMode: vi.fn(async () => ({ ok: true as const })),
    canStackOn: vi.fn(() => ({ ok: true as const })),
    stackOn: vi.fn(async () => ({ ok: true as const })),
  };
  const deps: StackControlDeps = {
    service: service as unknown as StackControlDeps["service"],
    tickets: () => tickets,
    features: { get: (id) => features.find((f) => f.id === id) ?? null, list: () => features },
  };
  return { c: new StackControl(deps), service };
}

const value = (r: { ok: boolean }) => (r as unknown as { value: unknown }).value;

describe("StackControl (workstream K)", () => {
  it("lists only the stacks of the scope", async () => {
    const mine = stack(1, { featureId: 1 }, [["a1", "A-1"], ["a2", "A-2"]]);
    const byTicket = stack(2, {}, [["x", null], ["b1", "B-1"]]);
    const loose = stack(3, {}, [["y", null], ["z", null]]);
    const { c } = setup([mine, byTicket, loose]);
    const ids = async (scope: Parameters<StackControl["handle"]>[0]) =>
      (value(await c.handle(scope, { op: "list_stacks" })) as { id: number }[]).map((s) => s.id);
    expect(await ids({ kind: "feature", featureId: 1 })).toEqual([1]);
    expect(await ids({ kind: "feature", featureId: 2 })).toEqual([2]);
    expect(await ids({ kind: "shipherd" })).toEqual([1, 2, 3]);
  });

  it("refuses another feature's stack and unknown stacks", async () => {
    const { c, service } = setup([stack(1, { featureId: 2 }, [["b1", "B-1"], ["c", null]])]);
    expect(await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_rebase", stack: 1 })).toMatchObject({ ok: false });
    expect(await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_rebase", stack: 7 })).toMatchObject({ ok: false });
    expect(service.rebaseNow).not.toHaveBeenCalled();
    expect(await c.handle({ kind: "feature", featureId: 2 }, { op: "stack_rebase", stack: 1 })).toMatchObject({ ok: true, value: { result: "rebased" } });
    // 总控调的 stack_rebase 记成总控确认的（BTL-278），和用户在界面上点的分开
    expect(service.rebaseNow).toHaveBeenLastCalledWith(1, "coordinator");
  });

  it("sets a layer's mode by branch", async () => {
    const { c, service } = setup([stack(1, { featureId: 1 }, [["a1", "A-1"], ["a2", "A-2"]])]);
    expect(await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_layer_mode", stack: 1, branch: "nope", mode: "draft" })).toMatchObject({ ok: false });
    await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_layer_mode", stack: 1, branch: "a2", mode: "draft" });
    expect(service.setLayerMode).toHaveBeenCalledWith(11, "draft");
  });

  it("defines a stack from ticket ids, finding the repo they share", async () => {
    const { c, service } = setup();
    // feature 1 有两个仓库：没给 repo 时从 ticket 号推出 shop
    expect((await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_define", branches: ["a-1", "A-2"] })).ok).toBe(true);
    expect(service.define).toHaveBeenCalledWith(expect.objectContaining({ repoPath: repo, branches: ["a1", "a2"], featureId: 1, source: "mcp", stackId: null }));
  });

  it("asks for the repo when it cannot tell, and checks ticket repos", async () => {
    const { c, service } = setup();
    expect(await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_define", branches: ["x", "y"] })).toMatchObject({ ok: false });
    expect(await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_define", branches: ["A-1", "A-2"], repo: "api" })).toMatchObject({ ok: false });
    expect(await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_define", branches: ["x", "y"], repo: "nowhere" })).toMatchObject({ ok: false });
    expect(service.define).not.toHaveBeenCalled();
    await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_define", branches: ["a1", "a2"], repo: "SHOP" });
    expect(service.define).toHaveBeenCalledWith(expect.objectContaining({ repoPath: repo, branches: ["a1", "a2"] }));
  });

  it("lets a feature coordinator change only stacks whose open layers are all its own", async () => {
    // 栈不记 feature；有一层是 B-1（feature 2），另一层不是任何 ticket 的
    const mixed = stack(2, {}, [["x", null], ["b1", "B-1"]]);
    const { c, service } = setup([mixed]);
    // 看得到（有一层是它的），改不了
    expect((value(await c.handle({ kind: "feature", featureId: 2 }, { op: "list_stacks" })) as { id: number }[]).map((s) => s.id)).toEqual([2]);
    expect(await c.handle({ kind: "feature", featureId: 2 }, { op: "stack_rebase", stack: 2 })).toMatchObject({ ok: false });
    expect(await c.handle({ kind: "feature", featureId: 2 }, { op: "stack_layer_mode", stack: 2, branch: "b1", mode: "draft" })).toMatchObject({ ok: false });
    expect(service.rebaseNow).not.toHaveBeenCalled();
    expect(service.setLayerMode).not.toHaveBeenCalled();
    // 别的 feature 的分支不能放进自己的栈
    expect(await c.handle({ kind: "feature", featureId: 1 }, { op: "stack_define", branches: ["a1", "b1"], repo: "shop" })).toMatchObject({ ok: false });
    expect(service.define).not.toHaveBeenCalled();
    // Shipherd 总控都行
    expect(await c.handle({ kind: "shipherd" }, { op: "stack_rebase", stack: 2 })).toMatchObject({ ok: true });
    expect(service.rebaseNow).toHaveBeenLastCalledWith(2, "shipherd");
  });

  it("records the feature for a Shipherd-control stack only when every ticket shares it", async () => {
    const { c, service } = setup();
    await c.handle({ kind: "shipherd" }, { op: "stack_define", branches: ["a1", "a2"], repo: repo });
    expect(service.define).toHaveBeenLastCalledWith(expect.objectContaining({ featureId: 1 }));
    await c.handle({ kind: "shipherd" }, { op: "stack_define", branches: ["a1", "b1"], repo: repo });
    expect(service.define).toHaveBeenLastCalledWith(expect.objectContaining({ featureId: null }));
  });

  it("prepares stack_on: the parent must be in the feature and have every repo", () => {
    const { c, service } = setup();
    expect(c.prepareStackOn(1, "a-1", [repo])).toEqual({ startPoints: [{ repoPath: repo, ref: "a1" }] });
    expect(c.prepareStackOn(1, "B-1", [repo])).toHaveProperty("error");
    expect(c.prepareStackOn(1, "A-1", [repo, other])).toHaveProperty("error");
    service.canStackOn.mockReturnValueOnce({ ok: false, message: "not the top" } as never);
    expect(c.prepareStackOn(1, "A-1", [repo])).toEqual({ error: "not the top" });
  });

  it("finishes stack_on per repo and collects what failed", async () => {
    const { c, service } = setup();
    const f = feature(1, [repo, other]);
    const t = ticket("A-3", 1, [[repo, "a3"], [other, "a3"]]);
    service.stackOn.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, message: "boom" } as never);
    const problems = await c.finishStackOn(f, t, [{ repoPath: repo, ref: "a2" }, { repoPath: other, ref: "a2" }]);
    expect(service.stackOn).toHaveBeenNthCalledWith(1, { repoPath: repo, parentBranch: "a2", branch: "a3", featureId: 1 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("boom");
  });
});
