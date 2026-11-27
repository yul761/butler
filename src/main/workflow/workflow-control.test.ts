import { afterEach, describe, expect, it } from "vitest";
import type { ControlResult } from "../../shared/control";
import type { Feature, Session, Ticket } from "../../shared/types";
import { WorkflowRepo } from "../db/workflow-repo";
import { setLang } from "../i18n";
import { memDb } from "../test-utils";
import { workflowControl } from "./workflow-control";
import { WorkflowService } from "./workflow-service";

afterEach(() => setLang("zh"));

const feature = (id: number, name: string): Feature => ({ id, name, archivedAt: null }) as Feature;
const ticket = (key: string, featureId: number | null, path = "/r/a"): Ticket => ({
  key, title: null, status: "in_progress" as Ticket["status"], statusManual: null, createdAt: 1, archivedAt: null, featureId,
  repos: [{ id: key.length, ticketKey: key, repoPath: path, workMode: "worktree", worktreePath: null, branch: `feature/${key}`, createdAt: 1, worktreeRemovedAt: null, cleanupBlocked: null }],
});

function setup() {
  const repo = new WorkflowRepo(memDb());
  const features = [feature(4, "4.3.0"), feature(5, "other")];
  const tickets = [ticket("A-1", 4), ticket("B-1", 5)];
  const sessions = new Map<string, Session>([
    ["dev-a", { id: "dev-a", ticketKey: "A-1" } as Session],
    ["dev-b", { id: "dev-b", ticketKey: "B-1" } as Session],
  ]);
  const service = new WorkflowService({
    repo,
    tickets: { get: (k) => tickets.find((t) => t.key === k) ?? null, list: () => tickets },
    featureName: (id) => features.find((f) => f.id === id)?.name ?? null,
    productsOf: () => [{ id: 9, name: "Shipherd" }],
    productName: (id) => (id === 9 ? "Shipherd" : null),
    slugOf: () => "o/a",
    prs: { byTicket: () => [] },
    stages: { forTicket: () => [] },
    preReviews: { latestFor: () => null, latestForBranch: () => null },
    headSha: async () => null,
    level: () => "semi",
    mailbox: { send: () => {}, withdraw: () => {} },
    recipient: () => null,
    coordinator: () => null,
    session: (id) => sessions.get(id) ?? null,
    requestBotReview: async () => ({ ok: true, via: "api" }),
    reviewCommentCount: async () => 0,
    ghCwd: () => null,
    now: () => 1000,
    log: () => {},
    onChange: () => {},
  });
  const ctl = workflowControl({
    service,
    products: () => [{ id: 9, name: "Shipherd" }],
    features: { get: (id) => features.find((f) => f.id === id) ?? null, list: () => features },
    tickets: { get: (k) => tickets.find((t) => t.key === k) ?? null, listByFeature: (id) => tickets.filter((t) => t.featureId === id) },
    sessions: { head: (id) => sessions.get(id) ?? null },
  });
  return { ctl, service, repo };
}

const value = (r: ControlResult) => {
  if (!r.ok) throw new Error(r.error);
  return r.value as Record<string, unknown>;
};

