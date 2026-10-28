import { describe, expect, it } from "vitest";
import type { FeatureHandoff } from "../../shared/handoff";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, memDb } from "../test-utils";
import { ingestFeatureHandoff } from "./feature-ingest";

function setup() {
  const db = memDb();
  const features = new FeaturesRepo(db);
  const tickets = new TicketsRepo(db);
  const featureHandoffs = new FeatureHandoffsRepo(db);
  const featureId = features.insert({ name: "f", workspaceDir: "/w/f", createdAt: 1 });
  insertTicket(tickets, { key: "DMS-1234", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null, featureId });
  return { deps: { features, tickets, featureHandoffs, now: () => 1000 }, featureId, featureHandoffs };
}
const payload = (next_steps: FeatureHandoff["next_steps"]): FeatureHandoff => ({ summary: "s", blockers: [], next_steps, decisions: [], open_questions: [] });

describe("ingestFeatureHandoff", () => {
  it("rejects an unknown feature", () => {
    const { deps } = setup();
    expect(ingestFeatureHandoff(deps, { featureId: 99, sessionId: null, trigger: "manual", payload: payload([]), rawText: null })).toEqual({ stored: false, reason: "no_feature" });
  });

  it("normalizes next_steps tickets to this feature's tickets", () => {
    const { deps, featureId, featureHandoffs } = setup();
    const r = ingestFeatureHandoff(deps, {
      featureId, sessionId: "s", trigger: "command", rawText: null,
      payload: payload([{ ticket: " dms-1234 ", text: "a" }, { ticket: "OTHER-1", text: "b" }]),
    });
    expect(r).toMatchObject({ stored: true, degraded: false });
    const rec = featureHandoffs.latest(featureId)!;
    expect(rec.createdAt).toBe(1000);
    expect(rec.payload?.next_steps).toEqual([{ ticket: "DMS-1234", text: "a" }, { ticket: null, text: "b" }]);
  });

  it("stores a null payload as degraded and dedupes by sourceRef", () => {
    const { deps, featureId } = setup();
    const input = { featureId, sessionId: null, trigger: "command" as const, payload: null, rawText: "x", sourceRef: "u" };
    expect(ingestFeatureHandoff(deps, input)).toMatchObject({ stored: true, degraded: true });
    expect(ingestFeatureHandoff(deps, input)).toEqual({ stored: false, reason: "duplicate" });
  });
});
