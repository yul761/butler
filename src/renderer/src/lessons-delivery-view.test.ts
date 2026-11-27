import { describe, expect, it } from "vitest";
import { LESSON_FIELD_DEFAULTS, type Lesson, type LessonRepoView, type LessonsState } from "../../shared/lessons";
import { checkableLessons, deliveryRows, mergeLessonCount, proposalLabel, proposalMembers } from "./lessons-delivery-view";
import { STRINGS } from "./strings";

const zero = { full: 0, principle: 0, index: 0, drip: 0, check: 0 };
const repo = (slug: string, delivery = zero, overBudget = false): LessonRepoView => ({
  slug, localPath: `/x/${slug}`, lastAnalyzedAt: null, analyzedCount: 0, queued: 0, failed: 0, running: 0, skipped: 0, cancelled: 0, backfilled: false, delivery, overBudget,
});
const lesson = (id: number, over: Partial<Lesson> = {}): Lesson => ({
  id, scope: { kind: "repo", slug: "o/api" }, text: `t${id}`, why: "", status: "confirmed", hits: 1, lastSeenAt: 1, createdAt: 0, sources: [], ...LESSON_FIELD_DEFAULTS, scopeGlobs: [], ...over,
});
const proposal = (id: number, ids: number[], scope: Lesson["scope"] = { kind: "repo", slug: "o/api" }): LessonsState["mergeProposals"][number] => ({
  id, scope, ids, text: "merged", why: "", reason: "similar", createdAt: 0,
});

describe("lessons delivery view (BTL-274)", () => {
  it("lists only repos that have confirmed lessons, with their counts and whether they fit", () => {
    const rows = deliveryRows({ repos: [repo("o/empty"), repo("o/api", { ...zero, full: 3, drip: 2 }, true)] });
    expect(rows).toEqual([{ slug: "o/api", counts: { ...zero, full: 3, drip: 2 }, overBudget: true }]);
  });
  it("the merge button counts every lesson across proposals; only unconverted checkable confirmed lessons can become checks", () => {
    expect(mergeLessonCount({ mergeProposals: [proposal(1, [1, 2]), proposal(2, [3, 4, 5])] })).toBe(5);
    const lessons = [lesson(1, { checkability: "checkable" }), lesson(2, { checkability: "converted" }), lesson(3, { checkability: "checkable", status: "pending" }), lesson(4)];
    expect(checkableLessons({ lessons }).map((l) => l.id)).toEqual([1]);
  });
  it("labels a proposal by repo or product and shows the member lessons it still finds", () => {
    const s = { products: [{ id: 7, name: "shop", slugs: [] }], lessons: [lesson(1), lesson(2)] };
    expect(proposalLabel(proposal(1, [1, 2]), s)).toBe("o/api");
    expect(proposalLabel(proposal(1, [1, 2], { kind: "product", productId: 7 }), s)).toBe("shop");
    expect(proposalMembers(proposal(1, [2, 9, 1]), s).map((l) => l.id)).toEqual([2, 1]);
  });
  it("the copy no longer says lessons can't be sent, and has every delivery in both languages", () => {
    for (const S of [STRINGS.zh, STRINGS.en]) {
      const line = S.lessonsDeliveryLine({ full: 1, principle: 2, index: 3, drip: 4, check: 5 });
      for (const n of ["1", "2", "3", "4", "5"]) expect(line).toContain(n);
      expect(line).not.toMatch(/送不进去|can't be sent/);
      for (const d of ["full", "principle", "index", "drip", "check"]) {
        expect(S.lessonDelivery[d]).toBeTruthy();
        expect(S.lessonDeliveryTitle[d]).toBeTruthy();
      }
      expect(S.lessonsError.merge_stale).toBeTruthy();
    }
    // 「索引」那一档的规矩管整个仓库，第一次改文件时也会补送：悬停说明要说到这一点。
    expect(STRINGS.zh.lessonDeliveryTitle.index).toMatch(/lessons 工具/);
    expect(STRINGS.zh.lessonDeliveryTitle.index).toMatch(/补送/);
    expect(STRINGS.en.lessonDeliveryTitle.index).toMatch(/lessons tool/);
    expect(STRINGS.en.lessonDeliveryTitle.index).toMatch(/sends the full text/);
    expect(STRINGS.zh.lessonsMergeSimilar(3)).toBe("合并 3 条相似规矩");
  });
});
