import { describe, expect, it } from "vitest";
import type { StageEvent, StageEventKind } from "../db/pr-stage-repo";
import type { PrStageId, PrStagesView } from "../../shared/pr-stages";
import { derivePrStages, type DeriveInput } from "./pr-stages";

let nextId = 1;
const ev = (kind: StageEventKind, at: number, data: Record<string, unknown> = {}): StageEvent => ({
  id: nextId++, ticketKey: "BTL-1", repoId: 1, branch: kind === "skill" ? null : "b", featureId: null, epicId: null,
  sessionId: null, kind, at, data,
});
const design = (at: number) => ev("skill", at, { name: "superpowers:brainstorming", category: "design" });
const reviewSkill = (at: number) => ev("skill", at, { name: "code-review", category: "review" });
const ci = (at: number, result: "pending" | "passing" | "failing") => ev("ci", at, { result, sha: `s${at}` });
const human = (at: number, state: string, author = "alice") =>
  ev("review", at, { id: at, author, who: "human", state, body: "" });

const input = (o: Partial<DeriveInput> = {}): DeriveInput => ({
  ticketKey: "BTL-1", featureId: null, repoId: 1, repoName: "repo", branch: "b", ticketCreatedAt: 100,
  events: [], upperDesign: [], reports: [], pr: { number: 7, url: "https://x/pull/7", state: "open" },
  skillTracking: true, ...o,
});
const cell = (v: PrStagesView, id: PrStageId) => v.stages.find((s) => s.id === id)!;
const states = (v: PrStagesView) => Object.fromEntries(v.stages.map((s) => [s.id, s.state]));
/** 每个用例最后都检查：同一时间最多一步"进行中"。 */
const derive = (i: DeriveInput): PrStagesView => {
  const v = derivePrStages(i);
  expect(v.stages.filter((s) => s.state === "active").map((s) => s.id).length, JSON.stringify(states(v))).toBeLessThanOrEqual(1);
  return v;
};

