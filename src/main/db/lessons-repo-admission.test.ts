import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { EXCERPT_MAX, LessonsRepo } from "./lessons-repo";

const setup = () => {
  const db = memDb();
  const repo = new LessonsRepo(db);
  repo.upsertRepo("acme/web", "/w", 1);
  return { db, repo };
};
const add = (repo: LessonsRepo, at: number, extra: Record<string, unknown> = {}) =>
  repo.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: `t${at}`, why: "w", at, source: { prNumber: at, url: `https://x/${at}`, slug: "acme/web", runId: null, ...extra } });

describe("LessonsRepo, workstream D additions", () => {
  it("stores source reviewer, path, line and a capped excerpt; the page view leaves the excerpt out", () => {
    const { repo } = setup();
    const id = add(repo, 1, { reviewer: "rev1", path: "src/a.ts", line: 4, excerpt: "x".repeat(EXCERPT_MAX + 50) });
    const l = repo.get(id)!;
    expect(l.sources[0]).toMatchObject({ reviewer: "rev1", path: "src/a.ts", line: 4 });
    expect("excerpt" in l.sources[0]).toBe(false);
    expect(repo.sourcesWithExcerpt(id)[0].excerpt).toHaveLength(EXCERPT_MAX);
  });

  it("fillSource only fills empty details", () => {
    const { repo } = setup();
    const id = add(repo, 1, { reviewer: "rev1" });
    const sid = repo.get(id)!.sources[0].id;
    expect(repo.fillSource(sid, { reviewer: "other", path: "p.ts", excerpt: "body" })).toBe(true);
    expect(repo.sourcesWithExcerpt(id)[0]).toMatchObject({ reviewer: "rev1", path: "p.ts", excerpt: "body" });
    repo.fillSource(sid, { line: 3 });
    expect(repo.fillSource(sid, { line: 9 })).toBe(false);
    expect(repo.get(id)!.sources[0].line).toBe(3);
  });

  it("merge keeps the earlier created_at and carries the excerpts over", () => {
    const { repo } = setup();
    const keep = add(repo, 20);
    const drop = add(repo, 5, { excerpt: "old comment" });
    repo.merge(keep, drop, "merged", 30);
    const k = repo.get(keep)!;
    expect(k.createdAt).toBe(5);
    expect(k.lastSeenAt).toBe(20);
    expect(k.hits).toBe(2);
    expect(repo.sourcesWithExcerpt(keep).map((s) => s.excerpt)).toContain("old comment");
  });

  it("setStatus stamps confirmed_at once; setScope moves a lesson to a product", () => {
    const { repo } = setup();
    const id = add(repo, 1);
    repo.setStatus(id, "confirmed", 50);
    repo.setStatus(id, "disabled", 60);
    repo.setStatus(id, "confirmed", 70);
    expect(repo.get(id)!.confirmedAt).toBe(50);
    const p = repo.createProduct("P", ["acme/web"], 1);
    repo.setScope(id, { kind: "product", productId: p }, 80);
    expect(repo.get(id)!.scope).toEqual({ kind: "product", productId: p });
  });

  it("patches the new lesson fields", () => {
    const { repo } = setup();
    const id = add(repo, 1);
    repo.setFields(id, { enrichedAt: 3, checkabilityReason: "why", shelvedNote: "note" }, 4);
    expect(repo.get(id)).toMatchObject({ enrichedAt: 3, checkabilityReason: "why", shelvedNote: "note", principleId: null });
  });
});
