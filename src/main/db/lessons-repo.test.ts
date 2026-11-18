import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { MIGRATIONS } from "./migrations";
import { LessonsRepo } from "./lessons-repo";
import { LessonRunsRepo, RUN_CAPS } from "./lesson-runs-repo";

const setup = () => {
  const db = memDb();
  const repo = new LessonsRepo(db);
  repo.upsertRepo("acme/web", "/w", 1);
  repo.upsertRepo("acme/api", "/a", 1);
  return { db, repo };
};
const src = { prNumber: 7, url: "https://x/7", slug: "acme/web", runId: null };
const add = (repo: LessonsRepo, text = "t", slug = "acme/web") =>
  repo.addLesson({ scope: { kind: "repo", slug }, text, why: "w", at: 10, source: src });

describe("pendingCount", () => {
  it("pendingCount counts pending lessons only", () => {
    const { repo } = setup();
    add(repo);
    add(repo);
    repo.setStatus(add(repo), "confirmed", 2);
    expect(repo.pendingCount()).toBe(2);
  });
});

describe("migrations", () => {
  it("user_version equals MIGRATIONS.length", () => {
    const { db } = setup();
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
  });

  it("lessons needs exactly one of repo_slug / product_id", () => {
    const { db, repo } = setup();
    const pid = repo.createProduct("p", [], 1);
    const ins = (a: string | null, b: number | null) =>
      db.prepare(`INSERT INTO lessons (repo_slug, product_id, text, why, status, last_seen_at, created_at, updated_at) VALUES (?, ?, 't', 'w', 'pending', 1, 1, 1)`).run(a, b);
    expect(() => ins(null, null)).toThrow();
    expect(() => ins("acme/web", pid)).toThrow();
    expect(() => ins("acme/web", null)).not.toThrow();
  });
});

describe("repos and products", () => {
  it("upsertRepo only updates local_path; advanceCursor never goes back", () => {
    const { repo } = setup();
    repo.upsertRepo("acme/web", "/w2", 99);
    expect(repo.repo("acme/web")).toMatchObject({ localPath: "/w2", analyzedCount: 0, mergedCursor: null });
    repo.advanceCursor("acme/web", "2026-11-10T00:00:00Z");
    repo.advanceCursor("acme/web", "2026-11-01T00:00:00Z");
    expect(repo.repo("acme/web")?.mergedCursor).toBe("2026-11-10T00:00:00Z");
    repo.setBackfilled("acme/web", 5);
    expect(repo.repo("acme/web")?.backfilledAt).toBe(5);
    expect(repo.repos().map((r) => r.slug)).toEqual(["acme/api", "acme/web"]);
  });

  it("products are ordered by name with sorted slugs; productsOf filters", () => {
    const { repo } = setup();
    const b = repo.createProduct("b", ["acme/web", "acme/api"], 1);
    repo.createProduct("a", ["acme/api"], 1);
    expect(repo.products()).toEqual([
      { id: expect.any(Number), name: "a", slugs: ["acme/api"] },
      { id: b, name: "b", slugs: ["acme/api", "acme/web"] },
    ]);
    expect(repo.productsOf("acme/web").map((p) => p.name)).toEqual(["b"]);
    repo.removeFromProduct(b, "acme/api");
    repo.addToProduct(b, "acme/web");
    expect(repo.products().find((p) => p.id === b)?.slugs).toEqual(["acme/web"]);
  });

  it("deleteProduct deletes its lessons", () => {
    const { repo } = setup();
    const pid = repo.createProduct("p", ["acme/web"], 1);
    const id = repo.addLesson({ scope: { kind: "product", productId: pid }, text: "t", why: "w", at: 1, source: src });
    const keep = add(repo);
    repo.deleteProduct(pid);
    expect(repo.get(id)).toBeNull();
    expect(repo.get(keep)).not.toBeNull();
    expect(repo.products()).toEqual([]);
  });
});

