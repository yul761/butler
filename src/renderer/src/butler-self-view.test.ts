import { describe, expect, it } from "vitest";
import { auditIsEmpty, EFFECT_TABS } from "./butler-self-view";

describe("auditIsEmpty", () => {
  it("is true only when there is no outward action on record", () => {
    expect(auditIsEmpty(0)).toBe(true);
    expect(auditIsEmpty(2)).toBe(false);
  });
});

describe("EFFECT_TABS", () => {
  it("lists the five tabs in order", () => {
    expect([...EFFECT_TABS]).toEqual(["overview", "trend", "spend", "rework", "automation"]);
  });
});
