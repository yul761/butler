import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import { narrowestScope, parseTarget, recipients, resolveTargets, withinSource, type RecipientLookup, type SourceInfo, type TargetLookup } from "./targets";

const TICKETS: Record<string, number | null> = { "BTL-12": 4, "BTL-13": 4, "BTL-30": 5, "SOLO-1": null };
const EPICS: Record<string, number> = { "4": 4, "登录改版": 4, "5": 5, "导出": 5 };
const look: TargetLookup = {
  ticket: (k) => {
    const key = Object.keys(TICKETS).find((x) => x.toLowerCase() === k.trim().toLowerCase());
    return key ? { key, featureId: TICKETS[key] } : null;
  },
  epic: (s) => EPICS[s.trim()] ?? null,
};
const ticketSrc: SourceInfo = { ticketKey: "BTL-12", featureId: 4, shipherd: false };
const coordSrc: SourceInfo = { ticketKey: null, featureId: 4, shipherd: false };
const globalSrc: SourceInfo = { ticketKey: null, featureId: null, shipherd: true };

describe("parseTarget", () => {
  it.each([
    ["ticket:BTL-12", { kind: "ticket", key: "BTL-12" }],
    ["ticket: btl-12", { kind: "ticket", key: "BTL-12" }],
    ["BTL-30", { kind: "ticket", key: "BTL-30" }],
    ["epic:4", { kind: "epic", featureId: 4 }],
    ["epic:登录改版", { kind: "epic", featureId: 4 }],
    ["epic", { kind: "epic", featureId: 4 }],
    ["coordinator:5", { kind: "coordinator", featureId: 5 }],
    ["coordinator:global", { kind: "coordinator", featureId: null }],
    ["coordinator", { kind: "coordinator", featureId: 4 }],
    ["workspace", { kind: "workspace" }],
  ])("%s", (raw, want) => expect(parseTarget(raw, look, ticketSrc)).toEqual(want));

  it.each(["ticket:BTL-999", "epic:99", "coordinator:nope", "workspace:x", "everyone", "", "ticket:"])("drops %j", (raw) => {
    expect(parseTarget(raw, look, ticketSrc)).toBeNull();
  });

  it("a bare coordinator from the global coordinator means the global one", () => {
    expect(parseTarget("coordinator", look, globalSrc)).toEqual({ kind: "coordinator", featureId: null });
    expect(parseTarget("epic", look, globalSrc)).toBeNull();
  });
});

describe("resolveTargets", () => {
  it("dedupes and drops what doesn't exist", () => {
    expect(resolveTargets(["ticket:BTL-12", "btl-12", "ticket:NOPE-1", "coordinator:4"], look, ticketSrc)).toEqual([
      { kind: "ticket", key: "BTL-12" },
      { kind: "coordinator", featureId: 4 },
    ]);
  });

  it("falls back to the source's own scope when nothing resolves", () => {
    expect(resolveTargets(["made-up"], look, ticketSrc)).toEqual([{ kind: "ticket", key: "BTL-12" }]);
    expect(resolveTargets([], look, coordSrc)).toEqual([{ kind: "epic", featureId: 4 }]);
    expect(resolveTargets([], look, globalSrc)).toEqual([{ kind: "workspace" }]);
  });
});

describe("withinSource", () => {
  const epicOf = (k: string): number | null => TICKETS[k] ?? null;
  it("keeps only what is inside the source's scope", () => {
    expect(
      withinSource([{ kind: "workspace" }, { kind: "ticket", key: "BTL-13" }, { kind: "epic", featureId: 5 }, { kind: "coordinator", featureId: 4 }], ticketSrc, epicOf),
    ).toEqual([{ kind: "ticket", key: "BTL-13" }, { kind: "coordinator", featureId: 4 }]);
  });

  it("falls back to the source's own ticket or epic when nothing is inside; a workspace or global source drops it", () => {
    const outside = [{ kind: "workspace" as const }, { kind: "epic" as const, featureId: 5 }, { kind: "ticket" as const, key: "BTL-30" }, { kind: "coordinator" as const, featureId: null }];
    expect(withinSource(outside, ticketSrc, epicOf)).toEqual([{ kind: "ticket", key: "BTL-12" }]);
    expect(withinSource(outside, coordSrc, epicOf)).toEqual([{ kind: "epic", featureId: 4 }]);
    expect(withinSource(outside, globalSrc, epicOf)).toEqual([]);
    expect(withinSource(outside, { ticketKey: null, featureId: null, shipherd: false }, epicOf)).toEqual([]);
    // 不在 epic 里的 ticket 来源：落回它自己。
    expect(withinSource(outside, { ticketKey: "SOLO-1", featureId: null, shipherd: false }, epicOf)).toEqual([{ kind: "ticket", key: "SOLO-1" }]);
  });
});

