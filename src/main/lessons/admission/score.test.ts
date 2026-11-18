import { describe, expect, it } from "vitest";
import { ADMISSION_POLICY_DEFAULTS, type AdmissionPolicy } from "../../../shared/admission-policy";
import { MAIN_STRINGS } from "../../strings";
import { clarityPart, compositeOf, consistencyPart, DAY_MS, evidencePart, scoreLesson } from "./score";

const P: AdmissionPolicy = { ...ADMISSION_POLICY_DEFAULTS };
const T = MAIN_STRINGS.en.admission;
const NOW = 1000 * DAY_MS;

describe("evidence", () => {
  it.each([
    // hits, prs, reviewers, days ago, degraded → value
    [5, 3, 1, 0, false, 1],
    [1, 1, 1, 0, false, 0.253],
    [2, 2, 1, 0, false, 0.507],
    [5, 3, 1, 180, false, 0.5],
    [5, 3, 3, 0, false, 1],
    [2, 2, 3, 0, false, 0.607],
    [2, 2, 9, 0, false, 0.607],
    [2, 2, 1, 0, true, 0.407],
    [0, 0, 0, 0, true, 0],
  ])("%i hits, %i PRs, %i reviewers, %i days, degraded %s → %f", (hits, prs, reviewers, days, degraded, want) => {
    expect(evidencePart({ hits, prs, reviewers, lastSeenAt: NOW - days * DAY_MS, degraded }, P, NOW, T).value).toBeCloseTo(want, 2);
  });

  it("says what it counted", () => {
    expect(evidencePart({ hits: 2, prs: 1, reviewers: 0, lastSeenAt: NOW - 3 * DAY_MS, degraded: true }, P, NOW, T).reason).toBe(
      "came up 2 times in 1 PR, reviewers unknown; last seen 3 days ago; produced by a fallback model, minus 0.10",
    );
    expect(evidencePart({ hits: 1, prs: 1, reviewers: 1, lastSeenAt: NOW, degraded: false }, P, NOW, MAIN_STRINGS.zh.admission).reason).toBe("出现 1 次，1 个 PR，1 位评审人；最近一次在 0 天前");
  });
});

describe("clarity and consistency", () => {
  it("maps the model's answer and penalises unclear scope and fallback output", () => {
    expect(clarityPart("yes", true, "", false, P, T)).toEqual({ value: 1, reason: T.clarity.yes });
    expect(clarityPart("partly", false, "vague", false, P, T).value).toBeCloseTo(0.3);
    expect(clarityPart("no", true, "", true, P, T).value).toBe(0);
    expect(clarityPart("partly", true, "names no file", false, P, T).reason).toBe(`${T.clarity.partly}: names no file`);
    expect(consistencyPart(null, T).value).toBe(1);
    expect(consistencyPart({ ref: 4, reason: "only in tests" }, T)).toEqual({ value: 0.5, reason: "conflicts with #4 only in some cases: only in tests" });
  });
});

describe("composite and lines", () => {
  const part = (value: number) => ({ value, reason: "r" });

  it("renormalises the weights over the parts that have a value", () => {
    // evidence 0.3, clarity 0.2, consistency 0.2 → (0.3·1 + 0.2·0.5 + 0.2·1) / 0.7
    expect(compositeOf({ evidence: part(1), clarity: part(0.5), consistency: part(1) }, P)).toBeCloseTo(0.857, 3);
    expect(compositeOf({ evidence: part(1), clarity: part(0.5), consistency: part(1), verifiability: part(0) }, P)).toBeCloseTo(0.6, 3);
    const zero = { ...P, "score.weight.evidence": 0, "score.weight.clarity": 0, "score.weight.consistency": 0 };
    expect(compositeOf({ evidence: part(1), clarity: part(0), consistency: part(0.5) }, zero)).toBeCloseTo(0.5);
  });

  it("uses the stricter line for prose and caps an untested check", () => {
    const parts = { evidence: part(0.7), clarity: part(1), consistency: part(1) }; // 0.871
    const checkable = scoreLesson(parts, true, P, T);
    expect(checkable.outcome).toBe("admit");
    expect(checkable.score).toBeCloseTo(0.871, 3);
    expect(checkable.parts.cap).toEqual({ value: 0.69, reason: `${T.untested}; ${T.cap("0.69")}` });
    expect(checkable.parts.composite!.reason).toBe("overall 0.87 (evidence 0.70, clarity 1.00, consistency 1.00); the admission line for checkable rules is 0.70");
    const prose = scoreLesson({ ...parts, evidence: part(0.4) }, false, P, T); // 0.743
    expect(prose.outcome).toBe("low_score");
    expect(prose.weakest).toBe("evidence");
    expect(prose.note).toBe("overall 0.74, below the admission line 0.80; weakest: evidence");
    expect(prose.parts.cap).toBeUndefined();
    expect(scoreLesson({ ...parts, verifiability: part(0.9) }, true, P, T).parts.cap).toBeUndefined();
  });

  it("shelves below the drop line and for low clarity", () => {
    const low = scoreLesson({ evidence: part(0), clarity: part(0.5), consistency: part(0.5) }, true, P, T);
    expect(low.outcome).toBe("below_drop");
    expect(low.note).toContain("drop line 0.30");
    const unclear = scoreLesson({ evidence: part(1), clarity: { value: 0.1, reason: "too vague" }, consistency: part(1) }, true, P, T);
    expect(unclear.outcome).toBe("clarity");
    expect(unclear.note).toBe("clarity 0.10 is below 0.40: too vague");
  });
});
