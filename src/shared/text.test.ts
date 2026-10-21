import { describe, expect, it } from "vitest";
import { sanitizePrefill, stripControl } from "./text";

describe("stripControl", () => {
  it("removes C0, DEL and C1 control characters but keeps normal text", () => {
    expect(stripControl("a\u0000b\u001b[31mc\u007fd\u009be")).toBe("ab[31mcde");
    expect(stripControl("张 三.txt")).toBe("张 三.txt");
  });
});

describe("sanitizePrefill", () => {
  it("turns newlines and tabs into single spaces so the text is never submitted", () => {
    expect(sanitizePrefill("继续 follow-up：\n改 staging config\r\n\t（来自 PROJ-56）")).toBe("继续 follow-up： 改 staging config （来自 PROJ-56）");
  });

  it("drops escape sequences, trims and caps the length", () => {
    expect(sanitizePrefill("  \u001b[2Jhi\u0003  ")).toBe("[2Jhi");
    expect(sanitizePrefill("x".repeat(600))).toHaveLength(500);
  });

  it("never cuts inside a surrogate pair at the limit", () => {
    const out = sanitizePrefill("x".repeat(499) + "😀");
    expect(out).toBe("x".repeat(499));
    expect(out).not.toMatch(/[\ud800-\udfff]/);
  });

  it("does not leave a trailing space when the cut lands on one", () => {
    expect(sanitizePrefill("x".repeat(499) + " y")).toBe("x".repeat(499));
  });

  it("keeps emoji in the middle of the text", () => {
    expect(sanitizePrefill("继续 😀 做 PROJ-1")).toBe("继续 😀 做 PROJ-1");
  });
});
