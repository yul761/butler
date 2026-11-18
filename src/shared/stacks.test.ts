import { describe, expect, it } from "vitest";
import { STACK_POLICY_DEFAULTS, STACK_POLICY_KEYS, StackPolicyError, parseStackOverrides, sanitizeStackOverrides } from "./stacks";

describe("stack policy", () => {
  it("writes to local branches are off by default", () => {
    expect(STACK_POLICY_DEFAULTS.autoRebase).toBe(false);
    expect(STACK_POLICY_DEFAULTS.overview).toBe("off");
    expect([...STACK_POLICY_KEYS].sort()).toEqual(Object.keys(STACK_POLICY_DEFAULTS).sort());
  });

  it("accepts every key with a valid value", () => {
    const o = parseStackOverrides({
      autoRebase: true, mergeMethod: "squash", rebaseOnMainUpdate: false, dailyRebase: false, autosquash: false,
      autoOpenBottomPr: false, conflictToSession: false, draftDemoteDays: 7, behindCommits: 5, behindDays: 1, overview: "issue", draftLabel: " stack ",
    });
    expect(o.mergeMethod).toBe("squash");
    expect(o.draftLabel).toBe("stack");
    expect(o.autoRebase).toBe(true);
  });

  it.each([
    ["autoRebase", "yes", "bad_bool"],
    ["mergeMethod", "rebase", "bad_enum"],
    ["overview", "pinned", "bad_enum"],
    ["draftDemoteDays", 0, "bad_int"],
    ["behindCommits", 1.5, "bad_int"],
    ["behindDays", 366, "bad_int"],
    ["draftLabel", "a,b", "bad_label"],
    ["draftLabel", "", "bad_label"],
    ["nope", 1, "unknown_key"],
  ])("rejects %s=%j", (key, value, code) => {
    try {
      parseStackOverrides({ [key]: value });
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(StackPolicyError);
      expect((e as StackPolicyError).code).toBe(code);
    }
  });

  it("sanitize drops bad keys instead of throwing", () => {
    expect(sanitizeStackOverrides({ autoRebase: true, behindDays: -1, x: 1 })).toEqual({ autoRebase: true });
    expect(sanitizeStackOverrides("nope")).toEqual({});
  });
});
