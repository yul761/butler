import { describe, expect, it } from "vitest";
import type { PrStageCell, PrStageId, PrStageState, PrStagesTicket, PrStagesView } from "../../shared/pr-stages";
import { cellLabel, cellText, epicPrSummary, timelineText } from "./pr-stages-view";
import { S } from "./strings";

const IDS: PrStageId[] = ["design", "dev", "self_review", "ci", "peer_review", "merge"];

function row(featureId: number | null, states: Partial<Record<PrStageId, PrStageState>>, closed = false): PrStagesView {
  const stages: PrStageCell[] = IDS.map((id) => ({ id, state: states[id] ?? "todo", round: 1, at: null }));
  return { ticketKey: "T-1", featureId, repoId: 1, repoName: "r", prId: null, slug: null, noPr: true, prNumber: null, prUrl: null, closed, stages, timeline: [] };
}
const tickets = (...rows: PrStagesView[]): PrStagesTicket[] =>
  rows.map((r, i) => ({ ticketKey: `T-${i}`, title: null, archived: false, merged: false, hasRepos: true, rows: [r] }));

describe("epicPrSummary", () => {
  it("counts merged / failed / notStarted per feature and ignores closed PRs", () => {
    const rows = [
      row(1, { dev: "done", ci: "done", merge: "done" }),
      row(1, { dev: "done", ci: "failed" }),
      row(1, {}),
      row(2, { dev: "done" }, true),
    ];
    const m = epicPrSummary(tickets(...rows));
    expect(m.get(1)).toEqual({ featureId: 1, merged: 1, active: 0, failed: 1, notStarted: 1, total: 3 });
    expect(m.has(2)).toBe(false);
  });

  it("counts a started, unfinished, not failed row as active", () => {
    const m = epicPrSummary(tickets(row(3, { dev: "active" })));
    expect(m.get(3)).toMatchObject({ active: 1, total: 1 });
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
