import { describe, expect, it } from "vitest";
import { LOOP_POLICY_DEFAULTS, LOOP_POLICY_KEYS, LoopPolicyError, checkLoopValue, compilePattern, parseLoopOverrides, sanitizeLoopOverrides } from "./loop-policy";

describe("loop policy", () => {
  it("is off by default and keeps the design defaults", () => {
    expect(LOOP_POLICY_DEFAULTS["comments.enabled"]).toBe(false);
    expect(LOOP_POLICY_DEFAULTS["ci.enabled"]).toBe(false);
    expect(LOOP_POLICY_DEFAULTS["comments.copilot"]).toBe("auto");
    expect(LOOP_POLICY_DEFAULTS["comments.human"]).toBe("review");
    expect(LOOP_POLICY_DEFAULTS["ci.maxReruns"]).toBe(2);
    expect(LOOP_POLICY_DEFAULTS["ci.flakyTests"]).toEqual([]);
    expect(new Set(LOOP_POLICY_KEYS.map((k) => k.key)).size).toBe(LOOP_POLICY_KEYS.length);
  });

  it("checks values by kind", () => {
    expect(checkLoopValue("ci.maxReruns", 3)).toBe(3);
    expect(() => checkLoopValue("ci.maxReruns", 6)).toThrow(LoopPolicyError);
    expect(() => checkLoopValue("ci.maxReruns", 1.5)).toThrow(LoopPolicyError);
    expect(() => checkLoopValue("comments.copilot", "maybe")).toThrow(LoopPolicyError);
    expect(() => checkLoopValue("nope", true)).toThrow(/unknown_key/);
    expect(checkLoopValue("ci.envPatterns", [" ETIMEDOUT ", "", "ETIMEDOUT", "/flaky\\d+/"])).toEqual(["ETIMEDOUT", "/flaky\\d+/"]);
    expect(() => checkLoopValue("ci.envPatterns", ["/(/"])).toThrow(/bad_pattern/);
    expect(() => checkLoopValue("ci.envPatterns", [1])).toThrow(/bad_value/);
  });

  it("parses overrides strictly and sanitizes stored ones leniently", () => {
    expect(parseLoopOverrides({ "ci.enabled": true, "ci.maxReruns": null })).toEqual({ "ci.enabled": true });
    expect(() => parseLoopOverrides({ "ci.enabled": "yes" })).toThrow();
    expect(() => parseLoopOverrides([])).toThrow();
    expect(sanitizeLoopOverrides({ "ci.enabled": "yes", "ci.maxReruns": 1, bogus: 2 })).toEqual({ "ci.maxReruns": 1 });
    expect(sanitizeLoopOverrides("x")).toEqual({});
  });

  it("compiles substring and regex patterns, case-insensitively", () => {
    expect(compilePattern("nit:")?.("NIT: rename")).toBe(true);
    expect(compilePattern("/^typo/")?.("Typo here")).toBe(true);
    expect(compilePattern("/^typo/")?.("a typo")).toBe(false);
    expect(compilePattern("/[/")).toBeNull();
  });
});
