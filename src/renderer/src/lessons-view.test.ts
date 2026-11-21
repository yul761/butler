import { describe, expect, it } from "vitest";
import { LESSON_FIELD_DEFAULTS, type Lesson, type LessonRepoView, type LessonsState } from "../../shared/lessons";
import { allPending, lessonsFor, lessonsTree, pruneLessonsUi, scopeLabel, type LessonsSelection } from "./lessons-view";

const repo = (slug: string): LessonRepoView => ({ slug, localPath: `/x/${slug}`, lastAnalyzedAt: null, analyzedCount: 0, queued: 0, failed: 0, running: 0, skipped: 0, cancelled: 0, backfilled: false, overflow: 0 });
const lesson = (id: number, scope: Lesson["scope"], status: Lesson["status"], hits = 1, lastSeenAt = 1): Lesson => ({
  id, scope, text: `t${id}`, why: "", status, hits, lastSeenAt, createdAt: 0, sources: [], ...LESSON_FIELD_DEFAULTS, scopeGlobs: [],
});
const state = (over: Partial<LessonsState> = {}): LessonsState => ({
  repos: [], unknownRepos: [], products: [], suggestions: [], lessons: [], ghAvailable: true, queue: { running: [], queued: 0, pause: null }, enrich: { needing: 0, running: false }, ...over,
});

describe("allPending and scopeLabel (BTL-244)", () => {
  it("lists every pending lesson across repos and products, in state order", () => {
    const s = state({
      products: [{ id: 1, name: "shop", slugs: ["o/web"] }],
      lessons: [
        lesson(1, { kind: "repo", slug: "o/api" }, "pending"),
        lesson(2, { kind: "repo", slug: "o/api" }, "confirmed"),
        lesson(3, { kind: "product", productId: 1 }, "pending"),
        lesson(4, { kind: "repo", slug: "o/web" }, "disabled"),
        lesson(5, { kind: "repo", slug: "o/web" }, "pending"),
      ],
    });
    expect(allPending(s).map((l) => l.id)).toEqual([1, 3, 5]);
    expect(allPending(state())).toEqual([]);
  });
  it("labels a repo lesson by its slug and a product lesson by the product's name", () => {
    const s = state({ products: [{ id: 1, name: "shop", slugs: [] }] });
    expect(scopeLabel({ scope: { kind: "repo", slug: "o/api" } }, s)).toBe("o/api");
    expect(scopeLabel({ scope: { kind: "product", productId: 1 } }, s)).toBe("shop");
    expect(scopeLabel({ scope: { kind: "product", productId: 9 } }, s)).toBe("#9");
  });
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

describe("pruneLessonsUi", () => {
  const s = state({
    products: [{ id: 5, name: "p", slugs: [] }],
    lessons: [lesson(1, { kind: "repo", slug: "o/a" }, "confirmed"), lesson(2, { kind: "repo", slug: "o/a" }, "confirmed")],
  });
  const ui = {
    editing: { id: 1 }, merging: { keepId: 1, dropId: 2 }, checked: [1, 2, 9], confirmingDelete: "lesson-1" as string | null,
    sel: null as LessonsSelection | null, selectedRunId: null as number | null,
  };
  it("keeps everything that still exists", () => {
    expect(pruneLessonsUi(s, { ...ui, checked: [1, 2] })).toEqual({ ...ui, checked: [1, 2] });
  });
  it("drops state pointing at gone lessons and products", () => {
    const gone = state({ lessons: [lesson(2, { kind: "repo", slug: "o/a" }, "confirmed")] });
    const r = pruneLessonsUi(gone, ui);
    expect(r).toEqual({ editing: null, merging: null, checked: [2], confirmingDelete: null, sel: null, selectedRunId: null });
  });
  it("disarms a product delete when the product is gone", () => {
    expect(pruneLessonsUi(s, { ...ui, confirmingDelete: "product-5" }).confirmingDelete).toBe("product-5");
    expect(pruneLessonsUi(state(), { ...ui, confirmingDelete: "product-5" }).confirmingDelete).toBeNull();
  });
  it("clears a selection whose product was deleted", () => {
    expect(pruneLessonsUi(state(), { ...ui, sel: { kind: "product", id: 5 } }).sel).toBeNull();
  });
  it("keeps a live product selection", () => {
    const sel: LessonsSelection = { kind: "product", id: 5 };
    expect(pruneLessonsUi(s, { ...ui, sel }).sel).toEqual(sel);
  });
  it("keeps a live repo selection and clears a gone one", () => {
    const sel: LessonsSelection = { kind: "repo", slug: "o/a" };
    const live = state({ repos: [repo("o/a")] });
    expect(pruneLessonsUi(live, { ...ui, sel }).sel).toEqual(sel);
    expect(pruneLessonsUi(state(), { ...ui, sel }).sel).toBeNull();
  });
  it("keeps a selected run while its repo is selected and alive, drops it otherwise", () => {
    const sel: LessonsSelection = { kind: "repo", slug: "o/a" };
    const live = state({ repos: [repo("o/a")] });
    expect(pruneLessonsUi(live, { ...ui, sel, selectedRunId: 4 }).selectedRunId).toBe(4);
    expect(pruneLessonsUi(state(), { ...ui, sel, selectedRunId: 4 }).selectedRunId).toBeNull();
    expect(pruneLessonsUi(s, { ...ui, sel: { kind: "product", id: 5 }, selectedRunId: 4 }).selectedRunId).toBeNull();
  });
});
