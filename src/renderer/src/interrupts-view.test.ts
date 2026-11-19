import { describe, expect, it } from "vitest";
import type { ProfileCandidate } from "../../shared/interrupts";
import { defaultPicks, eventsOf, groupCandidates, quietValid, toggleEvent } from "./interrupts-view";

const c = (slug: string, rule: string, caution = false): ProfileCandidate => ({ slug, rule, runs: 3, sessions: 2, example: rule, why: null, caution });

describe("interrupts view (ws-j)", () => {
  it("groups candidates by repository, keeping order", () => {
    const g = groupCandidates([c("a/x", "Bash(gh pr view:*)"), c("b/y", "Read"), c("a/x", "Grep")]);
    expect(g.map((x) => [x.slug, x.items.map((i) => i.rule)])).toEqual([["a/x", ["Bash(gh pr view:*)", "Grep"]], ["b/y", ["Read"]]]);
  });

  it("pre-checks Bash candidates the model did not flag, never MCP tools", () => {
    expect([...defaultPicks([c("a/x", "Bash(gh pr view:*)"), c("a/x", "Bash(jq:*)", true), c("a/x", "mcp__wiki__list_pages")])]).toEqual(["a/x\nBash(gh pr view:*)"]);
  });

  it("toggles events in a fixed order and drops unknown ones", () => {
    expect(eventsOf("pr_ready, bogus,decision_needed")).toEqual(["decision_needed", "pr_ready"]);
    expect(toggleEvent("pr_ready", "decision_needed", true)).toBe("decision_needed,pr_ready");
    expect(toggleEvent("decision_needed,pr_ready", "pr_ready", false)).toBe("decision_needed");
    expect(toggleEvent("", "cost_breaker", false)).toBe("");
  });

  it("accepts empty or HH:MM-HH:MM quiet hours only", () => {
    for (const ok of ["", " ", "22:00-08:00", "9:30-17:00"]) expect(quietValid(ok)).toBe(true);
    for (const bad of ["22-08", "25:00-08:00", "10:00-10:00", "10:00", "aa:bb-cc:dd"]) expect(quietValid(bad)).toBe(false);
  });
});
