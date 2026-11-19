import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./database";
import { MIGRATIONS } from "./migrations";
import { emptyClassification, IntakeRepo, type IntakeRecord } from "./intake-repo";

const N = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE intake_items"));

const rec = (key: string, o: Partial<IntakeRecord> = {}): IntakeRecord => ({
  key, source: "file", title: `t ${key}`, url: null, contentHash: "h", repoPath: "/r", repoSlug: "acme/app", state: "queued", waitReason: null, detail: null,
  payload: { key, title: `t ${key}`, description: "d", type: null, labels: [], priority: null, url: null, storyPoints: null, components: [], subtasks: [], repo: null },
  classification: emptyClassification(), userDims: [], tier: null, model: null, allowParallel: false, forceStart: false, parentKey: null, layer: null,
  ticketKey: null, attempts: 0, alertedAt: null, firstSeenAt: 1, updatedAt: 1, startedAt: null, ...o,
});

describe("intake migration and repo (workstream N)", () => {
  it("migrates from the previous version and stores items, overrides and policies", () => {
    expect(N).toBeGreaterThan(0);
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < N; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${N}`);
    migrate(db);
    const repo = new IntakeRepo(db);
    repo.insert(rec("PROJ-1", { classification: { ...emptyClassification(), size: "small", risk: "low" }, userDims: ["size"] }));
    repo.insert(rec("PROJ-2", { parentKey: "PROJ-9", layer: 1, state: "waiting", waitReason: "stack", updatedAt: 5 }));
    expect(repo.get("PROJ-1")).toMatchObject({ classification: { size: "small", risk: "low" }, userDims: ["size"], allowParallel: false });
    repo.update("PROJ-1", { state: "started", ticketKey: "PROJ-1", allowParallel: true, startedAt: 9, updatedAt: 9 });
    expect(repo.get("PROJ-1")).toMatchObject({ state: "started", ticketKey: "PROJ-1", allowParallel: true, startedAt: 9 });
    expect(repo.list().map((r) => r.key)).toEqual(["PROJ-1", "PROJ-2"]);
    expect(repo.byState(["waiting"]).map((r) => r.key)).toEqual(["PROJ-2"]);
    expect(repo.children("PROJ-9").map((r) => r.layer)).toEqual([1]);
    expect(() => db.prepare("UPDATE intake_items SET state = 'nope' WHERE key = 'PROJ-1'").run()).toThrow();
    repo.addOverride({ itemKey: "PROJ-1", dim: "size", from: "small", to: "large", rulesVersion: 1, classSource: "rules", at: 10 });
    expect(repo.overrides(0)).toMatchObject([{ itemKey: "PROJ-1", dim: "size", from: "small", to: "large" }]);
    expect(repo.overrides(11)).toEqual([]);
    db.prepare("INSERT INTO intake_policies (scope_kind, overrides, updated_at) VALUES ('global', '{}', 1)").run();
    expect(() => db.prepare("INSERT INTO intake_policies (scope_kind, overrides, updated_at) VALUES ('global', '{}', 2)").run()).toThrow();
    expect(repo.get("nope")).toBeNull();
  });
});
