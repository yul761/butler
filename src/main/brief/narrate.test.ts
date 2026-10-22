import { describe, expect, it } from "vitest";
import { EMPTY_BRIEF_CONTENT, type Brief, type NarrativeStatus } from "../../shared/brief";
import type { NarrativeSource } from "../gateway/types";
import { narrateBrief, type NarrateDeps } from "./narrate";

const brief = (kind: Brief["kind"] = "morning"): Brief => ({
  id: 5, kind, date: "2026-10-21", createdAt: 1, ...EMPTY_BRIEF_CONTENT, narrative: null, narrativeStatus: "off",
});
const SOURCE: NarrativeSource = { date: "2026-10-21", tickets: [], items: [], known: { tickets: [], repos: [], branches: [] } };

function deps(over: Partial<NarrateDeps> = {}) {
  const written: [number, string | null, NarrativeStatus][] = [];
  const d: NarrateDeps = {
    narrate: async () => ({ status: "ok", narrative: "先合并 PR。", auditId: 1 }),
    briefs: { setNarrative: (id, n, s) => void written.push([id, n, s]) },
    source: () => SOURCE,
    ...over,
  };
  return { d, written };
}

describe("narrateBrief", () => {
  it("writes the narrative onto the morning brief", async () => {
    const { d, written } = deps();
    expect(await narrateBrief(d, brief())).toBe("ok");
    expect(written).toEqual([[5, "先合并 PR。", "ok"]]);
  });

  it("records the reason and no text when the gateway did not produce one", async () => {
    const { d, written } = deps({ narrate: async () => ({ status: "blocked", narrative: null, auditId: 2 }) });
    expect(await narrateBrief(d, brief())).toBe("blocked");
    expect(written).toEqual([[5, null, "blocked"]]);
  });

  it("never throws: a failing source, gateway or write leaves the brief marked failed", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const a = deps({ source: boom });
    expect(await narrateBrief(a.d, brief())).toBe("failed");
    expect(a.written).toEqual([[5, null, "failed"]]);
    const b = deps({ narrate: async () => Promise.reject(new Error("boom")) });
    expect(await narrateBrief(b.d, brief())).toBe("failed");
    const c = deps({ briefs: { setNarrative: boom } });
    expect(await narrateBrief(c.d, brief())).toBe("failed");
  });

  it("survives a throwing logger", async () => {
    const log = () => {
      throw new Error("disk full");
    };
    const a = deps({ narrate: async () => Promise.reject(new Error("x")), log });
    expect(await narrateBrief(a.d, brief())).toBe("failed");
    const b = deps({ briefs: { setNarrative: () => { throw new Error("y"); } }, log });
    expect(await narrateBrief(b.d, brief())).toBe("failed");
  });

  it("passes the abort signal to the gateway", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const { d } = deps({ signal: ac.signal, narrate: async (_s, sig) => ((seen = sig), { status: "ok", narrative: "x", auditId: 1 }) });
    await narrateBrief(d, brief());
    expect(seen).toBe(ac.signal);
  });

  it("does not build the narrative source when the personal LLM is off, and records off", async () => {
    let built = 0;
    let sent = 0;
    const source = () => (built++, SOURCE);
    const narrate = async () => (sent++, { status: "ok" as const, narrative: "x", auditId: 1 });
    const off = deps({ off: () => true, source, narrate });
    expect(await narrateBrief(off.d, brief())).toBe("off");
    expect([built, sent]).toEqual([0, 0]);
    expect(off.written).toEqual([[5, null, "off"]]);
    const on = deps({ off: () => false, source, narrate });
    expect(await narrateBrief(on.d, brief())).toBe("ok");
    expect([built, sent]).toEqual([1, 1]);
  });

  it("marks the brief failed, without building the source, when the off check throws", async () => {
    let built = 0;
    const { d, written } = deps({ off: () => { throw new Error("db"); }, source: () => (built++, SOURCE) });
    expect(await narrateBrief(d, brief())).toBe("failed");
    expect(built).toBe(0);
    expect(written).toEqual([[5, null, "failed"]]);
  });

  it("leaves an evening summary alone", async () => {
    const { d, written } = deps();
    expect(await narrateBrief(d, brief("evening"))).toBe("off");
    expect(written).toEqual([]);
  });
});
