import { describe, expect, it } from "vitest";
import { LIMIT_NOW, LIMIT_SAMPLES } from "./__fixtures__/limit-samples";
import { classifyLimit, isPauseKind } from "./limits";

describe("classifyLimit", () => {
  it.each(LIMIT_SAMPLES)("classifies $name", (s) => {
    const hit = classifyLimit({ text: s.text, apiStatus: s.apiStatus, now: LIMIT_NOW, timeZone: s.timeZone });
    expect(hit?.kind ?? null).toBe(s.expect);
    if (s.resetsAt !== undefined) expect(hit?.resetsAt ?? null).toBe(s.resetsAt);
  });

  it("text patterns win over the status code", () => {
    expect(classifyLimit({ text: "usage limit reached", apiStatus: 429, now: LIMIT_NOW })?.kind).toBe("usage_limit");
  });

  it("message is the matching line, at most 300 chars", () => {
    const hit = classifyLimit({ text: `noise\n  Weekly limit reached ${"x".repeat(400)}\nmore`, apiStatus: null, now: LIMIT_NOW });
    expect(hit?.message.startsWith("Weekly limit reached")).toBe(true);
    expect(hit?.message.length).toBe(300);
    expect(classifyLimit({ text: "a\nCredit balance is too low\nb", apiStatus: null, now: LIMIT_NOW })?.message).toBe("Credit balance is too low");
  });

  it("isPauseKind is false only for model_unavailable", () => {
    expect(isPauseKind("usage_limit") && isPauseKind("rate_limit") && isPauseKind("overloaded")).toBe(true);
    expect(isPauseKind("model_unavailable")).toBe(false);
  });
});
