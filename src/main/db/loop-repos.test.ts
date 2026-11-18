import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { migrate } from "./database";
import { CiTriageRepo } from "./ci-triage-repo";
import { CommentItemsRepo, COMMENT_BODY_MAX } from "./comment-items-repo";
import { MIGRATIONS } from "./migrations";

const fresh = () => {
  const db = memDb();
  expect(migrate(db)).toBe(MIGRATIONS.length);
  return db;
};
const seen = (over: Partial<Parameters<CommentItemsRepo["seen"]>[0]> = {}) => ({
  prId: 1, key: "101", kind: "inline" as const, threadId: "T1", databaseId: 101, author: "copilot", who: "copilot" as const, path: "a.ts", line: 3,
  body: "Use const", url: "u", commentedAt: 5, seenSha: "aaa", ...over,
});

describe("CommentItemsRepo", () => {
  it("creates a pending item once and refreshes the body on later sightings", () => {
    const r = new CommentItemsRepo(fresh());
    const a = r.seen(seen(), 10);
    expect(a.created).toBe(true);
    expect(a.item).toMatchObject({ state: "pending", category: null, firstSeen: 10, who: "copilot", line: 3 });
    const b = r.seen(seen({ body: "Use const please", line: 9 }), 20);
    expect(b.created).toBe(false);
    expect(b.item).toMatchObject({ id: a.item.id, body: "Use const please", line: 3, firstSeen: 10 });
    expect(r.seen(seen({ body: "x".repeat(COMMENT_BODY_MAX + 5), key: "102" }), 1).item.body.length).toBe(COMMENT_BODY_MAX);
  });

  it("patches, filters by state, closes a PR and counts", () => {
    const r = new CommentItemsRepo(fresh());
    const a = r.seen(seen(), 10).item;
    const b = r.seen(seen({ key: "review:R1", kind: "review", who: "human", path: null, line: null }), 11).item;
    r.update(a.id, { state: "delivered", category: "fix", source: "rule", deliveredAt: 100, deliveredSha: "aaa" }, 12);
    r.update(b.id, { state: "review", category: "question" }, 12);
    expect(r.withState(["delivered"]).map((i) => i.id)).toEqual([a.id]);
    expect(r.byPr(1).map((i) => i.id)).toEqual([a.id, b.id]);
    r.update(a.id, { state: "addressed", addressedAt: 200, repliedAt: 201 }, 13);
    expect(r.stats(0, 1000)).toEqual({ addressed: 1, addressedCopilot: 1, addressedHuman: 0, delivered: 1, replied: 1, resolved: 0, waiting: 1 });
    expect(r.closePr(1, 14)).toBe(1);
    expect(r.get(b.id)?.state).toBe("closed");
    expect(r.get(a.id)?.state).toBe("addressed");
  });
});

describe("CiTriageRepo", () => {
  const item = { kind: "pr" as const, id: 7 };

  it("creates one row per item, sha and run, and updates it", () => {
    const r = new CiTriageRepo(fresh());
    const a = r.create({ item, repoSlug: "o/r", ticketKey: "T-1", headSha: "s1", runId: 9, checks: ["test"], now: 5 });
    expect(r.create({ item, repoSlug: "o/r", ticketKey: "T-1", headSha: "s1", runId: 9, checks: ["test"], now: 6 }).id).toBe(a.id);
    r.update(a.id, { state: "rerunning", category: "env", reruns: 1, tests: ["t1"] }, 7);
    expect(r.get(item, "s1", 9)).toMatchObject({ state: "rerunning", category: "env", reruns: 1, tests: ["t1"], firstFailedAt: 5 });
    expect(r.open().map((x) => x.id)).toEqual([a.id]);
    const b = r.create({ item, repoSlug: "o/r", ticketKey: "T-1", headSha: "s2", runId: 10, checks: ["test"], now: 8 });
    expect(r.previous(item, b.id, ["test"])?.id).toBe(a.id);
    expect(r.previous(item, b.id, ["lint"])).toBeNull();
    r.abandonOthers(item, "s2", 9);
    expect(r.byId(a.id)?.state).toBe("abandoned");
    expect(r.atSha(item, "s2").map((x) => x.id)).toEqual([b.id]);
  });

  it("counts flaky events, keeps the list and reports stats", () => {
    const r = new CiTriageRepo(fresh());
    r.addFlaky({ repoSlug: "o/r", kind: "check", name: "test", triageId: null, at: 100, wastedMs: 60_000 });
    r.addFlaky({ repoSlug: "o/r", kind: "check", name: "test", triageId: null, at: 200, wastedMs: 30_000 });
    r.addFlaky({ repoSlug: "o/r", kind: "test", name: "a > b", triageId: null, at: 200, wastedMs: 30_000 });
    expect(r.flakyCount("o/r", "check", "test", 150)).toBe(1);
    expect(r.list("o/r", "check", "test", "auto", 300)).toBe(true);
    expect(r.list("o/r", "check", "test", "manual", 301)).toBe(false);
    expect(r.list("o/r", "check", "lint", "manual", 302)).toBe(true);
    expect(r.listed("o/r")).toEqual({ checks: ["test", "lint"], tests: [] });
    expect(r.flakyEntries(0)).toEqual([
      { repoSlug: "o/r", kind: "check", name: "test", count: 2, wastedMs: 90_000, lastAt: 200, listed: "auto" },
      { repoSlug: "o/r", kind: "test", name: "a > b", count: 1, wastedMs: 30_000, lastAt: 200, listed: null },
      { repoSlug: "o/r", kind: "check", name: "lint", count: 0, wastedMs: 0, lastAt: null, listed: "manual" },
    ]);
    expect(r.unlist("o/r", "check", "lint")).toBe(true);
    expect(r.stats(0, 1000).wastedMs).toBe(90_000);
  });
});
