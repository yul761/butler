import { afterEach, describe, expect, it } from "vitest";
import { summaryOutcomeIsError, summaryOutcomeMessage } from "./feature-summary-view";
import { STRINGS, setUiLang } from "./strings";

afterEach(() => setUiLang("zh"));

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
