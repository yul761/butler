import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import { isControllerOf } from "./controller";

const s = (o: Partial<Session> & { id: string }): Session => ({
  ticketKey: null, cwd: "/w", origin: "shipherd", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, shipherd: false,
  lessonRunId: null, ...o,
});
const tickets: Record<string, number> = { "A-1": 1, "B-1": 2 };
const feat = (k: string) => tickets[k] ?? null;

describe("isControllerOf (BTL-269 A)", () => {
  const coord1 = s({ id: "c1", coordinator: true, featureId: 1 });
  const coord2 = s({ id: "c2", coordinator: true, featureId: 2 });
  const global = s({ id: "g", shipherd: true });
  it("an epic coordinator controls its own tickets and fix sessions only", () => {
    expect(isControllerOf(coord1, s({ id: "t", ticketKey: "A-1" }), feat)).toBe(true);
    expect(isControllerOf(coord1, s({ id: "f", featureId: 1, fixesSession: "x" }), feat)).toBe(true);
    expect(isControllerOf(coord2, s({ id: "t", ticketKey: "A-1" }), feat)).toBe(false);
    expect(isControllerOf(coord1, s({ id: "t", ticketKey: "Z-9" }), feat)).toBe(false);
    expect(isControllerOf(coord1, coord2, feat)).toBe(false);
    expect(isControllerOf(s({ id: "t2", ticketKey: "A-1" }), s({ id: "t", ticketKey: "A-1" }), feat)).toBe(false);
  });
  it("global control controls epic coordinators only", () => {
    expect(isControllerOf(global, coord1, feat)).toBe(true);
    expect(isControllerOf(global, s({ id: "t", ticketKey: "A-1" }), feat)).toBe(false);
  });
});