describe("lessons", () => {
  it("addLesson starts pending with one source; filters work", () => {
    const { repo } = setup();
    const id = add(repo);
    const pid = repo.createProduct("p", [], 1);
    const other = repo.addLesson({ scope: { kind: "product", productId: pid }, text: "x", why: "w", at: 1, source: src });
    repo.setStatus(other, "rejected", 2);
    expect(repo.get(id)).toMatchObject({ status: "pending", hits: 1, scope: { kind: "repo", slug: "acme/web" } });
    expect(repo.get(id)?.sources).toHaveLength(1);
    expect(repo.lessons()).toHaveLength(2);
    expect(repo.lessons({ status: ["pending"] }).map((l) => l.id)).toEqual([id]);
    expect(repo.lessons({ scope: { kind: "product", productId: pid } }).map((l) => l.id)).toEqual([other]);
    expect(repo.lessons({ scope: { kind: "repo", slug: "acme/api" } })).toEqual([]);
    repo.setText(id, "new", 3);
    expect(repo.get(id)?.text).toBe("new");
  });

  it("hit with the same source twice gives hits 2, not 3 (also with null url)", () => {
    const { repo } = setup();
    const id = add(repo);
    repo.hit(id, 20, { prNumber: 8, url: null, slug: "acme/web", runId: null });
    repo.hit(id, 30, { prNumber: 8, url: null, slug: "acme/web", runId: null });
    repo.hit(id, 40, src);
    expect(repo.get(id)).toMatchObject({ hits: 2, lastSeenAt: 40 });
    expect(repo.get(id)?.sources.map((s) => s.prNumber)).toEqual([7, 8]);
  });

  it("merge sums hits, unions sources, takes max last_seen, and hides drop behind merged_into", () => {
    const { repo } = setup();
    const keep = add(repo, "k");
    const drop = add(repo, "d");
    repo.hit(keep, 20, { prNumber: 8, url: null, slug: "acme/web", runId: null });
    repo.hit(drop, 50, { prNumber: 9, url: null, slug: "acme/web", runId: null });
    repo.merge(keep, drop, "merged", 60);
    const l = repo.get(keep)!;
    expect(l).toMatchObject({ text: "merged", hits: 4, lastSeenAt: 50 });
    expect(l.sources.map((s) => s.prNumber).sort()).toEqual([7, 8, 9]);
    expect(repo.get(drop)?.mergedInto).toBe(keep);
    expect(repo.lessons().map((x) => x.id)).toEqual([keep]);
    expect(repo.lessons({ includeMerged: true }).map((x) => x.id)).toEqual([keep, drop]);
    expect(repo.resolveMerged(drop)?.id).toBe(keep);
    expect(repo.source(l.sources[0].id)?.prNumber).toBe(l.sources[0].prNumber);
    repo.remove(keep);
    expect(repo.get(keep)).toBeNull();
    expect(repo.get(drop)?.mergedInto).toBeNull();
  });

  it("re-points older merges at the new keeper and does not count merged pending rows", () => {
    const { repo } = setup();
    const a = add(repo, "a");
    const b = add(repo, "b");
    const c = add(repo, "c");
    repo.merge(b, a, "b+a", 2);
    repo.merge(c, b, "c+b", 3);
    expect(repo.get(a)?.mergedInto).toBe(c);
    expect(repo.resolveMerged(a)?.id).toBe(c);
    expect(repo.pendingCount()).toBe(1);
  });

  it("reads defaults for the new fields and patches only what is given", () => {
    const { repo } = setup();
    const id = add(repo, "x");
    expect(repo.get(id)).toMatchObject({
      scopeGlobs: [], scopeLang: null, scopeLayer: null, strength: null, checkability: null, admission: "pending",
      shelvedReason: null, shelvedRef: null, batchId: null, mergedInto: null, score: null, scoreParts: null, scoredAt: null,
      scorePolicyVersion: null, degraded: false, degradedFrom: null,
    });
    repo.setFields(id, { scopeGlobs: ["src/**/*.ts"], strength: "must", checkability: "prose", admission: "shelved", shelvedReason: "generality", score: 0.42, scoreParts: { evidence: { value: 0.2, reason: "one PR" } }, degraded: true, degradedFrom: "high" }, 9);
    expect(repo.get(id)).toMatchObject({
      scopeGlobs: ["src/**/*.ts"], strength: "must", checkability: "prose", admission: "shelved", shelvedReason: "generality",
      score: 0.42, scoreParts: { evidence: { value: 0.2, reason: "one PR" } }, degraded: true, degradedFrom: "high", text: "x",
    });
    repo.setFields(id, { score: null }, 10);
    expect(repo.get(id)).toMatchObject({ score: null, strength: "must" });
  });

  it("filters by an id list", () => {
    const { repo } = setup();
    const a = add(repo, "a");
    add(repo, "b");
    const c = add(repo, "c");
    expect(repo.lessons({ ids: [c, a] }).map((l) => l.id)).toEqual([a, c]);
    expect(repo.lessons({ ids: [] })).toEqual([]);
  });
});

