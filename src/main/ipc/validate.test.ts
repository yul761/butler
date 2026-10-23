import { describe, expect, it } from "vitest";
import { TERMS_LIMIT } from "../settings/settings-values";
import { apiKeyArg, boolArg, auditCursorArg, addRepoArg, clipboardTextArg, factIdArg, repoIdArg, sessionIdArg, termsArg, ticketKeyArg, TERMS_INPUT_LIMIT, updateRepoArg, updateTicketArg } from "./validate";

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

describe("memory IPC arguments", () => {
  it("accepts a ticket key and a StateCore fact id, nothing else", () => {
    expect(ticketKeyArg("PROJ-12")).toBe("PROJ-12");
    expect(factIdArg("0e133fce-6f5f-40b6-9905-4119541d9a7e")).toBe("0e133fce-6f5f-40b6-9905-4119541d9a7e");
    for (const bad of [undefined, null, 1, "", "x".repeat(201), {}]) expect(() => ticketKeyArg(bad), String(bad)).toThrow();
    for (const bad of [undefined, "", "a b", "../x", "x".repeat(101), 5]) expect(() => factIdArg(bad), String(bad)).toThrow();
  });

  it("accepts only a boolean for on/off switches", () => {
    expect(boolArg(true)).toBe(true);
    expect(boolArg(false)).toBe(false);
    for (const bad of ["true", 1, null, undefined]) expect(() => boolArg(bad)).toThrow();
  });
});

describe("ticket edit and clipboard IPC arguments", () => {
  it("accepts a title update, a new repo and a repo update, and rejects anything else", () => {
    expect(updateTicketArg({ key: "P-1", title: "t", extra: 1 })).toEqual({ key: "P-1", title: "t" });
    for (const bad of [null, "P-1", { key: "" }, { key: "P-1" }, { key: "P-1", title: 3 }, { key: "P-1", title: "x".repeat(501) }]) {
      expect(() => updateTicketArg(bad)).toThrow();
    }
    expect(addRepoArg({ ticketKey: "P-1", repoPath: "/r", workMode: "branch" })).toEqual({ ticketKey: "P-1", repoPath: "/r", workMode: "branch", branch: undefined });
    for (const bad of [{ ticketKey: "P-1", repoPath: "", workMode: "branch" }, { ticketKey: "P-1", repoPath: "/r" }, { ticketKey: "P-1", repoPath: "/r", workMode: "x" }]) {
      expect(() => addRepoArg(bad)).toThrow();
    }
    expect(updateRepoArg({ repoId: 3, branch: "b" })).toEqual({ repoId: 3, branch: "b", workMode: undefined });
    for (const bad of [{ repoId: 0 }, { repoId: 1.5 }, { repoId: "1" }, { repoId: 1, workMode: "x" }, { repoId: 1, branch: "x".repeat(251) }]) {
      expect(() => updateRepoArg(bad)).toThrow();
    }
    expect(repoIdArg(7)).toBe(7);
    expect(() => repoIdArg(-1)).toThrow();
  });

  it("accepts only a bounded string for the clipboard", () => {
    expect(clipboardTextArg("hi")).toBe("hi");
    expect(() => clipboardTextArg(3)).toThrow();
    expect(() => clipboardTextArg("x".repeat(1024 * 1024 + 1))).toThrow();
  });
});

describe("session id argument", () => {
  it("accepts ids made of letters, digits and dashes only", () => {
    expect(sessionIdArg("1125e68e-5407-4868-9ca8-5a306155f393")).toBe("1125e68e-5407-4868-9ca8-5a306155f393");
    for (const bad of ["", "../x", "a b", 3, null, "x".repeat(101)]) expect(() => sessionIdArg(bad)).toThrow();
  });
});
