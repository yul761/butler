import { describe, expect, it } from "vitest";
import { LIMIT_NOW } from "../claude/__fixtures__/limit-samples";
import { correlatedLimit, distinctiveLine, fingerprint, ruleFromSample } from "./learning";
import { classifyDetailed, compileRules } from "./rules";

describe("learning", () => {
  it("fingerprints ignore numbers and ids", () => {
    const a = "Error: team seat budget exhausted (used 120 of 100), request req_ABC123\nstack…";
    const b = "Error: team seat budget exhausted (used 133 of 100), request req_ZZZ9\nother";
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).not.toBe(fingerprint("Error: something else"));
  });

  it("picks the line that looks like the cause", () => {
    expect(distinctiveLine("starting\n\nGateway: allotment exceeded for org 4\nbye")).toBe("Gateway: allotment exceeded for org 4");
    expect(distinctiveLine("just one line")).toBe("just one line");
  });

  it("a learned rule recognises the sample and its variants (acceptance 2)", () => {
    const sample = "proxy said: Seat budget exhausted (used 120 of 100) req_ABC123 [deadbeefcafe]";
    const rule = ruleFromSample(sample, "usage_limit", true, "learned:1");
    expect(rule).toMatchObject({ kind: "regex", source: "learned", category: "usage_limit", accountLevel: true });
    const set = compileRules([rule]);
    expect(classifyDetailed(compileRules([]), { text: sample, apiStatus: null, now: LIMIT_NOW })).toBeNull();
    expect(classifyDetailed(set, { text: sample, apiStatus: null, now: LIMIT_NOW })).toMatchObject({ ruleId: "learned:1", accountLevel: true });
    expect(classifyDetailed(set, { text: "proxy said: Seat budget exhausted (used 7 of 5) req_Q [0123abcd99]", apiStatus: null, now: LIMIT_NOW })?.hit.kind).toBe("usage_limit");
    expect(classifyDetailed(set, { text: "proxy said: all fine", apiStatus: null, now: LIMIT_NOW })).toBeNull();
  });

  it("special characters in the sample are escaped", () => {
    const sample = "Denied (*quota*) [x] $1.00 + tax?";
    const set = compileRules([ruleFromSample(sample, "usage_limit", false, "l")]);
    expect(classifyDetailed(set, { text: sample, apiStatus: null, now: LIMIT_NOW })).not.toBeNull();
  });

  it("correlated: three failures in a row while another model succeeded since", () => {
    expect(correlatedLimit({ consecutiveFailures: 3, failureStreakSince: 100 }, [150])).toBe(true);
    expect(correlatedLimit({ consecutiveFailures: 3, failureStreakSince: 100 }, [50, null])).toBe(false);
    expect(correlatedLimit({ consecutiveFailures: 2, failureStreakSince: 100 }, [150])).toBe(false);
  });
});
