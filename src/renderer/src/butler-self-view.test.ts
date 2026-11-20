import { describe, expect, it } from "vitest";
import { LESSON_FIELD_DEFAULTS, type Lesson, type LessonRepoView, type LessonsState } from "../../shared/lessons";
import { auditIsEmpty, EFFECT_TABS, firstPendingSelection, pendingLessons } from "./butler-self-view";

const repo = (slug: string): LessonRepoView => ({ slug, localPath: `/x/${slug}`, lastAnalyzedAt: null, analyzedCount: 0, queued: 0, failed: 0, running: 0, skipped: 0, cancelled: 0, backfilled: false, overflow: 0 });
const lesson = (id: number, scope: Lesson["scope"], status: Lesson["status"]): Lesson => ({
  id, scope, text: `t${id}`, why: "", status, hits: 1, lastSeenAt: 1, createdAt: 0, sources: [], ...LESSON_FIELD_DEFAULTS, scopeGlobs: [],
});
const state = (over: Partial<LessonsState> = {}): LessonsState => ({
  repos: [], unknownRepos: [], products: [], suggestions: [], lessons: [], ghAvailable: true, queue: { running: [], queued: 0, pause: null }, enrich: { needing: 0, running: false }, ...over,
});

describe("pendingLessons", () => {
  it("counts pending only, not confirmed or disabled", () => {
    const s = state({
      lessons: [
        lesson(1, { kind: "repo", slug: "o/a" }, "pending"),
        lesson(2, { kind: "repo", slug: "o/a" }, "confirmed"),
        lesson(3, { kind: "repo", slug: "o/a" }, "disabled"),
        lesson(4, { kind: "product", productId: 1 }, "pending"),
      ],
    });
    expect(pendingLessons(s)).toBe(2);
  });
  it("is 0 with no lessons", () => {
    expect(pendingLessons(state())).toBe(0);
  });
});

describe("firstPendingSelection", () => {
  it("prefers a product with pending rules over a repo", () => {
    const s = state({
      repos: [repo("o/a")],
      products: [{ id: 7, name: "p", slugs: ["o/a"] }],
      lessons: [lesson(1, { kind: "repo", slug: "o/a" }, "pending"), lesson(2, { kind: "product", productId: 7 }, "pending")],
    });
    expect(firstPendingSelection(s)).toEqual({ kind: "product", id: 7 });
  });
  it("falls back to the first repo with pending rules, in state order", () => {
    const s = state({
      repos: [repo("o/a"), repo("o/b")],
      lessons: [lesson(1, { kind: "repo", slug: "o/b" }, "pending"), lesson(2, { kind: "repo", slug: "o/a" }, "confirmed")],
    });
    expect(firstPendingSelection(s)).toEqual({ kind: "repo", slug: "o/b" });
  });
  it("returns null with nothing pending", () => {
    expect(firstPendingSelection(state({ repos: [repo("o/a")], lessons: [lesson(1, { kind: "repo", slug: "o/a" }, "confirmed")] }))).toBeNull();
  });
  it("skips pending rules whose product or repo is gone", () => {
    const s = state({
      repos: [repo("o/a")],
      products: [{ id: 1, name: "p", slugs: [] }],
      lessons: [lesson(1, { kind: "product", productId: 99 }, "pending"), lesson(2, { kind: "repo", slug: "o/gone" }, "pending"), lesson(3, { kind: "repo", slug: "o/a" }, "pending")],
    });
    expect(firstPendingSelection(s)).toEqual({ kind: "repo", slug: "o/a" });
    expect(firstPendingSelection({ ...s, lessons: s.lessons.slice(0, 2) })).toBeNull();
  });
});

describe("auditIsEmpty", () => {
  it("is true only when both counts are 0", () => {
    expect(auditIsEmpty({ llmEntries: 0, externalEntries: 0 })).toBe(true);
    expect(auditIsEmpty({ llmEntries: 1, externalEntries: 0 })).toBe(false);
    expect(auditIsEmpty({ llmEntries: 0, externalEntries: 2 })).toBe(false);
  });
});

describe("EFFECT_TABS", () => {
  it("lists the five tabs in order", () => {
    expect([...EFFECT_TABS]).toEqual(["overview", "trend", "spend", "rework", "automation"]);
  });
});
