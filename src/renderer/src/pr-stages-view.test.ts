import { describe, expect, it } from "vitest";
import type { PrStageCell, PrStageId, PrStageState, PrStagesView } from "../../shared/pr-stages";
import { epicPrSummary, timelineText } from "./pr-stages-view";
import { S } from "./strings";

const IDS: PrStageId[] = ["design", "dev", "self_review", "ci", "peer_review", "merge"];

function row(featureId: number | null, states: Partial<Record<PrStageId, PrStageState>>, closed = false): PrStagesView {
  const stages: PrStageCell[] = IDS.map((id) => ({ id, state: states[id] ?? "todo", round: 1, at: null }));
  return { ticketKey: "T-1", featureId, repoId: 1, repoName: "r", branch: "b", prNumber: null, prUrl: null, closed, stages, timeline: [] };
}

describe("epicPrSummary", () => {
  it("counts merged / failed / notStarted per feature and ignores closed PRs", () => {
    const rows = [
      row(1, { dev: "done", ci: "done", merge: "done" }),
      row(1, { dev: "done", ci: "failed" }),
      row(1, {}),
      row(2, { dev: "done" }, true),
    ];
    const m = epicPrSummary(rows);
    expect(m.get(1)).toEqual({ featureId: 1, merged: 1, active: 0, failed: 1, notStarted: 1, total: 3 });
    expect(m.get(2)?.total ?? 0).toBe(0);
  });

  it("counts a started, unfinished, not failed row as active", () => {
    const m = epicPrSummary([row(3, { dev: "active" })]);
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
});
