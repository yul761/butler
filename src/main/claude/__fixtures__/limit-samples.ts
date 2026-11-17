import type { LimitHit } from "../../../shared/availability";

/** 2026-11-16T04:00Z，即 Asia/Shanghai 的 12:00。 */
export const LIMIT_NOW = 1794801600000;

export interface LimitSample {
  name: string;
  text: string;
  apiStatus: number | null;
  timeZone: string;
  expect: LimitHit["kind"] | null;
  resetsAt?: number | null;
}

const s = (name: string, text: string, timeZone: string, expectKind: LimitSample["expect"], resetsAt?: number | null, apiStatus: number | null = null): LimitSample => ({
  name, text, apiStatus, timeZone, expect: expectKind, ...(resetsAt === undefined ? {} : { resetsAt }),
});

export const LIMIT_SAMPLES: LimitSample[] = [
  s("epoch seconds", "Claude AI usage limit reached|1794819600", "UTC", "usage_limit", 1794819600000),
  s("epoch millis", "Claude AI usage limit reached|1794819600000", "UTC", "usage_limit", 1794819600000),
  s("epoch in the past", "Claude AI usage limit reached|1794798000", "UTC", "usage_limit", null),
  s("epoch too far", "Claude AI usage limit reached|1795579200", "UTC", "usage_limit", null),
  s("5-hour pm", "5-hour limit reached ∙ resets 3pm", "Asia/Shanghai", "usage_limit", 1794812400000),
  s("stated zone wins", "You've hit your limit · resets 3pm (Asia/Shanghai)", "UTC", "usage_limit", 1794812400000),
  s("weekly with date", "Weekly limit reached ∙ resets Nov 20, 5am", "Asia/Shanghai", "usage_limit", 1795122000000),
  s("rolls to tomorrow", "5-hour limit reached ∙ resets 11am", "Asia/Shanghai", "usage_limit", 1794884400000),
  s("spend limit date only", '{"type":"error","error":{"type":"billing_error","message":"spend limit reached · resets Nov 18 · request an increase"}}', "Asia/Shanghai", "usage_limit", Date.UTC(2026, 10, 17, 16, 0)),
  s("extra usage", "You're out of extra usage", "UTC", "usage_limit", null),
  s("credit", "Credit balance is too low", "UTC", "usage_limit", null),
  s("429 text", 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', "UTC", "rate_limit", null),
  s("529 status", "", "UTC", "overloaded", null, 529),
  s("repeated 529", "API Error: Repeated 529 Overloaded errors", "UTC", "overloaded", null),
  s("bedrock", "API Error: 400 ThrottlingException: Too many tokens, please wait before trying again.", "UTC", "rate_limit", null),
  s("selected model", "There's an issue with the selected model (claude-foo-9). It may not exist or you may not have access to it. Run /model to pick a different model.", "UTC", "model_unavailable", null),
  s("404 model", 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-foo-9"}}', "UTC", "model_unavailable", null),
  s("line number 429", "TypeError: x is undefined\n    at run (/app/main.js:429:12)", "UTC", null),
  s("prompt too long", "Prompt is too long", "UTC", null),
];
