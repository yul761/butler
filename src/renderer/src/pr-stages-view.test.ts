import { describe, expect, it } from "vitest";
import type { PrStageCell, PrStageId, PrStageState, PrStagesTicket, PrStagesView, PrTimelineEntry } from "../../shared/pr-stages";
import { cellLabel, cellText, newestRow, timelineText } from "./pr-stages-view";
import { S } from "./strings";

const IDS: PrStageId[] = ["design", "dev", "self_review", "ci", "peer_review", "merge"];

function row(featureId: number | null, states: Partial<Record<PrStageId, PrStageState>>, o: Partial<PrStagesView> = {}): PrStagesView {
  const stages: PrStageCell[] = IDS.map((id) => ({ id, state: states[id] ?? "todo", round: 1, at: null }));
  return { ticketKey: "T-1", featureId, repoId: 1, repoName: "r", prId: null, slug: null, noPr: true, prNumber: null, prUrl: null, closed: false, stages, timeline: [], ...o };
}
const at = (...ms: number[]): PrTimelineEntry[] => ms.map((m) => ({ at: m, stage: "dev", kind: "push", detail: null, back: false }));
const ticket = (key: string, featureId: number | null, rows: PrStagesView[], o: Partial<PrStagesTicket> = {}): PrStagesTicket =>
  ({ ticketKey: key, featureId, title: null, archived: false, merged: false, hasRepos: true, rows, ...o });

describe("newestRow", () => {
  it("is the row with the latest activity; ties keep the main process order", () => {
    const quiet = row(1, {});
    const a = row(1, {}, { prId: 1, noPr: false, timeline: at(100, 400) });
    const b = row(1, {}, { prId: 2, noPr: false, timeline: at(300) });
    expect(newestRow(ticket("A-1", 1, [quiet, b, a]))).toBe(a);
    const [c, d] = [row(1, {}, { prId: 3, noPr: false }), row(1, {}, { prId: 4, noPr: false })];
    expect(newestRow(ticket("A-1", 1, [c, d]))).toBe(c);
    expect(newestRow(ticket("A-1", 1, []))).toBeNull();
  });

  it("on a tie a PR row beats a no-PR row", () => {
    const quiet = row(1, {});
    const pr = row(1, {}, { prId: 3, noPr: false });
    expect(newestRow(ticket("A-1", 1, [quiet, pr]))).toBe(pr);
    const [early, prAt] = [row(1, {}, { timeline: at(200) }), row(1, {}, { prId: 5, noPr: false, timeline: at(200) })];
    expect(newestRow(ticket("A-1", 1, [early, prAt]))).toBe(prAt);
  });

  it("a closed PR never hides a live one", () => {
    // #2 换掉了 #1，#2 的 CI 过了（t=200），之后才关掉 #1（t=300）。
    const live = row(1, { dev: "done", ci: "done" }, { prId: 2, noPr: false, timeline: at(200) });
    const closed = row(1, { dev: "done" }, { prId: 1, noPr: false, closed: true, timeline: at(100, 300) });
    const t = ticket("A-1", 1, [live, closed]);
    expect(newestRow(t)).toBe(live);
    // 全关了才用最新的关闭的那行。
    const old = row(1, {}, { prId: 0, noPr: false, closed: true, timeline: at(50) });
    expect(newestRow(ticket("A-2", 1, [old, closed]))).toBe(closed);
  });
});

describe("timelineText", () => {
  it("names CI for ci_failed", () => {
    expect(timelineText({ at: 1, stage: "ci", kind: "ci_failed", detail: null, back: false })).toContain("CI");
  });
  it("marks entries that went back to dev", () => {
    expect(timelineText({ at: 1, stage: "dev", kind: "push", detail: null, back: true })).toContain(S.prBackToDev);
  });
  it("shows the report text", () => {
    expect(timelineText({ at: 1, stage: "self_review", kind: "report", detail: "找到 2 处", back: false })).toContain("找到 2 处");
  });
  it("a report entry has no stage prefix", () => {
    expect(timelineText({ at: 1, stage: "self_review", kind: "report", detail: "找到 2 处", back: false })).toBe(S.prTimeline.report("找到 2 处"));
    expect(timelineText({ at: 1, stage: "self_review", kind: "review_skill", detail: "simplify", back: false })).toContain(S.prStage.self_review);
  });
});

describe("timelineText stage name and detail", () => {
  it("prints the stage name once", () => {
    const text = timelineText({ at: 1, stage: "ci", kind: "ci_failed", detail: null, back: false });
    expect(text.split(S.prStage.ci)).toHaveLength(2);
  });
  it("leaves no dangling colon without detail", () => {
    for (const kind of ["design_skill", "review_skill", "report"] as const) {
      expect(timelineText({ at: 1, stage: "design", kind, detail: null, back: false })).not.toMatch(/[:：]\s*$/);
    }
  });
});

describe("cellText", () => {
  const cell = (state: PrStageState, round = 1): PrStageCell => ({ id: "dev", state, round, at: null });
  it("gives unknown and skipped their own text", () => {
    expect(cellText(cell("unknown"))).toBe(S.prStageUnknown);
    expect(cellText(cell("skipped"))).toBe(S.prStageSkipped);
    expect(S.prStageUnknown).not.toBe(S.prStageSkipped);
  });
  it("writes active and feature_level as text", () => {
    expect(cellText(cell("active"))).toBe(S.prStageActive);
    expect(cellText(cell("feature_level"))).toBe(S.prStageFeatureLevel);
  });
  it("shows the round after the first only on the current step (active or failed), not on done, todo or skipped cells", () => {
    expect(cellText(cell("active", 2))).toContain(S.prRound(2));
    expect(cellText(cell("failed", 2))).toContain(S.prRound(2));
    for (const state of ["done", "todo", "skipped", "unknown", "feature_level"] as const) expect(cellText(cell(state, 2))).not.toContain(S.prRound(2));
    expect(cellText(cell("active", 1))).not.toContain(S.prRound(1));
  });
  it("puts the round in the label of a failed symbol cell, and nowhere else", () => {
    expect(cellLabel(cell("failed", 2))).toBe(`${S.prStateFailed} ${S.prRound(2)}`);
    expect(cellLabel(cell("done", 2))).toBe(S.prStateDone);
    expect(cellLabel(cell("todo", 3))).toBe(S.prStateTodo);
  });
  it("labels symbol cells with their state text", () => {
    expect(cellLabel(cell("done"))).toBe(S.prStateDone);
    expect(cellLabel(cell("failed"))).toBe(S.prStateFailed);
    expect(cellLabel(cell("todo"))).toBe(S.prStateTodo);
  });
});
