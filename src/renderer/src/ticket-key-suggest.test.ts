import { describe, expect, it } from "vitest";
import { isValidTicketKey, suggestNextKey } from "./ticket-key-suggest";
import { S, setUiLang } from "./strings";

const at = (...keys: string[]) => keys.map((key, i) => ({ key, createdAt: i }));

describe("suggestNextKey (BTL-264)", () => {
  it("suggests the number after the highest one in the epic", () => {
    expect(suggestNextKey(at("BTL-262", "BTL-264", "BTL-263"), [])).toBe("BTL-265");
  });

  it("uses the prefix of the most recently created ticket when an epic mixes prefixes", () => {
    expect(suggestNextKey(at("REMI-9", "BTL-264", "REMI-3"), [])).toBe("REMI-10");
    expect(suggestNextKey([{ key: "BTL-264", createdAt: 5 }, { key: "REMI-3", createdAt: 1 }], [])).toBe("BTL-265");
  });

  it("skips numbers already used elsewhere, archived ones included, but not past the epic's own highest", () => {
    expect(suggestNextKey(at("BTL-264"), ["BTL-265", "btl-266", "BTL-300"])).toBe("BTL-267");
  });

  it("keeps zero padding", () => {
    expect(suggestNextKey(at("PROJ-007"), [])).toBe("PROJ-008");
    expect(suggestNextKey(at("PROJ-099"), [])).toBe("PROJ-100");
  });

  it("suggests nothing without a PREFIX-NUMBER ticket, or when the suggestion breaks the configured format", () => {
    expect(suggestNextKey([], [])).toBeNull();
    expect(suggestNextKey(at("misc"), [])).toBeNull();
    expect(suggestNextKey(at("BTL-264"), [], "ACME-\\d+")).toBeNull();
    expect(suggestNextKey(at("ACME-4"), [], "ACME-\\d+")).toBe("ACME-5");
  });
});

describe("isValidTicketKey in the dialog", () => {
  it("checks the default PREFIX-NUMBER format and a custom one, and lets a broken custom pattern through to the main process", () => {
    expect(isValidTicketKey("BTL-265")).toBe(true);
    for (const bad of ["BTL265", "B-1", "1BT-2", "BTL-", "BTL-12a"]) expect(isValidTicketKey(bad)).toBe(false);
    expect(isValidTicketKey("T42", "T\\d+")).toBe(true);
    expect(isValidTicketKey("anything", "([")).toBe(true);
  });
});

describe("ticket id hint and format error copy", () => {
  it("says the format, the example, and where the filled-in number came from, in both languages", () => {
    setUiLang("zh");
    expect(S.ticketKeyHint("BTL-265", "feature", null)).toContain("前缀-数字");
    expect(S.ticketKeyHint("BTL-265", "feature", null)).toContain("BTL-265");
    expect(S.ticketKeyHint("BTL-265", "feature", null)).toContain("这个 epic");
    expect(S.ticketKeyFormatError("btl265", "BTL-265", null)).toMatch(/「btl265」.*前缀-数字.*BTL-265/);
    expect(S.ticketKeyFormatError("x", "PROJ-123", "T\\d+")).toContain("T\\d+");
    setUiLang("en");
    expect(S.ticketKeyHint("BTL-265", "all", null)).toMatch(/PREFIX-NUMBER.*BTL-265.*existing tickets/);
    expect(S.ticketKeyHint("PROJ-123", null, null)).not.toMatch(/filled in/);
    expect(S.ticketKeyFormatError("btl265", "BTL-265", null)).toMatch(/“btl265”.*PREFIX-NUMBER.*BTL-265/);
    setUiLang("zh");
  });
});
