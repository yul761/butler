import { describe, expect, it } from "vitest";
import type { LoopPolicyView } from "../../shared/loop-policy";
import { canCategorize, commentActions, commentSnippet, commentWhere, loopGroups, loopInputValue, loopOverridesFromDraft, parseLoopInput } from "./loop-view";

const view = (overrides: Record<string, unknown>): LoopPolicyView => ({
  scope: { kind: "global" },
  conflicts: [],
  keys: (["comments.enabled", "comments.maxPerDelivery", "comments.copilot", "ci.envPatterns"] as const).map((key) => ({
    key, effective: overrides[key] ?? null, origin: { kind: "default" }, override: (overrides[key] ?? null) as never,
  })) as unknown as LoopPolicyView["keys"],
});

describe("loop policy editor", () => {
  it("parses each kind of input", () => {
    expect(parseLoopInput("comments.enabled", "true")).toBe(true);
    expect(parseLoopInput("comments.enabled", "")).toBeNull();
    expect(parseLoopInput("comments.maxPerDelivery", "5")).toBe(5);
    expect(parseLoopInput("comments.maxPerDelivery", "99")).toBeUndefined();
    expect(parseLoopInput("comments.copilot", "review")).toBe("review");
    expect(parseLoopInput("comments.copilot", "nah")).toBeUndefined();
    expect(parseLoopInput("ci.envPatterns", "rate limit\n\n /ECONN\\w+/ \nrate limit")).toEqual(["rate limit", "/ECONN\\w+/"]);
    expect(parseLoopInput("ci.envPatterns", "\n  \n")).toBeNull();
    expect(parseLoopInput("ci.envPatterns", "/(/")).toBeUndefined();
    expect(parseLoopInput("nope", "1")).toBeUndefined();
    expect(loopInputValue(["a", "b"])).toBe("a\nb");
    expect(loopInputValue(null)).toBe("");
  });

  it("builds the whole layer from overrides and the draft", () => {
    const v = view({ "comments.enabled": true, "ci.envPatterns": ["x"] });
    expect(loopOverridesFromDraft(v, {})).toEqual({ ok: true, overrides: { "comments.enabled": true, "ci.envPatterns": ["x"] }, changed: false });
    expect(loopOverridesFromDraft(v, { "ci.envPatterns": "x" })).toMatchObject({ ok: true, changed: false });
    expect(loopOverridesFromDraft(v, { "comments.enabled": "", "comments.maxPerDelivery": "3" })).toEqual({ ok: true, overrides: { "comments.maxPerDelivery": 3, "ci.envPatterns": ["x"] }, changed: true });
    expect(loopOverridesFromDraft(v, { "comments.maxPerDelivery": "abc" })).toEqual({ ok: false, badKey: "comments.maxPerDelivery" });
  });

  it("groups comment keys before CI keys", () => {
    expect(loopGroups(view({})).map((g) => [g.group, g.keys.length])).toEqual([["comments", 3], ["ci", 1]]);
  });
});

describe("comment rows", () => {
  it("shows where a comment is", () => {
    expect(commentWhere({ path: "a.ts", line: 3 }, "PR")).toBe("a.ts:3");
    expect(commentWhere({ path: "a.ts", line: null }, "PR")).toBe("a.ts");
    expect(commentWhere({ path: null, line: null }, "PR")).toBe("PR");
  });

  it("offers the actions that make sense in each state", () => {
    expect(commentActions({ state: "review", repliedAt: null })).toEqual(["send", "dismiss"]);
    expect(commentActions({ state: "queued", repliedAt: null })).toEqual(["dismiss"]);
    expect(commentActions({ state: "dismissed", repliedAt: null })).toEqual(["send"]);
    expect(commentActions({ state: "delivered", repliedAt: null })).toEqual([]);
    expect(commentActions({ state: "addressed", repliedAt: null })).toEqual(["reply"]);
    expect(commentActions({ state: "addressed", repliedAt: 5 })).toEqual([]);
    expect(commentActions({ state: "closed", repliedAt: null })).toEqual([]);
    expect(canCategorize({ state: "review" })).toBe(true);
    expect(canCategorize({ state: "delivered" })).toBe(false);
  });

  it("takes the first non-empty line, shortened", () => {
    expect(commentSnippet("\n  hello\nworld")).toBe("hello");
    expect(commentSnippet("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
