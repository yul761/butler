import { describe, expect, it } from "vitest";
import { TERMS_LIMIT } from "../settings/settings-values";
import { apiKeyArg, auditCursorArg, termsArg, TERMS_INPUT_LIMIT } from "./validate";

describe("IPC argument validation", () => {
  it("accepts only a string of bounded length as an API key", () => {
    expect(apiKeyArg("sk-0123456789")).toBe("sk-0123456789");
    for (const bad of [undefined, null, 42, ["sk-0123456789"], { key: "sk-0123456789" }, "x".repeat(5000)]) {
      expect(() => apiKeyArg(bad)).toThrow(expect.objectContaining({ code: "invalid_setting" }));
    }
  });

  it("does not echo the rejected key in the error", () => {
    try {
      apiKeyArg(`sk-${"y".repeat(5000)}`);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("yyyy");
    }
  });

  it("accepts a bounded array of terms and normalizes it", () => {
    expect(termsArg([{ term: "  Ｐｈｏｅｎｉｘ ", category: "term" }, { term: "phoenix", category: "term" }, { term: "Alice Wang", category: "person" }])).toEqual([
      { term: "Phoenix", category: "term" },
      { term: "Alice Wang", category: "person" },
    ]);
    expect(termsArg([])).toEqual([]);
  });

  it("rejects terms of the wrong shape, too many entries or oversized strings before normalizing", () => {
    const ok = { term: "Phoenix", category: "term" };
    for (const bad of [
      undefined, null, "Phoenix", { 0: ok, length: 1 },
      [null], ["Phoenix"], [{ term: 1, category: "term" }], [{ term: "Phoenix", category: "secret" }], [{ term: "Phoenix" }],
      Array.from({ length: TERMS_INPUT_LIMIT + 1 }, () => ok),
      [{ term: "x".repeat(10_000), category: "term" }],
    ]) {
      expect(() => termsArg(bad)).toThrow(expect.objectContaining({ code: "invalid_setting" }));
    }
    expect(TERMS_INPUT_LIMIT).toBeGreaterThanOrEqual(TERMS_LIMIT);
  });

  it("accepts no cursor or a positive integer audit cursor", () => {
    expect(auditCursorArg(undefined)).toBeUndefined();
    expect(auditCursorArg(null)).toBeUndefined();
    expect(auditCursorArg(1)).toBe(1);
    expect(auditCursorArg(12345)).toBe(12345);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, "12", [12], { id: 12 }, true]) {
      expect(() => auditCursorArg(bad)).toThrow();
    }
  });
});
