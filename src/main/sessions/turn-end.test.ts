import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import { onTurnEndedWithoutStop } from "./turn-end";

const fakeSessions = (head: Partial<Session> | null) => {
  const writes: [string, boolean, number][] = [];
  return {
    writes,
    head: (id: string) => (head ? ({ id, waitingForInput: false, lastActivityAt: 0, ...head } as Session) : null),
    setWaiting: (id: string, waiting: boolean, at: number) => void writes.push([id, waiting, at]),
  };
};

describe("onTurnEndedWithoutStop (BTL-265)", () => {
  it("marks the head waiting, notifies data, then handles the stop, in that order", () => {
    const sessions = fakeSessions({});
    const calls: string[] = [];
    onTurnEndedWithoutStop({ sessions, notify: (s) => calls.push(`notify:${s}`), stopped: (id) => calls.push(`stopped:${id}`) }, "h", 100);
    expect(sessions.writes).toEqual([["h", true, 100]]);
    expect(calls).toEqual(["notify:data", "stopped:h"]);
  });

  it("does nothing when nothing changed (already waiting, newer input, or no head)", () => {
    for (const head of [{ waitingForInput: true }, { lastActivityAt: 200 }, null]) {
      const sessions = fakeSessions(head);
      const calls: string[] = [];
      onTurnEndedWithoutStop({ sessions, notify: (s) => calls.push(s), stopped: (id) => calls.push(id) }, "h", 100);
      expect(sessions.writes).toEqual([]);
      expect(calls).toEqual([]);
    }
  });
});
