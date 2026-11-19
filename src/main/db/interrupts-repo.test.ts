import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { AutoChoicesRepo, ChoiceDefaultsRepo, NotificationLogRepo, PermissionProfileRepo } from "./interrupts-repo";

describe("PermissionProfileRepo", () => {
  it("stores one decision per repository and rule, and returns confirmed rules for several repositories", () => {
    const r = new PermissionProfileRepo(memDb());
    r.set({ slug: "acme/app", rule: "Bash(gh pr view:*)", status: "confirmed", source: "history", runs: 5, sessions: 2, at: 10 });
    r.set({ slug: "acme/app", rule: "Bash(gh run list:*)", status: "dismissed", source: "history", at: 11 });
    r.set({ slug: "acme/lib", rule: "Bash(gh pr list:*)", status: "confirmed", source: "manual", at: 12 });
    r.set({ slug: "acme/lib", rule: "Bash(gh pr view:*)", status: "confirmed", source: "manual", at: 13 });
    expect(r.confirmed(["acme/app", "acme/lib"])).toEqual(["Bash(gh pr list:*)", "Bash(gh pr view:*)"]);
    expect(r.confirmed([])).toEqual([]);
    expect(r.firstConfirmedAt()).toBe(10);
    r.set({ slug: "acme/app", rule: "Bash(gh pr view:*)", status: "dismissed", source: "history", at: 20 });
    expect(r.confirmed(["acme/app"])).toEqual([]);
    expect(r.get("acme/app", "Bash(gh pr view:*)")).toMatchObject({ status: "dismissed", decidedAt: 20 });
    expect(r.remove("acme/lib", "Bash(gh pr list:*)")).toBe(true);
    expect(r.bySlug("acme/lib").map((x) => x.rule)).toEqual(["Bash(gh pr view:*)"]);
  });
});

describe("AutoChoicesRepo", () => {
  it("lists newest first and marks reviewed one by one or all at once", () => {
    const r = new AutoChoicesRepo(memDb());
    const a = r.add({ source: "rule", sessionId: "s1", ticketKey: "T-1", text: "picked A", at: 1 });
    r.add({ source: "default", sessionId: "s2", ticketKey: null, decisionId: 4, defaultId: 1, text: "x".repeat(5000), at: 2 });
    expect(r.list().map((c) => c.source)).toEqual(["default", "rule"]);
    expect(r.list()[0]!.text).toHaveLength(4000);
    expect(r.unreviewed()).toBe(2);
    expect(r.review([a], 5)).toBe(1);
    expect(r.unreviewed()).toBe(1);
    expect(r.review(null, 6)).toBe(1);
    expect(r.unreviewed()).toBe(0);
  });
});

describe("ChoiceDefaultsRepo", () => {
  it("creates, updates and deletes defaults", () => {
    const r = new ChoiceDefaultsRepo(memDb());
    const id = r.save({ id: null, pattern: "branch|分支", answer: "", enabled: true, at: 1 });
    r.save({ id, pattern: "branch", answer: "rebase", enabled: false, at: 2 });
    expect(r.list()).toEqual([{ id, pattern: "branch", answer: "rebase", enabled: false, createdAt: 1 }]);
    expect(r.delete(id)).toBe(true);
    expect(r.list()).toEqual([]);
  });
});

describe("NotificationLogRepo", () => {
  it("keeps the newest first and prunes old rows", () => {
    const r = new NotificationLogRepo(memDb());
    r.insert({ ts: 1, event: "decision_needed", count: 2, status: "sent", host: "ntfy.example", payload: "Butler: 2", error: null });
    r.insert({ ts: 5, event: "cost_breaker", count: 1, status: "quiet", host: null, payload: null, error: null });
    expect(r.recent().map((e) => e.event)).toEqual(["cost_breaker", "decision_needed"]);
    expect(r.prune(3)).toBe(1);
    expect(r.recent()).toHaveLength(1);
  });
});
