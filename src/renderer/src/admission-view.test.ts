import { describe, expect, it } from "vitest";
import type { BatchReviewView, WizardRunView } from "../../shared/lesson-admission";
import { admissionScopeFromKey, admissionScopeKey, blockedText, durationText, latestRunFor, noteText, pct, scorePartRows, shelvedGroups } from "./admission-view";
import { STRINGS } from "./strings";

const run = (id: number, scope: WizardRunView["scope"]): WizardRunView => ({
  id, scope, state: "awaiting_accept", progress: { prs: { done: 0, total: 0 }, enrich: { done: 0, total: 0 } }, calls: 0, notes: [], summary: null, review: null, verdicts: [], failed: [],
  planBatch: null, acceptBatch: null, error: null, createdAt: 0, updatedAt: 0, finishedAt: null,
});

describe("admission view helpers", () => {
  it("orders the score parts and leaves out the missing ones", () => {
    expect(scorePartRows(null)).toEqual([]);
    const rows = scorePartRows({ composite: { value: 0.6, reason: "c" }, clarity: { value: 0.5, reason: "b" }, evidence: { value: 0.9, reason: "a" } });
    expect(rows.map((r) => r.key)).toEqual(["evidence", "clarity", "composite"]);
  });

  it("round-trips scope keys and finds the newest run of a scope", () => {
    for (const s of [{ kind: "all" }, { kind: "repo", slug: "acme/web" }, { kind: "product", productId: 4 }] as const) expect(admissionScopeFromKey(admissionScopeKey(s))).toEqual(s);
    const runs = [run(1, { kind: "all" }), run(3, { kind: "repo", slug: "a/b" }), run(2, { kind: "all" })];
    expect(latestRunFor(runs, { kind: "all" })?.id).toBe(2);
    expect(latestRunFor(runs, { kind: "product", productId: 1 })).toBeNull();
  });

  it("groups shelved and covered lessons by reason, largest group first", () => {
    const g = shelvedGroups([
      { lessonId: 1, verdict: "shelved", reason: "low_score", ref: null, score: 0.4 },
      { lessonId: 2, verdict: "admit", reason: null, ref: null, score: 0.9 },
      { lessonId: 3, verdict: "shelved", reason: "low_score", ref: null, score: 0.5 },
      { lessonId: 4, verdict: "covered", reason: null, ref: null, score: null },
      { lessonId: 5, verdict: "shelved", reason: null, ref: null, score: null },
    ]);
    expect(g).toEqual([{ reason: "low_score", lessonIds: [1, 3] }, { reason: "covered", lessonIds: [4] }, { reason: "other", lessonIds: [5] }]);
  });

  it("names the weakest metric when accepting is hidden, in both languages", () => {
    const review = {
      blocked: true, weakest: "samplePassRate",
      metrics: [{ key: "samplePassRate", value: 0.5, floor: 0.8, bound: "min", past: true, distance: 0.375 }],
    } as unknown as BatchReviewView;
    expect(blockedText(review, STRINGS.en)).toBe("Accept all is hidden: sample pass rate is 50%, below the floor of 80%.");
    expect(blockedText(review, STRINGS.zh)).toContain("抽查通过率");
    expect(blockedText({ ...review, blocked: false }, STRINGS.en)).toBeNull();
  });

  it("translates every note and duration", () => {
    for (const S of [STRINGS.en, STRINGS.zh]) {
      for (const n of [{ kind: "scanUnavailable" }, { kind: "notBacktested" }, { kind: "noGh" }, { kind: "uncloned", slug: "a/b" }, { kind: "ghFailed", slug: "a/b" }, { kind: "legacyViolations", slug: "a/b", count: 3 }, { kind: "noLint", slug: "a/b" }] as const) {
        expect(noteText(n, S).length).toBeGreaterThan(3);
      }
      expect(durationText(null, S)).toBe(S.wizardUnknownTime);
      expect(durationText(10_000, S)).toBe(S.wizardUnderMinute);
    }
    expect(durationText(5 * 60_000, STRINGS.en)).toBe("about 5 min");
    expect(pct(0.256)).toBe("26%");
    expect(pct(null)).toBe("—");
  });
});
