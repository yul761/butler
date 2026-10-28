import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { FeatureHandoff } from "../../shared/handoff";
import { memDb } from "../test-utils";
import { migrate } from "./database";
import { FeatureHandoffsRepo } from "./feature-handoffs-repo";
import { FeaturesRepo } from "./features-repo";
import { MIGRATIONS } from "./migrations";

const payload: FeatureHandoff = { summary: "s", blockers: [], next_steps: [], decisions: [], open_questions: [] };

function setup() {
  const db = memDb();
  const featureId = new FeaturesRepo(db).insert({ name: "f", workspaceDir: "/w/f", createdAt: 1 });
  return { db, featureId, repo: new FeatureHandoffsRepo(db) };
}
const base = (featureId: number, over = {}) => ({
  featureId, sessionId: null, trigger: "manual" as const, createdAt: 10, payload, rawText: null, ...over,
});

describe("migration 8", () => {
  it("adds feature_handoffs", () => {
    const db = memDb();
    const cols = (db.prepare(`PRAGMA table_info(feature_handoffs)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "feature_id", "session_id", "trigger", "created_at", "covers_until", "payload", "degraded", "raw_text", "source_ref"]);
  });

  it("upgrades a version 7 database", () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS.slice(0, 7)) db.exec(sql);
    db.exec("PRAGMA user_version = 7");
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const fid = new FeaturesRepo(db).insert({ name: "f", workspaceDir: "/w", createdAt: 1 });
    expect(new FeatureHandoffsRepo(db).insert(base(fid))).not.toBeNull();
  });
});

describe("FeatureHandoffsRepo", () => {
  it("ignores a repeated sourceRef", () => {
    const { repo, featureId } = setup();
    expect(repo.insert(base(featureId, { sourceRef: "u1" }))).not.toBeNull();
    expect(repo.insert(base(featureId, { sourceRef: "u1" }))).toBeNull();
    expect(repo.listByFeature(featureId)).toHaveLength(1);
  });

  it("lists newest first and latestValid skips degraded", () => {
    const { repo, featureId } = setup();
    const a = repo.insert(base(featureId, { createdAt: 10 }))!;
    const b = repo.insert(base(featureId, { createdAt: 20, payload: null, rawText: "raw" }))!;
    expect(repo.listByFeature(featureId).map((r) => r.id)).toEqual([b, a]);
    expect(repo.latest(featureId)?.degraded).toBe(true);
    expect(repo.latestValid(featureId)?.id).toBe(a);
    expect(repo.get(b)?.rawText).toBe("raw");
  });

  it("writes covers_until only once", () => {
    const { repo, featureId } = setup();
    const id = repo.insert(base(featureId))!;
    expect(repo.get(id)?.coversUntil).toBeNull();
    repo.setCoversUntil(id, 5);
    repo.setCoversUntil(id, 9);
    expect(repo.get(id)?.coversUntil).toBe(5);
  });

  it("treats an unreadable payload as degraded", () => {
    const { db, repo, featureId } = setup();
    const id = repo.insert(base(featureId))!;
    db.prepare(`UPDATE feature_handoffs SET payload = '{bad' WHERE id = ?`).run(id);
    expect(repo.get(id)?.degraded).toBe(true);
    expect(repo.latestValid(featureId)).toBeNull();
  });
});
