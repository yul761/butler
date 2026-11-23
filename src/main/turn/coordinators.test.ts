import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import { turnCoordinators } from "./coordinators";

const db = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, ticketKey: null, featureId: null, shipherd: false, replacedBy: null, hibernatedAt: null, wakeError: null, fixesSession: null, ...over }) as Session;
const base = { featureViews: () => [], runningShipherd: () => null, hibernatedHeads: () => [] };

describe("turnCoordinators", () => {
  it("the running Shipherd session counts though the db row carries no termId", () => {
    const b = db("b1", { shipherd: true });
    const out = turnCoordinators({ ...base, runningShipherd: () => b });
    expect(out).toEqual([{ session: b, featureId: null, target: { page: "shipherd", sessionId: "b1" }, title: null }]);
  });

  it("a hibernated Shipherd counts when none is running; a replaced one does not", () => {
    const hib = db("b2", { shipherd: true, hibernatedAt: 5 });
    expect(turnCoordinators({ ...base, hibernatedHeads: () => [hib] }).map((c) => c.session.id)).toEqual(["b2"]);
    const gone = db("b3", { shipherd: true, hibernatedAt: 5, replacedBy: "b4" });
    expect(turnCoordinators({ ...base, hibernatedHeads: () => [gone] })).toEqual([]);
  });

  it("feature coordinators need a terminal, hibernation or a wake error; fix sessions are not coordinators", () => {
    const open = { ...db("c1", { featureId: 3 }), termId: "t1" };
    const closed = { ...db("c2", { featureId: 3 }), termId: null };
    const fix = { ...db("c3", { featureId: 3, fixesSession: "x" }), termId: "t3" };
    const out = turnCoordinators({ ...base, featureViews: () => [{ id: 3, name: "F", sessions: [open, closed, fix] }] });
    expect(out.map((c) => [c.session.id, c.featureId, c.target])).toEqual([["c1", 3, { page: "feature", id: 3, sessionId: "c1" }]]);
  });

});
