import { describe, expect, it } from "vitest";
import type { FeatureHandoff } from "../../shared/handoff";
import type { FeatureStatusRow } from "../../shared/types";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { memDb } from "../test-utils";
import { featureStatusRows, newestSummaryFirst, type LiveFeature } from "./feature-status";

const summary = (over: Partial<FeatureHandoff> = {}): FeatureHandoff => ({
  summary: "接口联调完了", blockers: [], next_steps: [], decisions: [], open_questions: [], ...over,
});

function setup() {
  const db = memDb();
  const features = new FeaturesRepo(db);
  const featureHandoffs = new FeatureHandoffsRepo(db);
  const live = new Map<number, LiveFeature>();
  const stamps: Array<[number, string]> = [];
  const add = (name: string, l?: LiveFeature) => {
    const id = features.insert({ name, workspaceDir: `/w/${name}`, createdAt: 1 });
    if (l) live.set(id, l);
    return id;
  };
  const addSummary = (featureId: number, p: FeatureHandoff | null, createdAt: number) =>
    featureHandoffs.insert({ featureId, sessionId: null, trigger: "nightly", createdAt, payload: p, rawText: null });
  const rows = () =>
    featureStatusRows(features.list({ includeArchived: true }), {
      latestValid: (id, stamp) => {
        stamps.push([id, stamp]);
        return featureHandoffs.latestValid(id);
      },
      live: (id) => live.get(id),
    });
  return { features, add, addSummary, rows, stamps };
}

const byName = (rows: FeatureStatusRow[], name: string) => rows.find((r) => r.name === name)!;

describe("featureStatusRows", () => {
  it("picks the status by priority: stuck > waiting > not started > active", () => {
    const t = setup();
    t.add("both", { stuck: true, waiting: true, started: true });
    t.add("waits", { stuck: false, waiting: true, started: true });
    t.add("fresh", { stuck: false, waiting: false, started: false });
    t.add("busy", { stuck: false, waiting: false, started: true });
    t.add("nolive");
    expect(Object.fromEntries(t.rows().map((r) => [r.name, r.status]))).toEqual({
      both: "stuck", waits: "waiting", fresh: "not_started", busy: "active", nolive: "not_started",
    });
  });

  it("lists archived features marked archived, after the live ones", () => {
    const t = setup();
    const old = t.add("old", { stuck: true, waiting: false, started: true });
    t.add("now", { stuck: false, waiting: false, started: true });
    t.features.archive(old, 50);
    const rows = t.rows();
    expect(rows.map((r) => r.name)).toEqual(["now", "old"]);
    expect(byName(rows, "old")).toMatchObject({ status: "archived", archivedAt: 50 });
    // 已归档的按归档时间标 stamp，调用方可以一直缓存。
    expect(t.stamps).toContainEqual([old, "a50"]);
  });

  it("uses empty fields without throwing when there is no valid summary", () => {
    const t = setup();
    const a = t.add("a");
    t.addSummary(a, null, 5);
    expect(t.rows()[0]).toMatchObject({ summaryAt: null, summary: null, blockers: [], decisions: [], openQuestions: [] });
  });

  it("takes the latest valid summary and orders each group by it, newest first", () => {
    const t = setup();
    const a = t.add("a");
    const b = t.add("b");
    t.add("c");
    t.addSummary(a, summary({ summary: "a1" }), 10);
    t.addSummary(a, summary({ summary: "a2", blockers: ["等 b"], decisions: [{ key: "k", statement: "s" }], open_questions: ["q"] }), 20);
    t.addSummary(a, null, 30);
    t.addSummary(b, summary({ summary: "b1" }), 25);
    const rows = t.rows();
    expect(rows.map((r) => r.name)).toEqual(["b", "a", "c"]);
    expect(byName(rows, "a")).toMatchObject({ summary: "a2", summaryAt: 20, blockers: ["等 b"], decisions: [{ key: "k", statement: "s" }], openQuestions: ["q"] });
  });

  it("reuses the summary of the live data when it is valid and asks the repo otherwise", () => {
    const rec = (over: { createdAt: number; payload: FeatureHandoff | null; degraded: boolean }) => ({
      id: 1, featureId: 0, sessionId: null, trigger: "nightly" as const, coversUntil: null, rawText: null, sourceRef: null, prStatusAt: null, ...over,
    });
    const t = setup();
    const a = t.add("a", { stuck: false, waiting: false, started: true, summary: rec({ createdAt: 7, payload: summary({ summary: "live" }), degraded: false }) });
    t.addSummary(a, summary({ summary: "db" }), 3);
    expect(t.rows()[0]).toMatchObject({ summary: "live", summaryAt: 7 });
    expect(t.stamps).toEqual([]);

    const d = setup();
    const b = d.add("b", { stuck: false, waiting: false, started: true, summary: rec({ createdAt: 9, payload: null, degraded: true }) });
    d.addSummary(b, summary({ summary: "valid" }), 3);
    expect(d.rows()[0]).toMatchObject({ summary: "valid", summaryAt: 3 });
    expect(d.stamps).toEqual([[b, "l1"]]);
  });
});

describe("newestSummaryFirst", () => {
  it("sorts the newest summary first and features without one last, keeping ties in order", () => {
    const base = { name: "F", status: "active", archivedAt: null, summaryAt: null, summary: null, blockers: [], decisions: [], openQuestions: [] } satisfies Omit<FeatureStatusRow, "id">;
    const rows = [{ ...base, id: 1 }, { ...base, id: 2, summaryAt: 5 }, { ...base, id: 3, summaryAt: 9 }, { ...base, id: 4 }];
    expect([...rows].sort(newestSummaryFirst).map((r) => r.id)).toEqual([3, 2, 1, 4]);
  });
});