describe("narrowestScope", () => {
  const epicOf = (k: string) => TICKETS[k] ?? null;
  it("one ticket → the ticket's memory", () => {
    expect(narrowestScope([{ kind: "ticket", key: "BTL-12" }], epicOf)).toBe("ticket:BTL-12");
  });
  it("several things in one epic → the epic's memory", () => {
    expect(narrowestScope([{ kind: "ticket", key: "BTL-12" }, { kind: "ticket", key: "BTL-13" }], epicOf)).toBe("feature:4");
    expect(narrowestScope([{ kind: "ticket", key: "BTL-12" }, { kind: "coordinator", featureId: 4 }], epicOf)).toBe("feature:4");
    expect(narrowestScope([{ kind: "epic", featureId: 4 }], epicOf)).toBe("feature:4");
  });
  it("across epics, the workspace, the global coordinator or a ticket without an epic → workspace", () => {
    expect(narrowestScope([{ kind: "ticket", key: "BTL-12" }, { kind: "ticket", key: "BTL-30" }], epicOf)).toBe("workspace");
    expect(narrowestScope([{ kind: "workspace" }], epicOf)).toBe("workspace");
    expect(narrowestScope([{ kind: "coordinator", featureId: null }], epicOf)).toBe("workspace");
    expect(narrowestScope([{ kind: "ticket", key: "SOLO-1" }, { kind: "epic", featureId: 4 }], epicOf)).toBe("workspace");
    expect(narrowestScope([], epicOf)).toBe("workspace");
  });
});

describe("recipients", () => {
  const s = (id: string, o: Partial<Session> = {}): Session => ({
    id, ticketKey: null, cwd: "/", origin: "shipherd", gitBranch: null, firstPrompt: null, lastActivityAt: 0, waitingForInput: false, replacedBy: null,
    dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, shipherd: false,
    lessonRunId: null, ...o,
  });
  const t12a = s("t12a", { ticketKey: "BTL-12", lastActivityAt: 10 });
  const t12b = s("t12b", { ticketKey: "BTL-12", lastActivityAt: 30 });
  const t13 = s("t13", { ticketKey: "BTL-13" });
  const c4 = s("c4", { featureId: 4 });
  const fix4 = s("fix4", { featureId: 4, fixesSession: "t13" });
  const c5 = s("c5", { featureId: 5 });
  const g = s("g", { shipherd: true });
  const mk = (live: string[]): RecipientLookup => ({
    ticketHeads: (k) => [t12a, t12b, t13].filter((x) => x.ticketKey === k),
    epicHeads: (f) => (f === 4 ? [c4, fix4, t12a, t12b, t13] : [c5]),
    coordinator: (f) => (f === 4 ? c4 : f === 5 ? c5 : null),
    shipherd: () => g,
    coordinators: () => [c4, c5],
    live: (id) => live.includes(id),
  });

  it("never sends to the session that said it", () => {
    expect(recipients([{ kind: "ticket", key: "BTL-12" }, { kind: "coordinator", featureId: 4 }], mk(["t12a", "t12b", "c4"]), "c4")).toEqual(["t12a", "t12b"]);
  });

  it("a ticket with nothing open queues for its most recent session", () => {
    expect(recipients([{ kind: "ticket", key: "BTL-12" }], mk([]), "c4")).toEqual(["t12b"]);
  });

  it("an epic only reaches sessions that are open or hibernated", () => {
    expect(recipients([{ kind: "epic", featureId: 4 }], mk(["t13", "fix4"]), "t12a")).toEqual(["fix4", "t13"]);
  });

  it("a coordinator gets it even when closed; the workspace reaches the global and live epic coordinators", () => {
    expect(recipients([{ kind: "coordinator", featureId: 5 }], mk([]), "t12a")).toEqual(["c5"]);
    expect(recipients([{ kind: "workspace" }], mk(["c5"]), "t12a")).toEqual(["g", "c5"]);
    expect(recipients([{ kind: "coordinator", featureId: null }], mk([]), "g")).toEqual([]);
  });

  it("does not list a session twice", () => {
    expect(recipients([{ kind: "ticket", key: "BTL-13" }, { kind: "epic", featureId: 4 }], mk(["t13"]), "c4")).toEqual(["t13"]);
  });
});