describe("workflow tools", () => {
  it("an epic coordinator sets its own epic by default and reads where each ticket is", () => {
    const t = setup();
    const r = value(t.ctl.coordinator({ op: "set_workflow", steps: ["implement", "self_review", "open_pr", "ci_green", { id: "merge", mergeBy: "coordinator" }] }, { featureId: 4 }));
    expect(r).toMatchObject({ scope: "epic:4.3.0", changed: true, note: expect.stringContaining("设好了") });
    expect(t.service.effective("A-1")?.scope).toEqual({ kind: "feature", featureId: 4 });
    expect(t.service.effective("B-1")).toBeNull();
    const g = value(t.ctl.coordinator({ op: "get_workflow" }, { featureId: 4 }));
    expect(g).toMatchObject({ scope: "epic:4.3.0", set: true, tickets: [{ ticket: "A-1", source: "feature:4", current: "implement", done: 0, total: 5 }] });
    // 同样的再设一次：没改
    expect(value(t.ctl.coordinator({ op: "set_workflow", steps: ["implement", "self_review", "open_pr", "ci_green", { id: "merge", mergeBy: "coordinator" }] }, { featureId: 4 }))).toMatchObject({ changed: false });
  });

  it("an epic coordinator can't change global, another epic, or another epic's ticket", () => {
    const t = setup();
    for (const scope of ["global", "product:Shipherd", "repo:o/a", "epic:other", "ticket:B-1"]) {
      const r = t.ctl.coordinator({ op: "set_workflow", scope, steps: ["implement", "open_pr"] }, { featureId: 4 });
      expect(r, scope).toEqual({ v: 1, ok: false, error: expect.stringContaining("epic 总控只能改") });
    }
    expect(t.repo.layers()).toEqual([]);
    expect(value(t.ctl.coordinator({ op: "set_workflow", scope: "ticket:a-1", steps: ["implement", "open_pr"] }, { featureId: 4 }))).toMatchObject({ scope: "ticket:A-1" });
  });

  it("setting a workflow without a merge step says the user merges", () => {
    const t = setup();
    const r = value(t.ctl.coordinator({ op: "set_workflow", steps: ["implement", "open_pr"] }, { featureId: 4 }));
    expect(r.note).toContain("没有合并这一步：由用户自己合");
    const m = value(t.ctl.coordinator({ op: "set_workflow", steps: ["implement", "open_pr", "merge"] }, { featureId: 4 }));
    expect(m.note).not.toContain("没有合并这一步");
  });

  it("the global coordinator sets any layer and lists them all", () => {
    const t = setup();
    value(t.ctl.coordinator({ op: "set_workflow", scope: "global", steps: ["implement", "open_pr", "ci_green", "merge"] }, { shipherd: true }));
    value(t.ctl.coordinator({ op: "set_workflow", scope: "product:shipherd", steps: ["implement", "open_pr"] }, { shipherd: true }));
    value(t.ctl.coordinator({ op: "set_workflow", scope: "epic:5", steps: ["implement", "open_pr"], notes: "别改版本号" }, { shipherd: true }));
    const g = value(t.ctl.coordinator({ op: "get_workflow" }, { shipherd: true }));
    expect((g.layers as { scope: string }[]).map((l) => l.scope)).toEqual(["global", "product:Shipherd", "epic:other"]);
    const a = value(t.ctl.coordinator({ op: "get_workflow", ticket: "B-1" }, { shipherd: true }));
    expect(a).toMatchObject({ ticket: "B-1", from: "epic:other", current: "implement" });
    expect((a.layers as { scope: string }[]).map((l) => l.scope)).toEqual(["global", "product:Shipherd", "epic:other"]);
    // 清掉
    expect(value(t.ctl.coordinator({ op: "set_workflow", scope: "epic:other", steps: null }, { shipherd: true }))).toMatchObject({ changed: true, note: expect.stringContaining("清掉了") });
  });

  it("explains bad scopes and bad workflows", () => {
    const t = setup();
    expect(t.ctl.coordinator({ op: "set_workflow", scope: "product:nope", steps: ["implement"] }, { shipherd: true })).toMatchObject({ ok: false, error: expect.stringContaining("Shipherd") });
    expect(t.ctl.coordinator({ op: "set_workflow", scope: "repo:nope", steps: ["implement"] }, { shipherd: true })).toMatchObject({ ok: false });
    expect(t.ctl.coordinator({ op: "set_workflow", scope: "epic:nope", steps: ["implement"] }, { shipherd: true })).toMatchObject({ ok: false, error: expect.stringContaining("nope") });
    expect(t.ctl.coordinator({ op: "set_workflow", steps: ["implement", "open_pr", "merge", "ci_green"] }, { shipherd: true })).toMatchObject({ ok: false, error: expect.stringContaining("最后") });
    setLang("en");
    expect(t.ctl.coordinator({ op: "set_workflow", steps: ["implement", "open_pr", "merge", "ci_green"] }, { shipherd: true })).toMatchObject({ ok: false, error: expect.stringContaining("last") });
  });

  it("lists presets and what each step means, in both languages", () => {
    const t = setup();
    const zh = value(t.ctl.coordinator({ op: "list_workflow_presets" }, { featureId: 4 }));
    expect((zh.presets as { id: string }[]).map((p) => p.id)).toEqual(["fast", "strict"]);
    expect((zh.steps as { id: string; name: string }[]).find((s) => s.id === "pre_review")).toMatchObject({ name: "预审" });
    setLang("en");
    const en = value(t.ctl.coordinator({ op: "list_workflow_presets" }, { shipherd: true }));
    expect(/[一-鿿]/.test(JSON.stringify(en))).toBe(false);
  });

  it("only the ticket's own session marks its steps", () => {
    const t = setup();
    t.service.setLayer({ kind: "global" }, { steps: ["implement", "self_review", "open_pr"] });
    const a = ticket("A-1", 4);
    expect(t.ctl.ticketStep({ op: "workflow_step_done", step: "implement", from: "dev-b" }, a)).toMatchObject({ ok: false, error: expect.stringContaining("自己的 session") });
    expect(t.ctl.ticketStep({ op: "workflow_step_done", step: "implement", from: null }, a)).toMatchObject({ ok: false });
    expect(t.repo.done("A-1")).toEqual([]);
    expect(value(t.ctl.ticketStep({ op: "workflow_step_done", step: "implement", from: "dev-a", note: "done" }, a))).toMatchObject({ current: "self_review" });
    expect(t.repo.done("A-1")).toMatchObject([{ step: "implement", source: "session", detail: "done" }]);
  });
});
