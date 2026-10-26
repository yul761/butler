import { describe, expect, it } from "vitest";
import { renderBranch, titleSlug } from "./branch";

describe("titleSlug", () => {
  it("lowercases and joins words with -", () => {
    expect(titleSlug("Add Payment API!")).toBe("add-payment-api");
    expect(titleSlug("  fix: login -- page  ")).toBe("fix-login-page");
  });
  it("is empty for titles with no ASCII letters or digits, and for no title", () => {
    expect(titleSlug("结账改版")).toBe("");
    expect(titleSlug(null)).toBe("");
    expect(titleSlug("")).toBe("");
  });
  it("keeps at most 50 characters and never ends with -", () => {
    const s = titleSlug(`${"a".repeat(49)} bcdef`);
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s.endsWith("-")).toBe(false);
    expect(titleSlug("x".repeat(60))).toHaveLength(50);
  });
});

describe("renderBranch", () => {
  it("fills {key}, {key_lower} and {title}", () => {
    expect(renderBranch("{key_lower}-{title}", "DMS-1234", "Add payment API")).toBe("dms-1234-add-payment-api");
    expect(renderBranch("feature/{key}", "A-1")).toBe("feature/A-1");
    expect(renderBranch("{key}/{title}", "A-1", "x y")).toBe("A-1/x-y");
  });
  it("drops the separators an empty title leaves behind", () => {
    expect(renderBranch("{key_lower}-{title}", "DMS-1234", "")).toBe("dms-1234");
    expect(renderBranch("{key_lower}-{title}", "DMS-1234", "结账")).toBe("dms-1234");
    expect(renderBranch("feature/{title}/{key}", "A-1", "")).toBe("feature/A-1");
    expect(renderBranch("{title}-{key}", "A-1", null)).toBe("A-1");
  });
});