describe("queue", () => {
  it("enqueue counts new rows and requeues failed", () => {
    const { repo } = setup();
    expect(repo.enqueue("acme/web", [1, 2], "backfill", 100)).toBe(2);
    expect(repo.enqueue("acme/web", [2, 3], "daily", 101)).toBe(1);
    const a = repo.take(200)!;
    const b = repo.take(200)!;
    expect([a.prNumber, b.prNumber]).toEqual([1, 2]);
    repo.finish(b.id, "failed", 150, "gh down", { message: "old failure" });
    expect(repo.queueCounts("acme/web")).toEqual({ queued: 1, running: 1, failed: 1, skipped: 0, cancelled: 0 });
    expect(repo.enqueue("acme/web", [2], "backfill", 160)).toBe(0);
    expect(repo.queueRows("acme/web").find((r) => r.id === b.id)).toMatchObject({ status: "queued", error: null, errorMessage: null });
    expect(repo.queueCounts("acme/web")).toEqual({ queued: 2, running: 1, failed: 0, skipped: 0, cancelled: 0 });
  });

  it("take orders by enqueued_at then id, marks running; defer and resetRunning", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [5], "merged", 300);
    repo.enqueue("acme/web", [6], "merged", 100);
    const first = repo.take(1000)!;
    expect(first).toMatchObject({ prNumber: 6, origin: "merged", slug: "acme/web" });
    repo.defer(first.id, 1000 + 600_000);
    const second = repo.take(1000)!;
    expect(second.prNumber).toBe(5);
    expect(repo.take(1000)).toBeNull();
    expect(repo.take(1000 + 600_000)?.prNumber).toBe(6);
    expect(repo.resetRunning()).toBe(2);
    expect(repo.queueCounts("acme/web").queued).toBe(2);
  });

  it("finish done bumps repo counters; skipped/failed do not", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1, 2, 3], "daily", 1);
    const a = repo.take(10)!;
    const b = repo.take(10)!;
    const c = repo.take(10)!;
    repo.finish(b.id, "skipped", 20);
    repo.finish(c.id, "failed", 21, "boom");
    expect(repo.repo("acme/web")).toMatchObject({ analyzedCount: 0, lastAnalyzedAt: null });
    repo.finish(a.id, "done", 30);
    expect(repo.repo("acme/web")).toMatchObject({ analyzedCount: 1, lastAnalyzedAt: 30 });
  });

  it("take prefers priority; markSpawned counts attempts, take does not", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1, 2], "daily", 1);
    const a = repo.take(10)!;
    expect(a.attempts).toBe(0);
    repo.finish(a.id, "failed", 11, "x");
    repo.enqueue("acme/web", [3], "daily", 5);
    expect(repo.retry(a.id, 20)).toBe("ok");
    expect(repo.take(30)?.prNumber).toBe(1);
    expect(repo.take(30)?.prNumber).toBe(2);
    repo.markSpawned(a.id);
    repo.markSpawned(a.id);
    repo.finish(a.id, "failed", 40, "x");
    expect(repo.queueRows("acme/web").find((r) => r.id === a.id)?.attempts).toBe(2);
    repo.retry(a.id, 50);
    expect(repo.take(60)).toMatchObject({ id: a.id, attempts: 2 });
  });

  it("retry re-queues failed, skipped and cancelled rows first", () => {
    const { repo, db } = setup();
    repo.enqueue("acme/web", [1, 2, 3, 4], "daily", 1);
    const [a, b, c] = [repo.take(5)!, repo.take(5)!, repo.take(5)!];
    repo.finish(a.id, "failed", 6, "boom", { message: "m" });
    repo.finish(b.id, "skipped", 6, "cancelled", { message: "m" });
    repo.finish(c.id, "failed", 6, "x", { message: "m" });
    db.prepare(`UPDATE lesson_queue SET not_before = 99`).run();
    const q = repo.enqueue("acme/web", [5], "daily", 7);
    expect(q).toBe(1);
    expect(repo.cancelQueued(repo.take(8)!.id, 9)).toBe("bad_status");
    expect(repo.retry(a.id, 100)).toBe("ok");
    expect(repo.retry(b.id, 101)).toBe("ok");
    expect(repo.retry(c.id, 102)).toBe("ok");
    for (const [id, at] of [[a.id, 100], [b.id, 101], [c.id, 102]] as const) {
      const row = db.prepare(`SELECT status, priority, not_before, error, error_message, finished_at, enqueued_at FROM lesson_queue WHERE id = ?`).get(id);
      expect(row).toEqual({ status: "queued", priority: 1, not_before: null, error: null, error_message: null, finished_at: null, enqueued_at: at });
    }
    expect(repo.take(200)?.id).toBe(a.id);
    expect(repo.take(200)?.id).toBe(b.id);
    expect(repo.retry(999, 1)).toBe("not_found");
  });

  it("take zeroes priority: a retried row that was taken and deferred does not jump the queue", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1, 2], "daily", 1);
    const a = repo.take(5)!;
    repo.finish(a.id, "failed", 6, "x");
    repo.retry(a.id, 50);
    expect(repo.take(60)?.id).toBe(a.id);
    repo.defer(a.id, 70);
    expect(repo.take(80)?.prNumber).toBe(2);
  });

  it("finish links only its own run; defer keeps the earlier link", () => {
    const { repo, db } = setup();
    const runs = new LessonRunsRepo(db);
    const r1 = runs.start({ queueId: null, slug: "acme/web", prNumber: 1, origin: "daily", startedAt: 1 });
    repo.enqueue("acme/web", [1], "daily", 1);
    const a = repo.take(5)!;
    repo.finish(a.id, "failed", 6, "x", { runId: r1 });
    expect(repo.queueRows("acme/web")[0]!.lastRunId).toBe(r1);
    repo.retry(a.id, 7);
    repo.take(8);
    repo.defer(a.id, 20);
    expect(repo.queueRows("acme/web")[0]!.lastRunId).toBe(r1);
    repo.take(30);
    repo.finish(a.id, "failed", 31, "gh");
    expect(repo.queueRows("acme/web")[0]!.lastRunId).toBeNull();
  });

  it("retry on a queued row bumps priority", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1, 2], "daily", 1);
    const second = repo.queueRows("acme/web").find((r) => r.prNumber === 2)!;
    expect(repo.retry(second.id, 5)).toBe("ok");
    expect(repo.take(10)?.prNumber).toBe(2);
  });

  it("retry refuses running and done rows", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1, 2], "daily", 1);
    const a = repo.take(5)!;
    const b = repo.take(5)!;
    repo.finish(b.id, "done", 6);
    expect(repo.retry(a.id, 7)).toBe("bad_status");
    expect(repo.retry(b.id, 7)).toBe("bad_status");
  });

  it("retryFailed re-queues only failed rows of that repo", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1, 2, 3], "daily", 1);
    repo.enqueue("acme/api", [1], "daily", 1);
    const [a, b, c, d] = [repo.take(5)!, repo.take(5)!, repo.take(5)!, repo.take(5)!];
    repo.finish(a.id, "failed", 6, "x");
    repo.finish(b.id, "failed", 6, "x");
    repo.finish(c.id, "skipped", 6);
    repo.finish(d.id, "failed", 6, "x");
    expect(repo.retryFailed("acme/web", 10)).toBe(2);
    expect(repo.queueCounts("acme/web")).toMatchObject({ queued: 2, failed: 0, skipped: 1 });
    expect(repo.queueCounts("acme/api")).toMatchObject({ queued: 0, failed: 1 });
  });

  it("cancelQueued marks a queued row cancelled; enqueue does not revive it", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1], "daily", 1);
    const [row] = repo.queueRows("acme/web");
    expect(repo.cancelQueued(row.id, 5)).toBe("ok");
    expect(repo.queueCounts("acme/web")).toEqual({ queued: 0, running: 0, failed: 0, skipped: 0, cancelled: 1 });
    expect(repo.queueRows("acme/web")[0]).toMatchObject({ status: "skipped", error: "cancelled", finishedAt: 5 });
    expect(repo.enqueue("acme/web", [1], "daily", 9)).toBe(0);
    expect(repo.take(10)).toBeNull();
    expect(repo.cancelQueued(row.id, 6)).toBe("bad_status");
    expect(repo.cancelQueued(999, 6)).toBe("not_found");
    expect(repo.retry(row.id, 11)).toBe("ok");
    expect(repo.queueRows("acme/web")[0]).toMatchObject({ status: "queued", error: null, errorMessage: null, finishedAt: null });
  });

  it("queueCounts separates skipped from cancelled and counts running", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1, 2, 3, 4], "daily", 1);
    const [a, b] = [repo.take(5)!, repo.take(5)!];
    repo.finish(a.id, "skipped", 6);
    repo.finish(b.id, "skipped", 6, "cancelled");
    repo.take(5);
    expect(repo.queueCounts("acme/web")).toEqual({ queued: 1, running: 1, failed: 0, skipped: 1, cancelled: 1 });
  });

  it("clearNotBefore and queuedTotal", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1, 2], "daily", 1);
    repo.enqueue("acme/api", [1], "daily", 1);
    const a = repo.take(5)!;
    repo.defer(a.id, 9999);
    expect(repo.queuedTotal()).toBe(3);
    expect(repo.take(5)?.prNumber).not.toBe(a.prNumber);
    expect(repo.clearNotBefore()).toBe(1);
    expect(repo.queueRows("acme/web").every((r) => r.notBefore === null)).toBe(true);
  });

  it("finish stores error_message capped and last_run_id; defer sets last_run_id", () => {
    const { repo, db } = setup();
    const runs = new LessonRunsRepo(db);
    const r1 = runs.start({ queueId: null, slug: "acme/web", prNumber: 1, origin: "daily", startedAt: 1 });
    const r2 = runs.start({ queueId: null, slug: "acme/web", prNumber: 1, origin: "daily", startedAt: 2 });
    repo.enqueue("acme/web", [1], "daily", 1);
    const a = repo.take(5)!;
    repo.defer(a.id, 50, r1);
    expect(repo.queueRows("acme/web")[0]).toMatchObject({ lastRunId: r1, notBefore: 50, status: "queued" });
    repo.take(60);
    repo.finish(a.id, "failed", 70, "claude_error", { message: "x".repeat(RUN_CAPS.message + 500), runId: r2 });
    const row = repo.queueRows("acme/web")[0];
    expect(row).toMatchObject({ status: "failed", error: "claude_error", lastRunId: r2, finishedAt: 70 });
    expect(row.errorMessage!.length).toBeLessThan(RUN_CAPS.message + 60);
    expect(row.errorMessage!.startsWith("x".repeat(RUN_CAPS.message))).toBe(true);
    expect(row.errorMessage).toContain("chars cut");
  });

  it("queueRows is ordered by recent activity and limited", () => {
    const { repo } = setup();
    repo.enqueue("acme/web", [1], "daily", 10);
    repo.enqueue("acme/web", [2], "daily", 20);
    repo.enqueue("acme/api", [9], "daily", 30);
    const a = repo.take(40)!;
    repo.finish(a.id, "failed", 100, "x");
    expect(repo.queueRows("acme/web").map((r) => r.prNumber)).toEqual([a.prNumber, a.prNumber === 1 ? 2 : 1]);
    expect(repo.queueRows("acme/web")[0]).toMatchObject({ origin: "daily", enqueuedAt: 10 });
  });

  it("runLessons tells created from hit", () => {
    const { repo, db } = setup();
    const runs = new LessonRunsRepo(db);
    const r1 = runs.start({ queueId: null, slug: "acme/web", prNumber: 1, origin: "daily", startedAt: 1 });
    const r2 = runs.start({ queueId: null, slug: "acme/web", prNumber: 2, origin: "daily", startedAt: 2 });
    const id = repo.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "t", why: "w", at: 1, source: { prNumber: 1, url: null, slug: "acme/web", runId: r1 } });
    repo.hit(id, 2, { prNumber: 2, url: null, slug: "acme/web", runId: r2 });
    expect(repo.runLessons(r1)).toEqual([{ id, text: "t", status: "pending", kind: "created" }]);
    expect(repo.runLessons(r2)).toEqual([{ id, text: "t", status: "pending", kind: "hit" }]);
    expect(repo.runLessons(12345)).toEqual([]);
  });

  it("sources carry repo slug and run id", () => {
    const { repo, db } = setup();
    const r1 = new LessonRunsRepo(db).start({ queueId: null, slug: "acme/web", prNumber: 1, origin: "daily", startedAt: 1 });
    const id = repo.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "t", why: "w", at: 1, source: { prNumber: 1, url: "u", slug: "acme/web", runId: r1 } });
    repo.hit(id, 2, { prNumber: 2, url: null, slug: "acme/api", runId: null });
    expect(repo.get(id)!.sources).toMatchObject([
      { prNumber: 1, slug: "acme/web", runId: r1 },
      { prNumber: 2, slug: "acme/api", runId: null },
    ]);
  });
});
