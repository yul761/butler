import { describe, expect, it } from "vitest";
import { ticketGlance, type GlanceDeps } from "./ticket-glance";

const head = (id: string, fixesSession: string | null = null) => ({ id, fixesSession });

function deps(over: Partial<GlanceDeps> = {}): GlanceDeps {
  return {
    headsOf: () => [],
    rootOf: (id) => id,
    lastReplyOf: () => null,
    contextOf: () => null,
    threshold: () => 150000,
    ...over,
  };
}

describe("ticketGlance", () => {
  it("no sessions: everything is null", () => {
    expect(ticketGlance("T-1", deps())).toEqual({ rootSessionId: null, lastSaid: null, context: null });
  });

  it("lastSaid is the first head that has a reply", () => {
    const g = ticketGlance("T-1", deps({
      headsOf: () => [head("a"), head("b")],
      lastReplyOf: (id) => (id === "b" ? { id: "b", text: "done", at: 5 } : null),
    }));
    expect(g.lastSaid).toEqual({ text: "done", at: 5 });
  });

  it("context pairs the main session's tokens with the threshold", () => {
    const g = ticketGlance("T-1", deps({ headsOf: () => [head("a")], contextOf: (id) => (id === "a" ? 148000 : null) }));
    expect(g.context).toEqual({ tokens: 148000, threshold: 150000 });
  });

  it("context is null without usage, and kept when the threshold is 0", () => {
    expect(ticketGlance("T-1", deps({ headsOf: () => [head("a")] })).context).toBeNull();
    const g = ticketGlance("T-1", deps({ headsOf: () => [head("a")], contextOf: () => 10, threshold: () => 0 }));
    expect(g.context).toEqual({ tokens: 10, threshold: 0 });
  });

  it("rootSessionId is the chain root, not the head", () => {
    const g = ticketGlance("T-1", deps({ headsOf: () => [head("h3")], rootOf: (id) => (id === "h3" ? "r1" : id) }));
    expect(g.rootSessionId).toBe("r1");
  });

  it("the main session skips fix sessions listed first, but lastSaid counts them", () => {
    const ctx: string[] = [];
    const g = ticketGlance("T-1", deps({
      headsOf: () => [head("fix", "x"), head("main")],
      lastReplyOf: (id) => (id === "fix" ? { id, text: "fixed", at: null } : null),
      contextOf: (id) => (ctx.push(id), 1),
      rootOf: (id) => `root-${id}`,
    }));
    expect(g.rootSessionId).toBe("root-main");
    expect(ctx).toEqual(["main"]);
    expect(g.lastSaid).toEqual({ text: "fixed", at: null });
  });

  it("falls back to the first head when all are fix sessions", () => {
    const g = ticketGlance("T-1", deps({ headsOf: () => [head("f1", "x"), head("f2", "y")] }));
    expect(g.rootSessionId).toBe("f1");
  });
});
