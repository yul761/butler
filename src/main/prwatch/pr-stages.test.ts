import { describe, expect, it } from "vitest";
import type { StageEvent, StageEventKind } from "../db/pr-stage-repo";
import type { PrStageId } from "../../shared/pr-stages";
import { derivePrStages, type DeriveInput, type DerivedStages } from "./pr-stages";

let nextId = 1;
const ev = (kind: StageEventKind, at: number, data: Record<string, unknown> = {}): StageEvent => ({
  id: nextId++, ticketKey: "BTL-1", repoId: 1, prId: null, branch: kind === "skill" ? null : "b", featureId: null,
  sessionId: null, kind, at, data,
});
const design = (at: number) => ev("skill", at, { name: "superpowers:brainstorming", category: "design" });
const reviewSkill = (at: number) => ev("skill", at, { name: "code-review", category: "review" });
const ci = (at: number, result: "pending" | "passing" | "failing") => ev("ci", at, { result, sha: `s${at}` });
const human = (at: number, state: string, author = "alice") =>
  ev("review", at, { id: at, author, who: "human", state, body: "" });

const humanId = (at: number, state: string, id: string, author = "alice") =>
  ev("review", at, { id, author, who: "human", state, body: "" });

const pr = (o: Pick<NonNullable<DeriveInput["pr"]>, "number" | "url" | "state"> & Partial<NonNullable<DeriveInput["pr"]>>): DeriveInput["pr"] => ({
  ci: "none", review: null, mergedAt: null, closedAt: null, checkedAt: 0, ...o,
});
const input = (o: Partial<DeriveInput> = {}): DeriveInput => ({
  ticketKey: "BTL-1", featureId: null, repoId: 1, repoName: "repo", branch: "b", ticketCreatedAt: 100,
  events: [], upperDesign: [], reports: [], pr: pr({ number: 7, url: "https://x/pull/7", state: "open" }),
  skillTrackingSince: 0, ...o,
});
const cell = (v: DerivedStages, id: PrStageId) => v.stages.find((s) => s.id === id)!;
const states = (v: DerivedStages) => Object.fromEntries(v.stages.map((s) => [s.id, s.state]));
/** 每个用例最后都检查：同一时间最多一步"进行中"。 */
const derive = (i: DeriveInput): DerivedStages => {
  const v = derivePrStages(i);
  expect(v).not.toHaveProperty("branch");
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
    expect(cell(derive(input({ events, skillTrackingSince: null })), "design").state).toBe("unknown");
  });

  it("design done at feature level only when the upper design predates the first commit", () => {
    const events = [ev("first_commit", 120)];
    const before = { ...design(90), ticketKey: null, featureId: 3 };
    const after = { ...design(130), ticketKey: null, featureId: 3 };
    expect(cell(derive(input({ events, upperDesign: [before] })), "design").state).toBe("feature_level");
    expect(cell(derive(input({ events, upperDesign: [after] })), "design").state).toBe("skipped");
  });

  it("feature-level design after ticket creation but before the first commit counts", () => {
    const upper = { ...design(110), ticketKey: null, featureId: 3 };
    const v = derive(input({ events: [ev("first_commit", 120)], upperDesign: [upper] }));
    expect(cell(v, "design")).toMatchObject({ state: "feature_level", at: 120 });
    // 没有 first_commit 时以 pr_opened 为开发开始。
    const opened = derive(input({ events: [ev("pr_opened", 130)], upperDesign: [{ ...design(125), ticketKey: null, featureId: 3 }] }));
    expect(cell(opened, "design").state).toBe("feature_level");
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

  it("closed follows the PR row: true only when the row is closed", () => {
    const closedRow = pr({ number: 7, url: "u", state: "closed", closedAt: 130, checkedAt: 500 });
    const v = derive(input({ pr: closedRow, events: [ev("first_commit", 120), ev("closed", 130, { number: 7 })] }));
    expect(v.closed).toBe(true);
    expect(v.timeline.at(-1)?.kind).toBe("closed");
    expect(derive(input({ pr: closedRow })).closed).toBe(true);
    expect(derive(input({ events: [ev("first_commit", 120), ev("closed", 130, { number: 7 })] })).closed).toBe(false);
    expect(derive(input({ pr: null, events: [ev("first_commit", 120)] })).closed).toBe(false);
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
    expect(cell(derive(input({ skillTrackingSince: null })), "design").state).toBe("unknown");
  });

  it("states freeze after the closed event of a closed PR; a closed row without one freezes at closedAt", () => {
    const closedRow = pr({ number: 7, url: "u", state: "closed", closedAt: 130, checkedAt: 500 });
    const v = derive(input({ pr: closedRow, events: [ev("first_commit", 120), ev("closed", 130), ci(140, "pending")] }));
    expect(cell(v, "ci").state).toBe("todo");
    expect(v.timeline.map((t) => t.kind)).toEqual(["first_commit", "closed", "ci_pending"]);
    const row = derive(input({ pr: closedRow, events: [ev("first_commit", 120), ci(140, "pending")] }));
    expect(cell(row, "ci").state).toBe("todo");
    expect(row.timeline.map((t) => [t.at, t.kind])).toEqual([[120, "first_commit"], [130, "closed"], [140, "ci_pending"]]);
    // closedAt 不会晚于 checkedAt；没有 closedAt 用 checkedAt。
    const late = derive(input({ pr: pr({ number: 7, url: "u", state: "closed", closedAt: 900, checkedAt: 135 }), events: [ev("first_commit", 120), ci(140, "pending")] }));
    expect(late.timeline.find((t) => t.kind === "closed")?.at).toBe(135);
    const noTime = derive(input({ pr: pr({ number: 7, url: "u", state: "closed", checkedAt: 135 }), events: [ev("first_commit", 120), ci(140, "pending")] }));
    expect(noTime.timeline.find((t) => t.kind === "closed")?.at).toBe(135);
    expect(cell(noTime, "ci").state).toBe("todo");
  });

  it("a closed then reopened PR is not frozen", () => {
    const v = derive(input({ events: [ev("first_commit", 120), ev("pr_opened", 125), ev("closed", 130, { number: 7 }), ci(140, "pending")] }));
    expect(v.closed).toBe(false);
    expect(cell(v, "ci").state).toBe("active");
    expect(v.timeline.map((t) => t.kind)).toEqual(["first_commit", "pr_opened", "closed", "ci_pending"]);
    // 关了、重开、又关了：只有最后一次关闭冻结。
    const again = derive(input({
      pr: pr({ number: 7, url: "u", state: "closed", closedAt: 160, checkedAt: 500 }),
      events: [ev("first_commit", 120), ev("pr_opened", 125), ev("closed", 130), ci(140, "pending"), ci(150, "passing"), ev("closed", 160), human(170, "APPROVED")],
    }));
    expect(again.closed).toBe(true);
    expect(states(again)).toMatchObject({ ci: "done", peer_review: "active" });
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
    const v = derive(input({ skillTrackingSince: null, events: [ev("pr_opened", 130), ci(140, "passing"), ev("merged", 160)] }));
    expect(states(v)).toEqual(
      { design: "unknown", dev: "done", self_review: "unknown", ci: "done", peer_review: "skipped", merge: "done" });
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
    // 批准跨 push 有效：peer review 保持完成，带进第 2 轮。
    expect(states(back)).toMatchObject({ dev: "active", ci: "todo", peer_review: "done", merge: "todo" });
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
    const v = derive(input({ events: [ev("first_commit", 120), ev("push", 130), ev("merged", 150)] }));
    expect(states(v)).toEqual(
      { design: "skipped", dev: "done", self_review: "skipped", ci: "skipped", peer_review: "skipped", merge: "done" });
    // 没观察过这个 PR（没有 ci、push、review）：没有证据的步骤是"未知"，不是"跳过"。
    const unobserved = derive(input({ events: [ev("first_commit", 120), ev("merged", 150)] }));
    expect(states(unobserved)).toEqual(
      { design: "skipped", dev: "done", self_review: "skipped", ci: "unknown", peer_review: "unknown", merge: "done" });
  });

  it("merged after an observed review triggers the implied dev start", () => {
    const v = derive(input({ events: [ev("review", 140, { id: 9, author: "c", who: "copilot", state: "COMMENTED", body: "" }), ev("merged", 150)] }));
    expect(states(v)).toEqual(
      { design: "skipped", dev: "done", self_review: "skipped", ci: "skipped", peer_review: "skipped", merge: "done" });
    expect(cell(v, "dev").at).toBe(150);
    // 只有 merged：什么都没观察到，除了合并都是未知。
    const alone = derive(input({ events: [ev("merged", 150)] }));
    expect(states(alone)).toEqual(
      { design: "unknown", dev: "unknown", self_review: "unknown", ci: "unknown", peer_review: "unknown", merge: "done" });
    expect(alone.timeline.map((t) => t.kind)).toEqual(["merged"]);
  });

  it("skips malformed rows without throwing", () => {
    const v = derive(input({
      events: [ev("first_commit", 120), ev("ci", 130, {}), ev("ci", 131, { result: 3 }), ev("review", 132, { who: "human" }),
        ev("skill", 133, { name: 5 }), ev("comment", 134, {}), { ...ci(135, "pending"), at: Number.NaN }],
    }));
    expect(cell(v, "dev").state).toBe("active");
    expect(v.timeline.map((t) => t.kind)).toEqual(["first_commit"]);
  });

  it("a merged row without a merged event uses the real mergedAt and does not pull later events in", () => {
    const merged = pr({ number: 7, url: "https://x/pull/7", state: "merged", mergedAt: 200, checkedAt: 500 });
    const v = derive(input({
      pr: merged,
      events: [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"), human(160, "APPROVED"), ci(300, "failing")],
    }));
    expect(states(v)).toEqual({ design: "skipped", dev: "done", self_review: "skipped", ci: "done", peer_review: "done", merge: "done" });
    expect(cell(v, "merge").at).toBe(200);
    expect(v.timeline.map((t) => [t.at, t.kind])).toEqual(
      [[120, "first_commit"], [140, "ci_pending"], [150, "ci_passed"], [160, "human_approved"], [200, "merged"], [300, "ci_failed"]]);
    // mergedAt 不晚于 checkedAt；没有 mergedAt 用 checkedAt。
    const capped = derive(input({ pr: { ...merged!, mergedAt: 900, checkedAt: 250 }, events: [ev("first_commit", 120), ci(300, "pending")] }));
    expect(capped.timeline.find((t) => t.kind === "merged")?.at).toBe(250);
    // 250 之后的 ci pending 不进进度：ci 是跳过，不是进行中。
    expect(cell(capped, "ci").state).toBe("skipped");
    const noTime = derive(input({ pr: { ...merged!, mergedAt: null, checkedAt: 250 }, events: [ev("first_commit", 120)] }));
    expect(noTime.timeline.find((t) => t.kind === "merged")?.at).toBe(250);
    // 已经有 merged 事件就不再补。
    const once = derive(input({ pr: merged, events: [ev("first_commit", 120), ev("merged", 150, { number: 7 })] }));
    expect(once.timeline.filter((t) => t.kind === "merged")).toHaveLength(1);
  });

  it("a backfilled merged PR with no history: ci seeded from the row, peer review from review, the rest unknown, merge done", () => {
    const row = pr({ number: 7, url: "u", state: "merged", ci: "passing", review: "approved", mergedAt: 200, checkedAt: 500 });
    const v = derive(input({ pr: row }));
    expect(states(v)).toEqual({ design: "unknown", dev: "unknown", self_review: "unknown", ci: "done", peer_review: "done", merge: "done" });
    expect(v.timeline.map((t) => [t.at, t.kind])).toEqual([[200, "merged"]]);
    const bad = derive(input({ pr: { ...row!, ci: "failing", review: "changes_requested" } }));
    expect(states(bad)).toMatchObject({ ci: "failed", peer_review: "failed", merge: "done" });
    // CI 还没出结果就合并：不知道结果，不标"进行中"。
    expect(states(derive(input({ pr: { ...row!, ci: "pending", review: null } })))).toMatchObject({ ci: "unknown", peer_review: "unknown" });
    // 有 ci 事件、人的 review 事件时不看 PR 行。
    const seen = derive(input({ pr: { ...row!, ci: "failing", review: "changes_requested" }, events: [ev("first_commit", 120), ci(140, "passing"), human(150, "APPROVED")] }));
    expect(states(seen)).toMatchObject({ ci: "done", peer_review: "done" });
  });

  it("an open PR without ci events takes ci pending from the row only when nothing else is active", () => {
    const row = pr({ number: 7, url: "u", state: "open", ci: "pending", checkedAt: 500 });
    expect(states(derive(input({ pr: row, events: [ev("first_commit", 120), ev("pr_opened", 130)] })))).toMatchObject({ dev: "done", ci: "active" });
    expect(states(derive(input({ pr: row, events: [ev("first_commit", 120)] })))).toMatchObject({ dev: "active", ci: "todo" });
    const approved = derive(input({ pr: { ...row!, ci: "passing", review: "approved" }, events: [ev("first_commit", 120), ci(140, "passing")] }));
    expect(states(approved)).toMatchObject({ ci: "done", peer_review: "done", merge: "active" });
  });

  it("a review skill after the first commit finishes dev: only self-review is active", () => {
    const v = derive(input({ pr: null, events: [ev("first_commit", 120), reviewSkill(130)] }));
    expect(cell(v, "dev").state).toBe("done");
    expect(cell(v, "self_review").state).toBe("active");
  });

  it("an approval after failed CI keeps the approval but stays on CI; the fix push starts round 2 with the approval carried", () => {
    const events = [ev("first_commit", 120), ci(140, "pending"), ci(150, "failing"), human(160, "APPROVED")];
    const v = derive(input({ events }));
    expect(cell(v, "ci").state).toBe("failed");
    expect(cell(v, "peer_review").state).toBe("done");
    expect(cell(v, "merge").state).toBe("todo");
    const v2 = derive(input({ events: [...events, ev("push", 170, { sha: "s170" })] }));
    expect(cell(v2, "dev")).toMatchObject({ state: "active", round: 2 });
    // 批准跟 GitHub 一样跨 push 有效：带进新一轮。
    expect(cell(v2, "peer_review")).toMatchObject({ state: "done", round: 2 });
    expect(states(v2)).toMatchObject({ self_review: "todo", ci: "todo", merge: "todo" });
    // 新一轮 CI 通过直接到合并。
    const v3 = derive(input({ events: [...events, ev("push", 170, { sha: "s170" }), ci(180, "pending"), ci(190, "passing")] }));
    expect(states(v3)).toMatchObject({ ci: "done", peer_review: "done", merge: "active" });
  });

  describe("review stances", () => {
    const passed = [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing")];
    const noLogin = (at: number, state: string, id: string) => ev("review", at, { id, who: "human", state, body: "" });

    it("alice requests changes, bob approves: peer review stays failed", () => {
      const v = derive(input({ events: [...passed, human(160, "CHANGES_REQUESTED"), human(170, "APPROVED", "bob")] }));
      expect(cell(v, "peer_review").state).toBe("failed");
      expect(cell(v, "merge").state).toBe("todo");
      expect(v.timeline.at(-1)).toMatchObject({ kind: "human_approved", detail: "bob" });
    });

    it("changes requested then push: peer review resets to todo", () => {
      const evs = [...passed, human(160, "CHANGES_REQUESTED"), ev("push", 170, { sha: "s2" })];
      const pushed = derive(input({ events: evs }));
      expect(cell(pushed, "dev")).toMatchObject({ state: "active", round: 2 });
      expect(cell(pushed, "peer_review")).toMatchObject({ state: "todo", round: 2 });
      // push 不撤销修改请求：之后别人的批准不算。
      const approved = derive(input({ events: [...evs, human(180, "APPROVED", "bob")] }));
      expect(cell(approved, "peer_review").state).toBe("failed");
      expect(cell(approved, "merge").state).not.toBe("active");
      const merged = derive(input({ events: [...evs, human(180, "APPROVED", "bob"), ev("merged", 190, { number: 7 })] }));
      expect(states(merged)).toMatchObject({ peer_review: "failed", merge: "done" });
    });

    it("a change request that survives the push stays failed when round 2's CI passes", () => {
      const evs = [...passed, human(160, "CHANGES_REQUESTED"), ev("push", 170, { sha: "s2" })];
      // 没有人重新 review：CI 通过后 peer review 还是失败，不是进行中。
      const pure = derive(input({ events: [...evs, ci(180, "pending"), ci(190, "passing")] }));
      expect(states(pure)).toMatchObject({ ci: "done", peer_review: "failed", merge: "todo" });
      expect(cell(pure, "peer_review").round).toBe(2);
      // 别人在 CI 之前批准了：CI 通过也不把失败改成进行中。
      const approved = derive(input({ events: [...evs, human(175, "APPROVED", "bob"), ci(180, "pending"), ci(190, "passing")] }));
      expect(states(approved)).toMatchObject({ ci: "done", peer_review: "failed" });
      expect(cell(approved, "merge").state).not.toBe("active");
      // alice 自己批准之后才算数，进入合并。
      const resolved = derive(input({ events: [...evs, ci(180, "pending"), ci(190, "passing"), human(200, "APPROVED")] }));
      expect(states(resolved)).toMatchObject({ peer_review: "done", merge: "active" });
    });

    it("merged with a standing change request: peer review failed, merge done", () => {
      const v = derive(input({ events: [...passed, human(160, "CHANGES_REQUESTED"), ev("merged", 170, { number: 7 })] }));
      expect(states(v)).toMatchObject({ ci: "done", peer_review: "failed", merge: "done" });
    });

    it("two reviews without login do not overwrite each other", () => {
      const approvals = derive(input({ events: [...passed, noLogin(160, "APPROVED", "r1"), noLogin(165, "APPROVED", "r2"), noLogin(170, "DISMISSED", "r2")] }));
      expect(states(approvals)).toMatchObject({ peer_review: "done", merge: "active" });
      const mixed = derive(input({ events: [...passed, noLogin(160, "CHANGES_REQUESTED", "r1"), noLogin(165, "APPROVED", "r2")] }));
      expect(cell(mixed, "peer_review").state).toBe("failed");
    });

    it("dismissing the standing change request lets the other approval count", () => {
      const v = derive(input({ events: [...passed, humanId(160, "CHANGES_REQUESTED", "r1"), humanId(170, "APPROVED", "r2", "bob"), humanId(180, "DISMISSED", "r1")] }));
      expect(states(v)).toMatchObject({ peer_review: "done", merge: "active" });
      // CI 还在跑时撤销：批准算数，CI 仍是进行中的那一步，通过后到合并。
      const running = [ev("first_commit", 120), ci(140, "pending"), humanId(145, "CHANGES_REQUESTED", "r1"), humanId(146, "APPROVED", "r2", "bob"), humanId(147, "DISMISSED", "r1")];
      expect(states(derive(input({ events: running })))).toMatchObject({ ci: "active", peer_review: "done", merge: "todo" });
      expect(states(derive(input({ events: [...running, ci(150, "passing")] })))).toMatchObject({ ci: "done", peer_review: "done", merge: "active" });
    });
  });

  describe("dismissed reviews", () => {
    const base = [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing")];

    it("approve → dismiss: the bar goes back to peer review and merge is no longer active", () => {
      const v = derive(input({ events: [...base, humanId(160, "APPROVED", "r1"), humanId(170, "DISMISSED", "r1")] }));
      expect(cell(v, "peer_review").state).toBe("active");
      expect(cell(v, "merge").state).toBe("todo");
      expect(v.timeline.at(-1)).toMatchObject({ kind: "human_dismissed", detail: "alice", stage: "peer_review" });
    });

    it("approved by two people, one dismissed: peer review stays done and merge stays active", () => {
      const v = derive(input({ events: [...base, humanId(160, "APPROVED", "r1"), humanId(165, "APPROVED", "r2", "bob"), humanId(170, "DISMISSED", "r1")] }));
      expect(cell(v, "peer_review").state).toBe("done");
      expect(cell(v, "merge").state).toBe("active");
    });

    it("an approval given while CI runs and then dismissed goes back to todo, CI stays the active step", () => {
      const v = derive(input({ events: [ev("first_commit", 120), ci(140, "pending"), humanId(145, "APPROVED", "r1"), humanId(147, "DISMISSED", "r1")] }));
      expect(cell(v, "peer_review").state).toBe("todo");
      expect(cell(v, "ci").state).toBe("active");
    });

    it("changes requested → dismissed: peer review is active again", () => {
      const v = derive(input({ events: [...base, humanId(160, "CHANGES_REQUESTED", "r1"), humanId(170, "DISMISSED", "r1")] }));
      expect(cell(v, "peer_review").state).toBe("active");
      expect(cell(v, "merge").state).toBe("todo");
    });

    it("changes requested during CI → dismissed: peer review back to todo while CI is still going", () => {
      const v = derive(input({ events: [ev("first_commit", 120), ci(140, "pending"), humanId(145, "CHANGES_REQUESTED", "r1"), humanId(147, "DISMISSED", "r1")] }));
      expect(cell(v, "peer_review").state).toBe("todo");
      expect(cell(v, "ci").state).toBe("active");
    });

    it("a dismissed review with no earlier state for its id is only a timeline row", () => {
      const v = derive(input({ events: [...base, humanId(170, "DISMISSED", "r9")] }));
      expect(cell(v, "peer_review").state).toBe("active");
      expect(v.timeline.at(-1)?.kind).toBe("human_dismissed");
    });

    it("a dismissal before the merge: peer review is skipped like any merge without an approval", () => {
      const v = derive(input({ events: [...base, humanId(160, "APPROVED", "r1"), humanId(162, "DISMISSED", "r1"), ev("merged", 165, { number: 7 })] }));
      expect(cell(v, "peer_review").state).toBe("skipped");
      expect(cell(v, "merge").state).toBe("done");
    });

    const active = (v: ReturnType<typeof derive>) => v.stages.filter((c) => c.state === "active").map((c) => c.id);

    it("changes requested during CI, dismissed, then CI passes: peer review becomes the one active step", () => {
      const v = derive(input({ events: [ev("first_commit", 120), ci(140, "pending"), humanId(145, "CHANGES_REQUESTED", "r1"), humanId(146, "DISMISSED", "r1"), ci(150, "passing")] }));
      expect(active(v)).toEqual(["peer_review"]);
      expect(cell(v, "ci").state).toBe("done");
    });

    it("approval dismissed while another reviewer's changes request stands: peer review failed, CI the only active step", () => {
      const v = derive(input({ events: [ev("first_commit", 120), ci(140, "pending"), humanId(145, "CHANGES_REQUESTED", "r1", "bob"), humanId(146, "APPROVED", "r2"), humanId(147, "DISMISSED", "r2")] }));
      expect(cell(v, "peer_review").state).toBe("failed");
      expect(active(v)).toEqual(["ci"]);
    });

    it("a late dismissal of a round-1 changes request does not erase round 2's rewind", () => {
      const common = [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"), humanId(160, "CHANGES_REQUESTED", "r1")];
      const later = [ev("push", 200, { sha: "x" }), ci(210, "pending"), ci(220, "passing"), humanId(230, "APPROVED", "r2", "bob")];
      const before = derive(input({ events: [...common, ...later] }));
      // alice 的修改请求跨 push 还在：bob 的批准不算。
      expect(states(before)).toMatchObject({ dev: "done", ci: "done", peer_review: "failed", merge: "todo" });
      const v = derive(input({ events: [...common, ...later, humanId(300, "DISMISSED", "r1")] }));
      // 撤销之后 bob 的批准算数；还是第 2 轮，不回退。
      expect(states(v)).toEqual({ ...states(before), peer_review: "done", merge: "active" });
      expect(v.stages.filter((s) => s.id !== "design").every((s) => s.round === 2)).toBe(true);
      expect(v.timeline.filter((t) => t.kind === "push")).toEqual(before.timeline.filter((t) => t.kind === "push"));
    });

    it("a stale approval does not count: alice approves then requests changes, bob's approval is dismissed", () => {
      const v = derive(input({ events: [...base, humanId(160, "APPROVED", "r1"), humanId(170, "CHANGES_REQUESTED", "r2"), humanId(175, "APPROVED", "r3", "bob"), humanId(180, "DISMISSED", "r3", "bob")] }));
      expect(cell(v, "peer_review").state).toBe("failed");
      expect(cell(v, "merge").state).toBe("todo");
    });
  });

  it("a review skill before the first commit judges design, starts dev and moves to self review; the first commit later does not restart dev", () => {
    const v = derive(input({ pr: null, events: [reviewSkill(110), ev("first_commit", 120)] }));
    expect(cell(v, "design").state).toBe("skipped");
    expect(cell(v, "dev").state).toBe("done");
    expect(cell(v, "self_review").state).toBe("active");
    const after = derive(input({ events: [reviewSkill(110), ev("first_commit", 120), ev("pr_opened", 130)] }));
    expect(cell(after, "self_review").state).toBe("done");
  });

  it("a review skill before the first commit with design in progress marks design done", () => {
    const v = derive(input({ pr: null, events: [design(105), reviewSkill(110)] }));
    expect(cell(v, "design").state).toBe("done");
    expect(cell(v, "self_review").state).toBe("active");
  });

  it("work before skill tracking began shows design and self-review unknown, not skipped", () => {
    const events = [ev("first_commit", 120), ev("pr_opened", 130), ci(140, "pending"), ci(150, "passing"), ev("merged", 160)];
    const before = derive(input({ skillTrackingSince: 125, events }));
    expect(states(before)).toEqual({ design: "unknown", dev: "done", self_review: "unknown", ci: "done", peer_review: "skipped", merge: "done" });
    expect(states(derive(input({ skillTrackingSince: 125, events: events.slice(0, 1) })))).toMatchObject({ design: "unknown", self_review: "unknown" });
    // 一开始就在记：跳过。
    expect(states(derive(input({ skillTrackingSince: 120, events })))).toMatchObject({ design: "skipped", self_review: "skipped" });
    // 记录开始之后的 review skill 仍然算。
    const late = derive(input({ skillTrackingSince: 125, events: [ev("first_commit", 120), reviewSkill(126), ev("pr_opened", 130)] }));
    expect(states(late)).toMatchObject({ design: "unknown", self_review: "done" });
  });

  it("a review skill after the PR opened marks a skipped self-review done", () => {
    const base = [ev("first_commit", 120), ev("pr_opened", 130), ci(140, "pending")];
    const v = derive(input({ events: [...base, reviewSkill(145)] }));
    expect(cell(v, "self_review")).toMatchObject({ state: "done", at: 145, round: 1 });
    expect(cell(v, "ci").state).toBe("active");
    expect(v.timeline.at(-1)).toMatchObject({ kind: "review_skill", stage: "self_review" });
    // 没在记 skill 时（未知）也一样。
    expect(cell(derive(input({ skillTrackingSince: null, events: [...base, reviewSkill(145)] })), "self_review").state).toBe("done");
    // 合并之后的不算。
    const after = derive(input({ events: [...base, ci(150, "passing"), ev("merged", 160), reviewSkill(170)] }));
    expect(cell(after, "self_review").state).toBe("skipped");
    // 第二轮：算在第二轮。
    const r2 = derive(input({ events: [...base, ci(150, "failing"), ev("push", 160), ci(170, "pending"), reviewSkill(175)] }));
    expect(cell(r2, "self_review")).toMatchObject({ state: "done", round: 2 });
    expect(cell(r2, "ci").state).toBe("active");
  });

  it("a first_commit after pr_opened: CI before it still counts", () => {
    const v = derive(input({ events: [ev("pr_opened", 130), ci(140, "pending"), ci(150, "passing"), ev("first_commit", 160)] }));
    expect(states(v)).toMatchObject({ dev: "done", self_review: "skipped", ci: "done", peer_review: "active" });
    expect(cell(v, "dev").at).toBe(130);
    expect(v.timeline.map((t) => t.kind)).toEqual(["pr_opened", "ci_pending", "ci_passed", "first_commit"]);
  });

  it("a merged or closed row with no known time is not cut at epoch 0: the end comes after the last event", () => {
    const history = [ev("first_commit", 120), ci(140, "pending"), ci(150, "passing"), human(160, "APPROVED")];
    const merged = derive(input({ pr: pr({ number: 7, url: "u", state: "merged", mergedAt: null, checkedAt: 0 }), events: history }));
    expect(states(merged)).toEqual({ design: "skipped", dev: "done", self_review: "skipped", ci: "done", peer_review: "done", merge: "done" });
    expect(merged.timeline.at(-1)).toMatchObject({ at: 160, kind: "merged" });
    expect(cell(merged, "merge").at).toBe(160);
    const open = derive(input({ events: history }));
    const closed = derive(input({ pr: pr({ number: 7, url: "u", state: "closed", closedAt: null, checkedAt: 0 }), events: history }));
    expect(states(closed)).toEqual(states(open));
    expect(closed.closed).toBe(true);
    expect(closed.timeline.at(-1)).toMatchObject({ at: 160, kind: "closed" });
    // 没有事件：用 ticket 创建时间；从 PR 行补的格子时间也不是 0。
    const bare = derive(input({ pr: pr({ number: 7, url: "u", state: "merged", ci: "passing", mergedAt: null, checkedAt: 0 }) }));
    expect(bare.timeline.map((t) => [t.at, t.kind])).toEqual([[100, "merged"]]);
    expect(cell(bare, "ci").at).toBe(100);
    const openSeed = derive(input({ pr: pr({ number: 7, url: "u", state: "open", ci: "failing", checkedAt: 0 }), events: [ev("first_commit", 120)] }));
    expect(cell(openSeed, "ci")).toMatchObject({ state: "failed", at: 120 });
  });

  it("a seeded passing ci on an open PR at the ci step moves the bar on", () => {
    const row = pr({ number: 7, url: "u", state: "open", ci: "passing", checkedAt: 500 });
    const v = derive(input({ pr: row, events: [ev("first_commit", 120), ev("pr_opened", 130)] }));
    expect(states(v)).toMatchObject({ ci: "done", peer_review: "active", merge: "todo" });
    const approved = derive(input({ pr: row, events: [ev("first_commit", 120), ev("pr_opened", 130), human(140, "APPROVED")] }));
    expect(states(approved)).toMatchObject({ ci: "done", peer_review: "done", merge: "active" });
    const seededApproval = derive(input({ pr: { ...row!, review: "approved" }, events: [ev("first_commit", 120), ev("pr_opened", 130)] }));
    expect(states(seededApproval)).toMatchObject({ ci: "done", peer_review: "done", merge: "active" });
    // 还在开发：只写 ci 这一格。
    expect(states(derive(input({ pr: row, events: [ev("first_commit", 120)] })))).toMatchObject({ dev: "active", ci: "done", peer_review: "todo" });
  });

  it("a late first_commit without a pr_opened event: CI before it still counts on a PR row", () => {
    const v = derive(input({ events: [ci(140, "pending"), ci(150, "passing"), ev("first_commit", 160)] }));
    expect(states(v)).toMatchObject({ dev: "done", ci: "done", peer_review: "active" });
    expect(cell(v, "dev").at).toBe(140);
    // 没有 PR 的行：开发从第一个 commit 开始。
    const noPr = derive(input({ pr: null, events: [ev("push", 140), ev("first_commit", 160)] }));
    expect(cell(noPr, "dev")).toMatchObject({ state: "active", at: 160 });
  });

  it("closed, reopened and closed again without an event for the second close freezes at closedAt", () => {
    const v = derive(input({
      pr: pr({ number: 7, url: "u", state: "closed", closedAt: 170, checkedAt: 500 }),
      events: [ev("first_commit", 120), ev("pr_opened", 125), ev("closed", 130), ci(140, "pending"), ci(150, "passing"), human(180, "APPROVED")],
    }));
    expect(states(v)).toMatchObject({ ci: "done", peer_review: "active", merge: "todo" });
    expect(v.timeline.filter((t) => t.kind === "closed").map((t) => t.at)).toEqual([130, 170]);
  });
});
