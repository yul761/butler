import { describe, expect, it } from "vitest";
import { isEmptyLessonFilter, matchesLessonFilter, parseLessonFilter } from "./lesson-filter";
import { LESSON_FIELD_DEFAULTS, type Lesson } from "./lessons";

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: 1, scope: { kind: "repo", slug: "acme/web" }, text: "Use the logger", why: "Reviewers asked twice", status: "pending", hits: 1,
  lastSeenAt: 1, createdAt: 1, sources: [], ...LESSON_FIELD_DEFAULTS, scopeGlobs: [], ...over,
});

describe("matchesLessonFilter", () => {
  it("matches everything with an empty filter except merged rows", () => {
    expect(matchesLessonFilter(lesson(), {})).toBe(true);
    expect(matchesLessonFilter(lesson({ mergedInto: 3 }), {})).toBe(false);
  });

  it("checks each criterion", () => {
    const repo = lesson();
    const product = lesson({ scope: { kind: "product", productId: 4 } });
    expect(matchesLessonFilter(repo, { slug: "acme/web" })).toBe(true);
    expect(matchesLessonFilter(repo, { slug: "acme/api" })).toBe(false);
    expect(matchesLessonFilter(product, { slug: "acme/web" })).toBe(false);
    expect(matchesLessonFilter(product, { productId: 4 })).toBe(true);
    expect(matchesLessonFilter(repo, { productId: 4 })).toBe(false);
    expect(matchesLessonFilter(repo, { status: ["pending", "confirmed"] })).toBe(true);
    expect(matchesLessonFilter(repo, { status: ["confirmed"] })).toBe(false);
    expect(matchesLessonFilter(lesson({ admission: "auto" }), { admission: ["auto"] })).toBe(true);
    expect(matchesLessonFilter(repo, { admission: ["auto"] })).toBe(false);
    expect(matchesLessonFilter(repo, { checkability: ["unclassified"] })).toBe(true);
    expect(matchesLessonFilter(lesson({ checkability: "prose" }), { checkability: ["unclassified"] })).toBe(false);
    expect(matchesLessonFilter(lesson({ checkability: "prose" }), { checkability: ["prose", "checkable"] })).toBe(true);
    expect(matchesLessonFilter(lesson({ shelvedReason: "conflict" }), { shelvedReason: ["conflict"] })).toBe(true);
    expect(matchesLessonFilter(repo, { shelvedReason: ["conflict"] })).toBe(false);
    expect(matchesLessonFilter(lesson({ hits: 3 }), { minHits: 3 })).toBe(true);
    expect(matchesLessonFilter(lesson({ hits: 2 }), { minHits: 3 })).toBe(false);
    expect(matchesLessonFilter(lesson({ score: 0.5 }), { minScore: 0.5, maxScore: 0.5 })).toBe(true);
    expect(matchesLessonFilter(lesson({ score: 0.4 }), { minScore: 0.5 })).toBe(false);
    expect(matchesLessonFilter(lesson({ score: 0.6 }), { maxScore: 0.5 })).toBe(false);
    expect(matchesLessonFilter(repo, { minScore: 0 }), "no score never matches a score bound").toBe(false);
    expect(matchesLessonFilter(lesson({ batchId: 9 }), { batchId: 9 })).toBe(true);
    expect(matchesLessonFilter(repo, { batchId: 9 })).toBe(false);
    expect(matchesLessonFilter(lesson({ degraded: true }), { degraded: true })).toBe(true);
    expect(matchesLessonFilter(repo, { degraded: true })).toBe(false);
    expect(matchesLessonFilter(repo, { text: "LOGGER" })).toBe(true);
    expect(matchesLessonFilter(repo, { text: "twice" }), "searches the why too").toBe(true);
    expect(matchesLessonFilter(repo, { text: "nope" })).toBe(false);
    expect(matchesLessonFilter(repo, { text: "  " })).toBe(true);
  });

  it("needs every given criterion", () => {
    expect(matchesLessonFilter(lesson({ hits: 5 }), { slug: "acme/web", minHits: 2, status: ["pending"] })).toBe(true);
    expect(matchesLessonFilter(lesson({ hits: 5 }), { slug: "acme/web", minHits: 2, status: ["confirmed"] })).toBe(false);
  });
});

describe("parseLessonFilter", () => {
  it("accepts a valid filter and rejects anything else", () => {
    expect(parseLessonFilter({ slug: "acme/web", status: ["pending", "pending"], minHits: 2, minScore: 0.1, checkability: ["unclassified"], degraded: false })).toEqual({
      slug: "acme/web", status: ["pending"], minHits: 2, minScore: 0.1, checkability: ["unclassified"], degraded: false,
    });
    for (const bad of [null, [], "x", { nope: 1 }, { status: ["maybe"] }, { minHits: -1 }, { minHits: 1.5 }, { minScore: 2 }, { productId: 0 }, { text: "x".repeat(501) }, { slug: "" }, { degraded: "yes" }, { shelvedReason: [3] }]) {
      expect(() => parseLessonFilter(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("knows an empty filter", () => {
    expect(isEmptyLessonFilter({})).toBe(true);
    expect(isEmptyLessonFilter({ status: [], text: " " })).toBe(true);
    expect(isEmptyLessonFilter({ minHits: 0 })).toBe(false);
  });
});
