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

describe("classifyLimit on the CLI's current limit messages", () => {
  // January, so Vancouver is PST (UTC-8) whatever the runtime's DST rules say for later months.
  const NOW = Date.UTC(2026, 0, 12, 12, 0); // 04:00 in Vancouver, 20:00 in Shanghai
  const SUFFIX = " (error type rate_limit, HTTP 429, request id req_X, model sent to the API: claude-x)";
  const cases: [string, string, number][] = [
    ["5-hour 9pm", "You've hit your 5-hour limit · resets 9pm (America/Vancouver)", Date.UTC(2026, 0, 13, 5, 0)],
    ["5-hour 9:30pm", "You've hit your 5-hour limit · resets 9:30pm (America/Vancouver)", Date.UTC(2026, 0, 13, 5, 30)],
    ["5-hour 9am", "You've hit your 5-hour limit · resets 9am (America/Vancouver)", Date.UTC(2026, 0, 12, 17, 0)],
    ["weekly 9am", "You've hit your weekly limit · resets 9am (America/Vancouver)", Date.UTC(2026, 0, 12, 17, 0)],
    ["weekly dated", "You've hit your weekly limit · resets Jan 18 at 9am (America/Vancouver)", Date.UTC(2026, 0, 18, 17, 0)],
    ["plain Shanghai (rolls to tomorrow)", "You've hit your limit · resets 3pm (Asia/Shanghai)", Date.UTC(2026, 0, 13, 7, 0)],
    ["plain UTC", "You've hit your limit · resets 3pm (UTC)", Date.UTC(2026, 0, 12, 15, 0)],
    ["5-hour/weekly", "You've hit your 5-hour/weekly limit · resets 9pm (America/Vancouver)", Date.UTC(2026, 0, 13, 5, 0)],
    ["with error suffix", `You've hit your 5-hour limit · resets 9pm (America/Vancouver)${SUFFIX}`, Date.UTC(2026, 0, 13, 5, 0)],
  ];
  it.each(cases)("%s", (_n, text, resetsAt) => {
    const hit = classifyLimit({ text, apiStatus: null, now: NOW, timeZone: "Europe/Paris" });
    expect(hit?.kind).toBe("usage_limit");
    expect(hit?.resetsAt).toBe(resetsAt);
  });

  it("keeps the legacy epoch form", () => {
    const epoch = Math.floor(NOW / 1000) + 3600;
    expect(classifyLimit({ text: `Claude AI usage limit reached|${epoch}`, apiStatus: null, now: NOW })).toMatchObject({ kind: "usage_limit", resetsAt: epoch * 1000 });
  });
});

