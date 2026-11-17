import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { MIGRATIONS } from "./migrations";
import { LessonsRepo } from "./lessons-repo";

const setup = () => {
  const db = memDb();
  const repo = new LessonsRepo(db);
  repo.upsertRepo("acme/web", "/w", 1);
  repo.upsertRepo("acme/api", "/a", 1);
  return { db, repo };
};
const src = { prNumber: 7, url: "https://x/7" };
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
    repo.hit(id, 20, { prNumber: 8, url: null });
    repo.hit(id, 30, { prNumber: 8, url: null });
    repo.hit(id, 40, src);
    expect(repo.get(id)).toMatchObject({ hits: 2, lastSeenAt: 40 });
    expect(repo.get(id)?.sources.map((s) => s.prNumber)).toEqual([7, 8]);
  });

  it("merge sums hits, unions sources, takes max last_seen, removes drop", () => {
    const { repo } = setup();
    const keep = add(repo, "k");
    const drop = add(repo, "d");
    repo.hit(keep, 20, { prNumber: 8, url: null });
    repo.hit(drop, 50, { prNumber: 9, url: null });
    repo.merge(keep, drop, "merged", 60);
    const l = repo.get(keep)!;
    expect(l).toMatchObject({ text: "merged", hits: 4, lastSeenAt: 50 });
    expect(l.sources.map((s) => s.prNumber).sort()).toEqual([7, 8, 9]);
    expect(repo.get(drop)).toBeNull();
    expect(repo.source(l.sources[0].id)?.prNumber).toBe(l.sources[0].prNumber);
    repo.remove(keep);
    expect(repo.get(keep)).toBeNull();
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
    repo.finish(b.id, "failed", 150, "gh down");
    expect(repo.queueCounts("acme/web")).toEqual({ queued: 1, failed: 1 });
    expect(repo.enqueue("acme/web", [2], "backfill", 160)).toBe(0);
    expect(repo.queueCounts("acme/web")).toEqual({ queued: 2, failed: 0 });
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
});
