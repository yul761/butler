import { describe, expect, it } from "vitest";
import { AutoChoicesRepo, ChoiceDefaultsRepo } from "../db/interrupts-repo";
import { memDb } from "../test-utils";
import { ChoiceService, patternMatches } from "./choices";

function setup(enabled = "1") {
  const db = memDb();
  return new ChoiceService({ choices: new AutoChoicesRepo(db), defaults: new ChoiceDefaultsRepo(db), setting: () => enabled, now: () => 9, markEffective: () => {} });
}

describe("ChoiceService", () => {
  it("matches keywords case-insensitively and ignores blank ones", () => {
    expect(patternMatches("Rebase | 分支", "要不要 REBASE？")).toBe(true);
    expect(patternMatches("分支", "先切分支吗")).toBe(true);
    expect(patternMatches(" | ", "anything")).toBe(false);
    expect(patternMatches("merge", "rebase?")).toBe(false);
  });

  it("uses the first enabled default that matches, with its literal answer or the recommended option", () => {
    const c = setup();
    c.saveDefault({ id: null, pattern: "rebase", answer: "", enabled: false });
    c.saveDefault({ id: null, pattern: "rebase", answer: " Merge ", enabled: true });
    const [off, lit] = c.defaults();
    expect(c.match({ question: "rebase?", options: ["Rebase", "Merge"], recommended: 0 })).toEqual({ answer: "Merge", defaultId: lit!.id });
    c.saveDefault({ ...off!, enabled: true });
    expect(c.match({ question: "rebase?", options: ["Rebase", "Merge"], recommended: 0 })).toEqual({ answer: "Rebase", defaultId: off!.id });
    expect(c.match({ question: "rebase?", options: ["Only"] })).toBeNull();
    expect(setup("0").match({ question: "rebase?", options: ["Rebase", "Merge"], recommended: 0 })).toBeNull();
  });

  it("refuses empty or over-long patterns and answers", () => {
    const c = setup();
    expect(() => c.saveDefault({ id: null, pattern: " ", answer: "", enabled: true })).toThrow();
    expect(() => c.saveDefault({ id: null, pattern: "|", answer: "", enabled: true })).toThrow();
    expect(() => c.saveDefault({ id: null, pattern: "x".repeat(201), answer: "", enabled: true })).toThrow();
    expect(() => c.saveDefault({ id: null, pattern: "x", answer: "y".repeat(501), enabled: true })).toThrow();
    expect(c.defaults()).toEqual([]);
    const [d] = c.saveDefault({ id: null, pattern: "x", answer: "", enabled: true });
    expect(c.deleteDefault(d!.id)).toEqual([]);
  });

  it("records rule and default choices for review", () => {
    const c = setup();
    c.recordRule({ sessionId: "s1", ticketKey: null }, "picked A");
    c.recordDefault({ sessionId: "s2", ticketKey: "T-1" }, 3, 1, "Which?", "B");
    expect(c.unreviewed()).toBe(2);
    expect(c.list().map((x) => x.source)).toEqual(["default", "rule"]);
    expect(c.list()[0]!.text).toContain("B");
    expect(c.review(null)).toBe(2);
    expect(c.unreviewed()).toBe(0);
  });
});