describe("derivePrStages", () => {
  it("walks the happy path: all six done in round 1, seven timeline rows", () => {
    const v = derive(input({
      events: [design(110), ev("first_commit", 120), reviewSkill(130), ci(140, "pending"), ci(150, "passing"),
        human(160, "APPROVED"), ev("merged", 170, { number: 7 })],
    }));
    expect(v.stages.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(v.stages.every((s) => s.round === 1)).toBe(true);
    expect(v.timeline.map((t) => t.kind)).toEqual(
      ["design_skill", "first_commit", "review_skill", "ci_pending", "ci_passed", "human_approved", "merged"]);
    expect(v.timeline[0].detail).toBe("superpowers:brainstorming");
    expect(v.timeline[5].detail).toBe("alice");
    expect(v.prNumber).toBe(7);
    expect(v.prUrl).toBe("https://x/pull/7");
    expect(v.closed).toBe(false);
  });

  it("design without a design skill: skipped when tracking, unknown when not", () => {
    const events = [ev("first_commit", 120)];
    expect(cell(derive(input({ events })), "design").state).toBe("skipped");
    expect(cell(derive(input({ events, skillTracking: false })), "design").state).toBe("unknown");
  });

  it("design done at feature level only when the upper design predates the ticket", () => {
    const events = [ev("first_commit", 120)];
    const before = { ...design(90), ticketKey: null, featureId: 3 };
    const after = { ...design(105), ticketKey: null, featureId: 3 };
    expect(cell(derive(input({ events, upperDesign: [before] })), "design").state).toBe("feature_level");
    expect(cell(derive(input({ events, upperDesign: [after] })), "design").state).toBe("skipped");
  });

  it("CI failure then push starts round 2 back at dev", () => {
    const events = [ev("first_commit", 120), ci(140, "pending"), ci(150, "failing")];
    const failed = derive(input({ events }));
    expect(cell(failed, "ci").state).toBe("failed");

    const v = derive(input({ events: [...events, ev("push", 160, { sha: "s2" })] }));
    expect(cell(v, "dev")).toMatchObject({ state: "active", round: 2 });
    expect(cell(v, "ci")).toMatchObject({ state: "todo", round: 2 });
    const push = v.timeline.find((t) => t.kind === "push")!;
    expect(push).toMatchObject({ back: true, stage: "dev" });
  });

  it("changes requested then push, re-CI and approval: peer review done in round 2", () => {
    const v = derive(input({
      events: [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"), human(160, "CHANGES_REQUESTED"),
        ev("push", 170, { sha: "s2" }), ci(180, "pending"), ci(190, "passing"), human(200, "APPROVED")],
    }));
    expect(cell(v, "peer_review")).toMatchObject({ state: "done", round: 2 });
    expect(cell(v, "merge")).toMatchObject({ state: "active", round: 2 });
    expect(v.timeline.find((t) => t.kind === "human_changes")?.detail).toBe("alice");
    expect(v.timeline.find((t) => t.kind === "push")?.back).toBe(true);
  });

  it("Review Focus 1: merged without any human review → peer review skipped, merge done", () => {
    const v = derive(input({
      events: [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"), ev("merged", 160, { number: 7 })],
    }));
    expect(cell(v, "peer_review").state).toBe("skipped");
    expect(cell(v, "merge").state).toBe("done");
  });

  it("Review Focus 2: only Copilot reviewed → peer review skipped, Copilot only on the timeline", () => {
    const v = derive(input({
      events: [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"),
        ev("review", 155, { id: 99, author: "copilot", who: "copilot", state: "COMMENTED", body: "" }),
        ev("comment", 155, { id: 1, reviewId: 99, author: "copilot", who: "copilot", body: "a", path: "x", line: 1, url: null }),
        ev("comment", 155, { id: 2, reviewId: 99, author: "copilot", who: "copilot", body: "b", path: "y", line: 2, url: null }),
        ev("comment", 156, { id: 3, reviewId: null, author: "bob", who: "human", body: "c", path: null, line: null, url: null }),
        ev("merged", 160, { number: 7 })],
    }));
    expect(cell(v, "peer_review").state).toBe("skipped");
    const copilot = v.timeline.find((t) => t.kind === "copilot_review")!;
    expect(copilot).toMatchObject({ stage: "peer_review", detail: "2" });
  });

  it("an APPROVED review by the PR author changes nothing", () => {
    const base = [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing")];
    const author = ev("review", 160, { id: 5, author: "me", who: "author", state: "APPROVED", body: "" });
    const v = derive(input({ events: [...base, author] }));
    expect(states(v)).toEqual(states(derive(input({ events: base }))));
    expect(cell(v, "peer_review").state).toBe("active");
    expect(v.timeline.some((t) => t.kind === "human_approved")).toBe(false);
  });

  it("closed → closed=true, from the event or from the PR row", () => {
    const v = derive(input({ events: [ev("first_commit", 120), ev("closed", 130, { number: 7 })] }));
    expect(v.closed).toBe(true);
    expect(v.timeline.at(-1)?.kind).toBe("closed");
    expect(derive(input({ pr: { number: 7, url: null, state: "closed" } })).closed).toBe(true);
  });

  it("a report during CI lands on the timeline at the ci stage", () => {
    const long = "x".repeat(300);
    const v = derive(input({
      events: [ev("first_commit", 120), ci(140, "pending"), ci(160, "passing")],
      reports: [{ at: 150, text: long }],
    }));
    const r = v.timeline.find((t) => t.kind === "report")!;
    expect(r).toMatchObject({ stage: "ci", at: 150 });
    expect(r.detail).toBe("x".repeat(200));
    expect(v.timeline.map((t) => t.kind)).toEqual(["first_commit", "ci_pending", "report", "ci_passed"]);
  });

  it("a PR without a first_commit event: the first ci pending completes dev", () => {
    const v = derive(input({ events: [ci(140, "pending")] }));
    expect(cell(v, "dev").state).toBe("done");
    expect(cell(v, "ci").state).toBe("active");
    expect(cell(v, "design").state).toBe("skipped");
    expect(v.timeline.map((t) => t.kind)).toEqual(["ci_pending"]);
  });

  it("ci pending during an unfailed peer review goes back to ci in the same round", () => {
    const v = derive(input({
      events: [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"), ev("push", 160, { sha: "s2" }),
        ci(170, "pending")],
    }));
    expect(cell(v, "ci")).toMatchObject({ state: "active", round: 1 });
    expect(cell(v, "peer_review").state).toBe("todo");
    expect(v.stages.every((s) => s.round === 1)).toBe(true);
    expect(v.timeline.find((t) => t.kind === "push")?.back).toBe(false);
  });

  it("no events: design todo when tracking, unknown when not; the rest todo", () => {
    expect(states(derive(input()))).toEqual(
      { design: "todo", dev: "todo", self_review: "todo", ci: "todo", peer_review: "todo", merge: "todo" });
    expect(cell(derive(input({ skillTracking: false })), "design").state).toBe("unknown");
  });

  it("states freeze after a closed event; a closed PR row alone does not freeze", () => {
    const v = derive(input({ events: [ev("first_commit", 120), ev("closed", 130), ci(140, "pending")] }));
    expect(cell(v, "ci").state).toBe("todo");
    expect(v.timeline.map((t) => t.kind)).toEqual(["first_commit", "closed", "ci_pending"]);
    const row = derive(input({ pr: { number: 7, url: null, state: "closed" }, events: [ev("first_commit", 120), ci(140, "pending")] }));
    expect(cell(row, "ci").state).toBe("active");
  });

  it("states freeze after a merged event: later ci, review and push only add timeline rows", () => {
    const v = derive(input({ events: [ev("first_commit", 120), ci(140, "pending"), ev("merged", 150, { number: 7 }), ci(160, "passing"), human(170, "CHANGES_REQUESTED"), ev("push", 180, { sha: "x" })] }));
    expect(states(v)).toMatchObject({ ci: "unknown", peer_review: "skipped", merge: "done" });
    expect(v.timeline.map((t) => t.kind)).toEqual(["first_commit", "ci_pending", "merged", "ci_passed", "human_changes", "push"]);
  });

  it("a CI result seen without its pending still moves the bar", () => {
    const v = derive(input({ events: [ev("first_commit", 120), ci(140, "passing")] }));
    expect(states(v)).toMatchObject({ dev: "done", ci: "done", peer_review: "active" });
    const f = derive(input({ events: [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"), ci(160, "failing")] }));
    expect(states(f)).toMatchObject({ ci: "failed", peer_review: "todo" });
  });

  it("an approval before CI finishes is kept through merge", () => {
    const v = derive(input({
      events: [ev("first_commit", 120), ci(140, "pending"), human(145, "APPROVED"), ci(150, "passing"), ev("merged", 160)],
    }));
    expect(states(v)).toMatchObject({ ci: "done", peer_review: "done", merge: "done" });
  });

  it("merge without skill tracking leaves self review unknown, not skipped", () => {
    const v = derive(input({ skillTracking: false, events: [ev("pr_opened", 130), ev("merged", 160)] }));
    expect(states(v)).toEqual(
      { design: "unknown", dev: "done", self_review: "unknown", ci: "skipped", peer_review: "skipped", merge: "done" });
    const running = derive(input({ events: [ev("first_commit", 120), ci(140, "pending"), ev("merged", 160)] }));
    expect(cell(running, "ci").state).toBe("unknown");
  });

  it("a CI result after CHANGES_REQUESTED during CI is written to the ci cell; cur stays at peer review", () => {
    const base = [ev("first_commit", 120), ci(140, "pending"), human(145, "CHANGES_REQUESTED")];
    expect(states(derive(input({ events: [...base, ci(150, "passing")] })))).toMatchObject({ ci: "done", peer_review: "failed" });
    const failed = derive(input({ events: [...base, ci(150, "failing")] }));
    expect(states(failed)).toMatchObject({ ci: "failed", peer_review: "failed" });
    const v = derive(input({ events: [...base, ci(150, "failing"), ev("push", 160)] }));
    expect(cell(v, "dev")).toMatchObject({ state: "active", round: 2 });
    expect(v.timeline.find((t) => t.kind === "push")?.back).toBe(true);
  });

  it("CHANGES_REQUESTED after an approval puts merge back to todo", () => {
    const v = derive(input({
      events: [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"), human(160, "APPROVED"),
        human(170, "CHANGES_REQUESTED", "bob")],
    }));
    expect(states(v)).toMatchObject({ peer_review: "failed", merge: "todo" });
  });

  it("an approval while CI runs marks peer review done and leaves merge todo until CI ends", () => {
    const base = [ev("first_commit", 120), ci(140, "pending"), human(145, "APPROVED")];
    expect(states(derive(input({ events: base })))).toMatchObject({ ci: "active", peer_review: "done", merge: "todo" });
    expect(states(derive(input({ events: [...base, ci(150, "passing")] }))))
      .toMatchObject({ ci: "done", peer_review: "done", merge: "active" });
    const failed = derive(input({ events: [...base, ci(150, "failing")] }));
    expect(states(failed)).toMatchObject({ ci: "failed", peer_review: "done", merge: "todo" });
    const back = derive(input({ events: [...base, ci(150, "failing"), ev("push", 160)] }));
    expect(states(back)).toMatchObject({ dev: "active", ci: "todo", peer_review: "todo", merge: "todo" });
    expect(cell(back, "dev").round).toBe(2);
  });

  it("pr_opened ends dev and self review and moves the bar to ci without starting it", () => {
    const opened = derive(input({ events: [ev("first_commit", 120), reviewSkill(125), ev("pr_opened", 130)] }));
    expect(states(opened)).toMatchObject({ dev: "done", self_review: "done", ci: "todo" });
    expect(opened.timeline.at(-1)).toMatchObject({ kind: "pr_opened" });
    const noSkill = derive(input({ events: [ev("first_commit", 120), ev("pr_opened", 130)] }));
    expect(states(noSkill)).toMatchObject({ dev: "done", self_review: "skipped", ci: "todo" });
    const thenCi = derive(input({ events: [ev("first_commit", 120), ev("pr_opened", 130), ci(140, "pending")] }));
    expect(states(thenCi)).toMatchObject({ dev: "done", ci: "active" });
  });

  it("no CI: pr_opened → human APPROVED → merged", () => {
    const evs = [ev("first_commit", 120), ev("pr_opened", 130), human(140, "APPROVED"), ev("merged", 150)];
    expect(states(derive(input({ events: evs.slice(0, 3) })))).toMatchObject({ dev: "done", ci: "todo", peer_review: "done", merge: "active" });
    expect(states(derive(input({ events: evs })))).toEqual(
      { design: "skipped", dev: "done", self_review: "skipped", ci: "skipped", peer_review: "done", merge: "done" });
  });

  it("ci pending while already at ci changes nothing; after a failure the next push still goes back", () => {
    const rerun = derive(input({ events: [ev("first_commit", 120), ci(140, "pending"), ci(150, "pending")] }));
    expect(cell(rerun, "ci")).toMatchObject({ state: "active", round: 1 });
    const evs = [ev("first_commit", 120), ci(140, "pending"), ci(150, "failing"), ci(160, "pending")];
    expect(cell(derive(input({ events: evs })), "ci").state).toBe("failed");
    const v = derive(input({ events: [...evs, ev("push", 170)] }));
    expect(cell(v, "dev")).toMatchObject({ state: "active", round: 2 });
    expect(v.timeline.find((t) => t.kind === "push")?.back).toBe(true);
  });

  it("approve → re-push → pending → pass → merged keeps the approval", () => {
    const v = derive(input({
      events: [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"), human(160, "APPROVED"), ev("push", 170),
        ci(180, "pending"), ci(190, "passing"), ev("merged", 200)],
    }));
    expect(states(v)).toMatchObject({ dev: "done", ci: "done", peer_review: "done", merge: "done" });
    expect(v.stages.every((s) => s.round === 1)).toBe(true);
  });

  it("merged while dev is active with skill tracking", () => {
    const v = derive(input({ events: [ev("first_commit", 120), ev("merged", 150)] }));
    expect(states(v)).toEqual(
      { design: "skipped", dev: "done", self_review: "skipped", ci: "skipped", peer_review: "skipped", merge: "done" });
  });

  it("merged alone triggers the implied first_commit", () => {
    const v = derive(input({ events: [ev("merged", 150)] }));
    expect(states(v)).toEqual(
      { design: "skipped", dev: "done", self_review: "skipped", ci: "skipped", peer_review: "skipped", merge: "done" });
    expect(cell(v, "dev").at).toBe(150);
    expect(v.timeline.map((t) => t.kind)).toEqual(["merged"]);
  });

  it("skips malformed rows without throwing", () => {
    const v = derive(input({
      events: [ev("first_commit", 120), ev("ci", 130, {}), ev("ci", 131, { result: 3 }), ev("review", 132, { who: "human" }),
        ev("skill", 133, { name: 5 }), ev("comment", 134, {}), { ...ci(135, "pending"), at: Number.NaN }],
    }));
    expect(cell(v, "dev").state).toBe("active");
    expect(v.timeline.map((t) => t.kind)).toEqual(["first_commit"]);
  });
});
