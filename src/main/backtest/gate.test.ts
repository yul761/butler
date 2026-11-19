import { describe, expect, it } from "vitest";
import { ADMISSION_POLICY_DEFAULTS, type AdmissionPolicy } from "../../shared/admission-policy";
import { gate5, verifiabilityValue, type Tested } from "./gate";

const P = (o: Partial<AdmissionPolicy> = {}) => ({ ...ADMISSION_POLICY_DEFAULTS, ...o }) as AdmissionPolicy;
const parts = { evidence: { value: 0.9, reason: "e" }, clarity: { value: 0.9, reason: "c" }, consistency: { value: 1, reason: "k" } };
const tested = (o: Partial<Tested> = {}): Tested => ({ kind: "tested", recall: 1, fpRate: 0, hits: 4, comments: 2, commentsMatched: 2, falsePositives: 0, prs: 50, skipped: [], ...o });

describe("verifiability", () => {
  it("is full at 50% recall and no false positives, half at the threshold, zero noise part at twice the threshold", () => {
    expect(verifiabilityValue({ recall: 0.5, fpRate: 0 }, P())).toBe(1);
    expect(verifiabilityValue({ recall: 1, fpRate: 0.2 }, P())).toBe(0.75);
    expect(verifiabilityValue({ recall: 1, fpRate: 0.4 }, P())).toBe(0.5);
    expect(verifiabilityValue({ recall: null, fpRate: null }, P())).toBe(0.75);
  });
});

describe("gate 5", () => {
  it("shelves on low recall and on too many false positives, with the number in the note", () => {
    const r = gate5(tested({ recall: 0 }), parts, P());
    expect(r).toMatchObject({ kind: "shelve", reason: "backtest_recall" });
    expect((r as { note: string }).note).toContain("0%");
    const f = gate5(tested({ fpRate: 0.34 }), parts, P());
    expect(f).toMatchObject({ kind: "shelve", reason: "backtest_fp" });
    expect((f as { note: string }).note).toContain("34%");
    // 阈值是策略项。
    expect(gate5(tested({ fpRate: 0.34 }), parts, P({ "backtest.maxFalsePositiveRate": 0.5 })).kind).toBe("score");
    expect(gate5(tested({ recall: 0.3 }), parts, P({ "backtest.minRecall": 0.5 }))).toMatchObject({ reason: "backtest_recall" });
  });

  it("a tested check is rescored with verifiability and has no cap", () => {
    const r = gate5(tested(), parts, P());
    expect(r.kind).toBe("score");
    if (r.kind !== "score") throw new Error("expected a score");
    const s = r.s;
    expect(s.parts.verifiability).toBeDefined();
    expect(s.parts.cap).toBeUndefined();
    expect(s.outcome).toBe("admit");
  });

  it("untested follows backtest.allowUntestedShadow; no hits and no replayable comments counts as untested", () => {
    const off = P({ "backtest.allowUntestedShadow": false });
    expect(gate5({ kind: "untested", reason: "not_cloned" }, parts, off)).toMatchObject({ kind: "shelve", reason: "untested" });
    expect(gate5(tested({ recall: null, hits: 0, fpRate: null }), parts, off)).toMatchObject({ kind: "shelve", reason: "untested" });
    const on = gate5({ kind: "untested", reason: "no_gh" }, parts, P());
    expect(on.kind).toBe("score");
    if (on.kind !== "score") throw new Error("expected a score");
    expect(on.s.parts.cap).toBeDefined();
  });

  it("a low verifiability can still drop a lesson below the admission line", () => {
    const weak = { evidence: { value: 0.7, reason: "" }, clarity: { value: 0.7, reason: "" }, consistency: { value: 0.7, reason: "" } };
    const r = gate5(tested({ recall: 0.05, fpRate: 0.2 }), weak, P());
    expect(r).toMatchObject({ kind: "score", s: { outcome: "low_score" } });
  });
});
