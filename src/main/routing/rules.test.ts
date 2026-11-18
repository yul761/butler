import { describe, expect, it } from "vitest";
import type { LimitRule } from "../../shared/model-routing";
import { LIMIT_NOW, LIMIT_SAMPLES } from "../claude/__fixtures__/limit-samples";
import { BUILTIN_RULES, DEFAULT_RULES, classifyDetailed, compileRules, genericSignal, namedModel, resolveResetWith } from "./rules";

const user = (p: Partial<LimitRule> & Pick<LimitRule, "kind" | "pattern">): LimitRule => ({
  id: `user:${p.pattern}`, category: "usage_limit", accountLevel: false, source: "user", enabled: true, note: "", ...p,
});

describe("rule engine", () => {
  it("built-ins classify every sample like 2.1.0", () => {
    for (const s of LIMIT_SAMPLES) {
      const d = classifyDetailed(DEFAULT_RULES, { text: s.text, apiStatus: s.apiStatus, now: LIMIT_NOW, timeZone: s.timeZone });
      expect(d?.hit.kind ?? null, s.name).toBe(s.expect);
      if (s.resetsAt !== undefined) expect(d?.hit.resetsAt ?? null, s.name).toBe(s.resetsAt);
    }
  });

  it("usage limits are account level, the others per model", () => {
    expect(classifyDetailed(DEFAULT_RULES, { text: "Weekly limit reached", apiStatus: null, now: LIMIT_NOW })).toMatchObject({ ruleId: "builtin:usage_limit", accountLevel: true });
    expect(classifyDetailed(DEFAULT_RULES, { text: "rate_limit_error", apiStatus: null, now: LIMIT_NOW })).toMatchObject({ ruleId: "builtin:rate_limit", accountLevel: false });
  });

  it("user regex rules recognise a company's own text", () => {
    const text = "Gateway says: monthly allotment for team exhausted";
    expect(classifyDetailed(DEFAULT_RULES, { text, apiStatus: null, now: LIMIT_NOW })).toBeNull();
    const set = compileRules([user({ kind: "regex", pattern: "allotment .* exhausted", accountLevel: true })]);
    expect(classifyDetailed(set, { text, apiStatus: null, now: LIMIT_NOW })).toMatchObject({ hit: { kind: "usage_limit", message: text }, accountLevel: true });
  });

  it("built-in text rules still win over user rules; a disabled built-in does not", () => {
    const set = compileRules([user({ kind: "regex", pattern: "overloaded", category: "usage_limit" })]);
    expect(classifyDetailed(set, { text: "overloaded_error", apiStatus: null, now: LIMIT_NOW })?.hit.kind).toBe("overloaded");
    const off = compileRules([user({ kind: "regex", pattern: "overloaded", category: "usage_limit" })], new Set(["builtin:overloaded"]));
    expect(classifyDetailed(off, { text: "overloaded_error", apiStatus: null, now: LIMIT_NOW })?.hit.kind).toBe("usage_limit");
  });

  it("field rules match a JSON key and value", () => {
    const set = compileRules([user({ kind: "field", pattern: "error.code=seat_exhausted" })]);
    const text = 'noise\n{"error": {"code": "seat_exhausted", "msg": "x"}}';
    expect(classifyDetailed(set, { text, apiStatus: null, now: LIMIT_NOW })?.hit).toMatchObject({ kind: "usage_limit", message: '{"error": {"code": "seat_exhausted", "msg": "x"}}' });
    expect(classifyDetailed(set, { text: '{"code": "other"}', apiStatus: null, now: LIMIT_NOW })).toBeNull();
  });

  it("status rules, with and without a text condition", () => {
    const set = compileRules([user({ kind: "status", pattern: "403:budget", category: "usage_limit" })]);
    expect(classifyDetailed(set, { text: "budget gone", apiStatus: 403, now: LIMIT_NOW })?.hit.kind).toBe("usage_limit");
    expect(classifyDetailed(set, { text: "forbidden", apiStatus: 403, now: LIMIT_NOW })).toBeNull();
    expect(classifyDetailed(set, { text: "API Error: 403 budget", apiStatus: null, now: LIMIT_NOW })?.hit.message).toBe("API Error: 403 budget");
  });

  it("disabled user rules and broken patterns are skipped", () => {
    const set = compileRules([user({ kind: "regex", pattern: "(", id: "bad" }), user({ kind: "regex", pattern: "zzz", enabled: false })]);
    expect(set.invalid).toEqual(["bad"]);
    expect(classifyDetailed(set, { text: "zzz", apiStatus: null, now: LIMIT_NOW })).toBeNull();
  });

  it("custom reset parsers: epoch, iso, relative, wall clock", () => {
    const now = LIMIT_NOW;
    const set = compileRules([
      user({ kind: "reset", pattern: "retry_at=(?<epoch>\\d{10})", category: null }),
      user({ kind: "reset", pattern: "until (?<iso>\\d{4}-\\d\\d-\\d\\dT[\\d:]+Z)", category: null }),
      user({ kind: "reset", pattern: "try again in (?<in_m>\\d+) minutes", category: null }),
      user({ kind: "reset", pattern: "renews (?<month>[A-Za-z]{3}) (?<day>\\d{1,2})", category: null }),
    ]);
    expect(resolveResetWith(set, `retry_at=${Math.floor(now / 1000) + 600}`, now)).toBe(Math.floor(now / 1000) * 1000 + 600_000);
    expect(resolveResetWith(set, "until 2026-11-16T06:00:00Z", now)).toBe(Date.UTC(2026, 10, 16, 6));
    expect(resolveResetWith(set, "try again in 30 minutes", now)).toBe(now + 30 * 60_000);
    expect(resolveResetWith(set, "renews Nov 20", now, "UTC")).toBe(Date.UTC(2026, 10, 20));
    expect(resolveResetWith(set, "try again later", now)).toBeNull();
    // Too far ahead is not believed.
    expect(resolveResetWith(set, "try again in 99999 minutes", now)).toBeNull();
  });

  it("built-in rules are listed with stable ids", () => {
    expect(BUILTIN_RULES.map((r) => r.id)).toContain("builtin:usage_limit");
    expect(new Set(BUILTIN_RULES.map((r) => r.id)).size).toBe(BUILTIN_RULES.length);
  });
});

