import { describe, expect, it } from "vitest";
import type { Turn, TurnItem } from "../../shared/turn";
import { dotKey, sameDots, scopeDots, youBadge } from "./sidebar-view";

function item(turn: Turn, o: Partial<TurnItem> = {}): TurnItem {
  return { ticketKey: "BTL-1", pr: null, featureId: null, turn, since: 1, others: 0, ...o };
}
const ask: Turn = { owner: "you", kind: "answer", question: "q", options: [], askId: 1, sessionId: "s" };
const merge: Turn = { owner: "you", kind: "merge", risk: null };
const agent: Turn = { owner: "agent", kind: "working", sessionId: "s" };
const ci: Turn = { owner: "external", kind: "ci_running", names: [] };

describe("scopeDots", () => {
  it("a ticket takes its most urgent item and counts your turns", () => {
    const dots = scopeDots([item(agent), item(ask)]);
    expect(dots.get(dotKey("ticket", "BTL-1"))).toEqual({ tone: "ask", you: 1 });
  });

  it("a feature sums the tickets under it", () => {
    const dots = scopeDots([
      item(merge, { ticketKey: "BTL-2", featureId: 3 }),
      item(ask, { ticketKey: "BTL-3", featureId: 3 }),
    ]);
    expect(dots.get(dotKey("feature", 3))).toEqual({ tone: "ask", you: 2 });
    expect(dots.get(dotKey("ticket", "BTL-2"))).toEqual({ tone: "merge", you: 1 });
  });

  it("merged and not-started items have no dot", () => {
    const dots = scopeDots([item({ owner: "done", kind: "merged" }), item({ owner: "idle", kind: "not_started" }, { ticketKey: "BTL-2" })]);
    expect(dots.size).toBe(0);
  });

  it("agent work is a blue dot with nothing for you", () => {
    expect(scopeDots([item(agent)]).get(dotKey("ticket", "BTL-1"))).toEqual({ tone: "agent", you: 0 });
    expect(scopeDots([item(ci)]).get(dotKey("ticket", "BTL-1"))).toEqual({ tone: "external", you: 0 });
  });

  it("items with no ticket count toward their feature only", () => {
    const dots = scopeDots([item(ask, { ticketKey: null, featureId: 2 })]);
    expect(dots.get(dotKey("feature", 2))).toEqual({ tone: "ask", you: 1 });
    expect([...dots.keys()]).toEqual([dotKey("feature", 2)]);
  });
});

describe("youBadge", () => {
  it("caps at 99+", () => {
    expect(youBadge(7)).toBe("7");
    expect(youBadge(99)).toBe("99");
    expect(youBadge(100)).toBe("99+");
  });
});

describe("sameDots (BTL-277)", () => {
  it("is true only for the same keys with the same tone and count", () => {
    const a = new Map([["feature:1", { tone: "ask" as const, you: 1 }]]);
    expect(sameDots(a, new Map([["feature:1", { tone: "ask" as const, you: 1 }]]))).toBe(true);
    expect(sameDots(a, new Map([["feature:1", { tone: "ask" as const, you: 2 }]]))).toBe(false);
    expect(sameDots(a, new Map([["feature:2", { tone: "ask" as const, you: 1 }]]))).toBe(false);
    expect(sameDots(a, new Map())).toBe(false);
  });
});
