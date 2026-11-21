import { describe, expect, it } from "vitest";
import { auditIsEmpty, EFFECT_TABS } from "./butler-self-view";

describe("auditIsEmpty", () => {
  it("is true only when both counts are 0", () => {
    expect(auditIsEmpty({ llmEntries: 0, externalEntries: 0 })).toBe(true);
    expect(auditIsEmpty({ llmEntries: 1, externalEntries: 0 })).toBe(false);
    expect(auditIsEmpty({ llmEntries: 0, externalEntries: 2 })).toBe(false);
  });
});

describe("EFFECT_TABS", () => {
  it("lists the five tabs in order", () => {
    expect([...EFFECT_TABS]).toEqual(["overview", "trend", "spend", "rework", "automation"]);
  });
});