describe("generic signals", () => {
  it("status codes", () => {
    expect(genericSignal({ text: "", apiStatus: 402 })).toEqual({ kind: "usage_limit", signal: "status" });
    expect(genericSignal({ text: "API Error: 429 whatever", apiStatus: null })).toEqual({ kind: "rate_limit", signal: "status" });
    expect(genericSignal({ text: "", apiStatus: 529 })).toEqual({ kind: "overloaded", signal: "status" });
  });
  it("keywords", () => {
    expect(genericSignal({ text: "Your org has no remaining credits", apiStatus: null })?.kind).toBe("usage_limit");
    expect(genericSignal({ text: "billing problem", apiStatus: null })?.kind).toBe("usage_limit");
    expect(genericSignal({ text: "request limited by gateway", apiStatus: null })?.kind).toBe("rate_limit");
    expect(genericSignal({ text: "TypeError at line 429", apiStatus: null })).toBeNull();
    expect(genericSignal({ text: "unlimited", apiStatus: null })).toBeNull();
  });
});

describe("namedModel", () => {
  it("reads the model from known error shapes", () => {
    expect(namedModel("(error type rate_limit, HTTP 429, request id req_X, model sent to the API: claude-x)")).toBe("claude-x");
    expect(namedModel("There's an issue with the selected model (claude-foo-9). It may not exist")).toBe("claude-foo-9");
    expect(namedModel('{"type":"not_found_error","message":"model: claude-foo-9"}')).toBe("claude-foo-9");
    expect(namedModel("rate limited")).toBeNull();
  });
});
