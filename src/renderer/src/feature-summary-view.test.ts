import { afterEach, describe, expect, it } from "vitest";
import type { Pr } from "../../shared/handoff";
import { prLabel, prPill, summaryOutcomeIsError, summaryOutcomeMessage } from "./feature-summary-view";
import { STRINGS, setUiLang } from "./strings";

const pr = (state: Pr["state"], review: Pr["review"], number = 1, url = "https://github.com/o/r/pull/1"): Pr => ({ number, url, state, review });

afterEach(() => setUiLang("zh"));

describe("prPill", () => {
  it("covers the five kinds", () => {
    expect(prPill(pr("merged", "approved"))).toBe("merged");
    expect(prPill(pr("closed", null))).toBe("closed");
    expect(prPill(pr("open", "approved"))).toBe("approved");
    expect(prPill(pr("open", "changes_requested"))).toBe("changes");
    expect(prPill(pr("open", "pending"))).toBe("pending");
    expect(prPill(pr("open", null))).toBe("pending");
  });
});

describe("prLabel", () => {
  it("is #number for one PR and repo#number when there are several", () => {
    const a = pr("open", null, 812, "https://github.com/o/backend/pull/812");
    const b = pr("open", null, 455, "https://github.com/o/frontend/pull/455");
    expect(prLabel(a, [a])).toBe("#812");
    expect(prLabel(a, [a, b])).toBe("backend#812");
    expect(prLabel(pr("open", null, 3, "https://gitlab.example/x/-/merge_requests/3"), [a, b])).toBe("#3");
  });
});

describe("summaryOutcomeMessage", () => {
  it("explains skips and failures in plain words, in both languages", () => {
    expect(summaryOutcomeMessage({ featureId: 1, status: "skipped", reason: "nothing_to_summarize" })).toContain("总控 session");
    expect(summaryOutcomeMessage({ featureId: 1, status: "skipped", reason: "rate_limited" })).toContain("额度");
    expect(summaryOutcomeMessage({ featureId: 1, status: "failed", reason: "timeout", message: "超时" })).toContain("超时");
    expect(summaryOutcomeMessage({ featureId: 1, status: "stored", handoffId: 2, degraded: false })).toBe(STRINGS.zh.featureSummaryStored);
    expect(summaryOutcomeMessage({ featureId: 1, status: "stored", handoffId: 2, degraded: true })).toBe(STRINGS.zh.featureSummaryStoredDegraded);
    setUiLang("en");
    expect(summaryOutcomeMessage({ featureId: 1, status: "skipped", reason: "nothing_to_summarize" })).toContain("coordinator session");
    expect(summaryOutcomeMessage({ featureId: 1, status: "skipped", reason: "rate_limited" })).toContain("rate limited");
  });
});

describe("summaryOutcomeIsError", () => {
  it("shows failures and rate limits as errors, but nothing_to_summarize as plain information", () => {
    expect(summaryOutcomeIsError({ featureId: 1, status: "failed", reason: "timeout", message: "超时" })).toBe(true);
    expect(summaryOutcomeIsError({ featureId: 1, status: "skipped", reason: "rate_limited" })).toBe(true);
    expect(summaryOutcomeIsError({ featureId: 1, status: "skipped", reason: "nothing_to_summarize" })).toBe(false);
    expect(summaryOutcomeIsError({ featureId: 1, status: "stored", handoffId: 2, degraded: false })).toBe(false);
    // 存下的是 degraded（输出没通过校验）照旧按错误显示。
    expect(summaryOutcomeIsError({ featureId: 1, status: "stored", handoffId: 2, degraded: true })).toBe(true);
  });
});
