import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import { featureOwns, isControllerOf } from "./controller";

const s = (o: Partial<Session> & { id: string }): Session => ({
  ticketKey: null, cwd: "/w", origin: "shipherd", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, shipherd: false,
  lessonRunId: null, ...o,
});
/** epic -> 没归档的 ticket（listByFeature）。A-OLD 归档了，不在列表里；epic 3 归档了。 */
const own: Record<number, string[]> = { 1: ["A-1"], 2: ["B-1"] };
const keys = (f: number): Set<string> | null => (own[f] ? new Set(own[f]) : null);

/** featureSend 和 end/refresh 的收件人用例：isControllerOf 对 epic 总控必须给出同样的答案。 */
const cases: { name: string; to: Session; owned: boolean }[] = [
  { name: "its ticket's session", to: s({ id: "t", ticketKey: "A-1" }), owned: true },
  { name: "its fix session", to: s({ id: "f", featureId: 1, fixesSession: "x" }), owned: true },
  { name: "another epic's ticket", to: s({ id: "t", ticketKey: "B-1" }), owned: false },
  { name: "an unknown ticket", to: s({ id: "t", ticketKey: "Z-9" }), owned: false },
  { name: "an archived ticket of this epic", to: s({ id: "t", ticketKey: "A-OLD", featureId: 1 }), owned: false },
  { name: "another epic's fix session", to: s({ id: "f", featureId: 2, fixesSession: "x" }), owned: false },
  { name: "a plain session of this epic (not a fix)", to: s({ id: "p", featureId: 1 }), owned: false },
];

describe("featureOwns / isControllerOf (BTL-269 A)", () => {
  const coord1 = s({ id: "c1", coordinator: true, featureId: 1 });
  const coord2 = s({ id: "c2", coordinator: true, featureId: 2 });
  const global = s({ id: "g", shipherd: true });
  for (const c of cases) {
    it(`epic coordinator and ${c.name}: ${c.owned ? "owns" : "does not own"} it, the same both ways`, () => {
      expect(featureOwns(1, keys(1)!, c.to)).toBe(c.owned);
      expect(isControllerOf(coord1, c.to, keys)).toBe(c.owned);
    });
  }
  it("not the coordinator itself, another coordinator, a dismissed session, or a sibling session", () => {
    expect(isControllerOf(coord1, coord1, keys)).toBe(false);
    expect(isControllerOf(coord1, coord2, keys)).toBe(false);
    expect(isControllerOf(coord1, s({ id: "t", ticketKey: "A-1", dismissed: true }), keys)).toBe(false);
    expect(isControllerOf(s({ id: "t2", ticketKey: "A-1" }), s({ id: "t", ticketKey: "A-1" }), keys)).toBe(false);
  });
  it("an archived or missing epic controls nothing", () => {
    const gone = s({ id: "c3", coordinator: true, featureId: 3 });
    expect(isControllerOf(gone, s({ id: "f", featureId: 3, fixesSession: "x" }), keys)).toBe(false);
  });
  it("global control controls epic coordinators only", () => {
    expect(isControllerOf(global, coord1, keys)).toBe(true);
    expect(isControllerOf(global, s({ id: "t", ticketKey: "A-1" }), keys)).toBe(false);
  });
});
