import { describe, expect, it } from "vitest";
import type { Turn, TurnItem } from "../../shared/turn";
import { dotKey, scopeDots, youBadge } from "./sidebar-view";

function item(turn: Turn, o: Partial<TurnItem> = {}): TurnItem {
  return { ticketKey: "BTL-1", pr: null, epicId: null, featureId: null, turn, since: 1, others: 0, ...o };
}
const ask: Turn = { owner: "you", kind: "answer", question: "q", options: [], askId: 1, sessionId: "s" };
const merge: Turn = { owner: "you", kind: "merge", risk: null };
const agent: Turn = { owner: "agent", kind: "working", sessionId: "s" };
const ci: Turn = { owner: "external", kind: "ci_running", names: [] };

describe("scopeDots", () => {
  it("a ticket takes its most urgent item and counts your turns", () => {
    const dots = scopeDots([item(agent), item(ask)], new Map());
    expect(dots.get(dotKey("ticket", "BTL-1"))).toEqual({ tone: "ask", you: 1 });
  });

  it("a feature and its epic sum the tickets under them", () => {
    const fe = new Map<number, number | null>([[3, 9]]);
    const dots = scopeDots([
      item(merge, { ticketKey: "BTL-2", featureId: 3, epicId: 9 }),
      item(ask, { ticketKey: "BTL-3", featureId: 3, epicId: null }),
    ], fe);
    expect(dots.get(dotKey("feature", 3))).toEqual({ tone: "ask", you: 2 });
    expect(dots.get(dotKey("epic", 9))).toEqual({ tone: "ask", you: 2 });
    expect(dots.get(dotKey("ticket", "BTL-2"))).toEqual({ tone: "merge", you: 1 });
  });

  it("merged and not-started items have no dot", () => {
    const dots = scopeDots([item({ owner: "done", kind: "merged" }), item({ owner: "idle", kind: "not_started" }, { ticketKey: "BTL-2" })], new Map());
    expect(dots.size).toBe(0);
  });

  it("agent work is a blue dot with nothing for you", () => {
    expect(scopeDots([item(agent)], new Map()).get(dotKey("ticket", "BTL-1"))).toEqual({ tone: "agent", you: 0 });
    expect(scopeDots([item(ci)], new Map()).get(dotKey("ticket", "BTL-1"))).toEqual({ tone: "external", you: 0 });
  });

  it("items with no ticket count toward their feature or epic only", () => {
    const dots = scopeDots([item(ask, { ticketKey: null, epicId: 2 })], new Map());
    expect(dots.get(dotKey("epic", 2))).toEqual({ tone: "ask", you: 1 });
    expect([...dots.keys()]).toEqual([dotKey("epic", 2)]);
  });
});

describe("youBadge", () => {
  it("caps at 99+", () => {
    expect(youBadge(7)).toBe("7");
    expect(youBadge(99)).toBe("99");
    expect(youBadge(100)).toBe("99+");
  });
});
