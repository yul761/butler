import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { AvailabilityRepo, type StoredAvailability } from "./availability-repo";

const hit = { kind: "usage_limit" as const, resetsAt: 5, message: "m", at: 1, source: "headless" as const, job: "lessons", sessionId: null };

describe("AvailabilityRepo", () => {
  it("round-trips state", () => {
    const repo = new AvailabilityRepo(memDb());
    expect(repo.load()).toBeNull();
    const s: StoredAvailability = { current: hit, lastHit: hit, retryAt: 9, backoffStep: 2, lessonsPause: { reason: "limit", since: 1, until: 9 } };
    repo.save(s, 10);
    expect(repo.load()).toEqual(s);
    repo.save({ ...s, retryAt: null }, 11);
    expect(repo.load()?.retryAt).toBeNull();
  });

  it("garbage JSON loads as null", () => {
    const db = memDb();
    db.prepare(`INSERT INTO claude_availability (id, state, updated_at) VALUES (1, '{nope', 1)`).run();
    const logs: string[] = [];
    expect(new AvailabilityRepo(db, (m) => logs.push(m)).load()).toBeNull();
    expect(logs).toHaveLength(1);
  });
});
