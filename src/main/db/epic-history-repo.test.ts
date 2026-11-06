import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { EpicHistoryRepo, type EpicHistoryEntry } from "./epic-history-repo";
import { EpicsRepo } from "./epics-repo";
import { FeaturesRepo } from "./features-repo";

function setup() {
  const db = memDb();
  const epics = new EpicsRepo(db);
  const features = new FeaturesRepo(db);
  const e1 = epics.insert({ name: "E1", workspaceDir: "/e/1", createdAt: 1 });
  const e2 = epics.insert({ name: "E2", workspaceDir: "/e/2", createdAt: 1 });
  const f = features.insert({ name: "F", workspaceDir: "/w/F", createdAt: 1 });
  return { db, repo: new EpicHistoryRepo(db), e1, e2, f };
}

const entry = (o: Partial<Omit<EpicHistoryEntry, "id">> = {}): Omit<EpicHistoryEntry, "id"> => ({
  epicId: null, featureId: null, trigger: "weekly", createdAt: 10, coversFrom: 0, coversUntil: 10,
  payload: { summary: "做完了结账", decisions: [{ what: "金额用分存", why: "避免浮点误差" }] }, ...o,
});

describe("EpicHistoryRepo", () => {
  it("adds and lists history newest first", () => {
    const { repo, e1, e2 } = setup();
    const a = repo.add(entry({ epicId: e1, createdAt: 10, payload: { summary: "旧", decisions: [] } }));
    const b = repo.add(entry({ epicId: e1, createdAt: 30, payload: { summary: "新", decisions: [{ what: "w", why: "y" }] } }));
    repo.add(entry({ epicId: e1, createdAt: 20, payload: { summary: "中", decisions: [] } }));
    repo.add(entry({ epicId: e2, createdAt: 40 }));
    expect(a).toBeGreaterThan(0);
    expect(repo.list(e1, 10).map((h) => h.payload.summary)).toEqual(["新", "中", "旧"]);
    expect(repo.list(e1, 2).map((h) => h.payload.summary)).toEqual(["新", "中"]);
    expect(repo.list(e1, 1)[0]).toEqual({ id: b, ...entry({ epicId: e1, createdAt: 30, payload: { summary: "新", decisions: [{ what: "w", why: "y" }] } }) });
  });

  it("keeps the entries of features outside any epic under epic_id NULL", () => {
    const { repo, e1, f } = setup();
    repo.add(entry({ epicId: e1 }));
    repo.add(entry({ epicId: null, featureId: f, trigger: "feature_archived", payload: { summary: "独立 feature", decisions: [] } }));
    expect(repo.list(null, 10)).toMatchObject([{ epicId: null, featureId: f, trigger: "feature_archived", payload: { summary: "独立 feature" } }]);
    expect(repo.list(e1, 10)).toHaveLength(1);
  });

  it("lastCoveredUntil is the latest covers_until of that epic, and null without entries", () => {
    const { repo, e1, e2 } = setup();
    expect(repo.lastCoveredUntil(e1)).toBeNull();
    repo.add(entry({ epicId: e1, createdAt: 50, coversUntil: 50 }));
    repo.add(entry({ epicId: e1, createdAt: 60, coversUntil: 40 }));
    repo.add(entry({ epicId: e2, createdAt: 70, coversUntil: 70 }));
    expect(repo.lastCoveredUntil(e1)).toBe(50);
    expect(repo.lastCoveredUntil(null)).toBeNull();
  });

  it("lastCoveredUntilOfFeature is the latest covers_until of that feature's own entries", () => {
    const { db, repo, e1, f } = setup();
    const other = new FeaturesRepo(db).insert({ name: "G", workspaceDir: "/w/G", createdAt: 1 });
    expect(repo.lastCoveredUntilOfFeature(f)).toBeNull();
    repo.add(entry({ featureId: f, trigger: "feature_archived", coversUntil: 30 }));
    repo.add(entry({ featureId: f, trigger: "feature_archived", coversUntil: 20 }));
    repo.add(entry({ epicId: e1, featureId: other, trigger: "feature_archived", coversUntil: 90 }));
    repo.add(entry({ epicId: e1, coversUntil: 99 }));
    expect(repo.lastCoveredUntilOfFeature(f)).toBe(30);
  });

  it("lastWeeklyAt only counts weekly entries", () => {
    const { repo, e1, f } = setup();
    expect(repo.lastWeeklyAt(e1)).toBeNull();
    repo.add(entry({ epicId: e1, createdAt: 10 }));
    repo.add(entry({ epicId: e1, featureId: f, trigger: "feature_archived", createdAt: 90 }));
    expect(repo.lastWeeklyAt(e1)).toBe(10);
  });

  it("rejects an unknown trigger", () => {
    const { repo } = setup();
    expect(() => repo.add(entry({ trigger: "daily" as never }))).toThrow();
  });
});
