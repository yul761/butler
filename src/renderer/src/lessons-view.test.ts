import { describe, expect, it } from "vitest";
import type { Lesson, LessonRepoView, LessonsState } from "../../shared/lessons";
import { lessonsFor, lessonsTree } from "./lessons-view";

const repo = (slug: string): LessonRepoView => ({ slug, localPath: `/x/${slug}`, lastAnalyzedAt: null, analyzedCount: 0, queued: 0, failed: 0, backfilled: false, overflow: 0 });
const lesson = (id: number, scope: Lesson["scope"], status: Lesson["status"], hits = 1, lastSeenAt = 1): Lesson => ({
  id, scope, text: `t${id}`, why: "", status, hits, lastSeenAt, createdAt: 0, sources: [],
});
const state = (over: Partial<LessonsState> = {}): LessonsState => ({
  repos: [], unknownRepos: [], products: [], suggestions: [], lessons: [], ghAvailable: true, ...over,
});

describe("lessonsTree", () => {
  it("lists a repo under every product it belongs to, then loose repos under a null product", () => {
    const s = state({
      repos: ["o/web", "o/api", "o/x", "o/y"].map(repo),
      products: [
        { id: 1, name: "shop", slugs: ["o/web", "o/api"] },
        { id: 2, name: "admin", slugs: ["o/api", "o/x"] },
      ],
    });
    const t = lessonsTree(s);
    expect(t.map((g) => g.product?.name ?? null)).toEqual(["shop", "admin", null]);
    expect(t[0].slugs).toEqual(["o/web", "o/api"]);
    expect(t[1].slugs).toEqual(["o/api", "o/x"]);
    expect(t[2].slugs).toEqual(["o/y"]);
  });
  it("omits the loose group when every repo is in a product", () => {
    const s = state({ repos: [repo("o/a")], products: [{ id: 1, name: "p", slugs: ["o/a"] }] });
    expect(lessonsTree(s).map((g) => g.product?.id ?? null)).toEqual([1]);
  });
});

describe("lessonsFor", () => {
  const s = state({
    lessons: [
      lesson(1, { kind: "repo", slug: "o/api" }, "pending"),
      lesson(2, { kind: "repo", slug: "o/api" }, "disabled", 9),
      lesson(3, { kind: "repo", slug: "o/api" }, "confirmed", 2),
      lesson(4, { kind: "product", productId: 1 }, "confirmed"),
      lesson(5, { kind: "repo", slug: "o/web" }, "confirmed"),
    ],
  });
  it("returns only the repo's own lessons, not its products'", () => {
    const r = lessonsFor(s, { kind: "repo", slug: "o/api" });
    expect(r.pending.map((l) => l.id)).toEqual([1]);
    expect(r.confirmed.map((l) => l.id)).toEqual([3, 2]);
  });
  it("returns a product's own lessons, with disabled last", () => {
    expect(lessonsFor(s, { kind: "product", id: 1 }).confirmed.map((l) => l.id)).toEqual([4]);
  });
});
