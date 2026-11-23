import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReviewEffectView, ReviewGroupStats } from "../../../shared/review-effect";
import { S } from "../strings";
import { ReviewEffectSection } from "./EffectPage";

const g = (prs: number): ReviewGroupStats => ({ prs, humanComments: 1.5, rounds: 2, firstReviewMs: 3_600_000, submitToMergeMs: 7_200_000 });

const v = (): ReviewEffectView => ({
  days: 30,
  weeks: [{ weekStart: Date.UTC(2026, 10, 2), prs: 3, avoidable: 3, perPr: 1 }, { weekStart: Date.UTC(2026, 10, 9), prs: 4, avoidable: 2, perPr: 0.5 }],
  shipherd: g(6), others: g(2), withBrief: g(5), withoutBrief: g(0),
  lessons: [{ lessonId: 1, text: "No raw SQL", confirmedAt: Date.UTC(2026, 10, 5), before: { prs: 3, perPr: 1 }, after: { prs: 2, perPr: 0 } }],
  landing: { confirmedBefore: 2, notYet: 3, unattributed: 1 },
});

describe("the Review effect section (ws-g)", () => {
  const html = renderToStaticMarkup(createElement(ReviewEffectSection, { v: v() }));

  it("shows groups, marks small samples, lists rules and landing", () => {
    expect(html).toContain('data-testid="effect-review"');
    expect(html).toContain(S.rv.effGroup.shipherd);
    expect(html.split(S.rv.effSmall).length - 1).toBe(2);
    expect(html).toContain("No raw SQL");
    expect(html).toContain(S.rv.effLanding(2, 3, 1));
  });

  it("says when no rule has enough PRs", () => {
    const empty = renderToStaticMarkup(createElement(ReviewEffectSection, { v: { ...v(), lessons: [] } }));
    expect(empty).toContain(S.rv.effLessonsNone);
  });
});
