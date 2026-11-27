import { describe, expect, it } from "vitest";
import type { Session, Ticket } from "../../shared/types";
import { controlHandler, type ControlHandlerDeps } from "./control-handler";

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id, ticketKey: null, cwd: "/w", origin: "shipherd", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: false, replacedBy: null,
  dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, shipherd: false, lessonRunId: null, ...o,
});

function setup(heads: Record<string, Session>, lessons?: ControlHandlerDeps["lessons"]) {
  return controlHandler({
    tickets: { get: (key: string) => ({ key, archivedAt: key === "OLD-1" ? 5 : null }) } as unknown as ControlHandlerDeps["tickets"],
    ticketService: {} as never, sessionService: {} as never,
    sessions: { head: (id: string) => heads[id] ?? null } as unknown as ControlHandlerDeps["sessions"],
    kill: () => undefined, screenNeedsUser: () => false, submit: async () => "sent", notify: () => undefined,
    lessons,
  });
}

describe("lessons lookup (BTL-274)", () => {
  it("answers the ticket's own session with the lookup for that ticket", async () => {
    const asked: [string, unknown][] = [];
    const handle = setup({ s: session("s", { ticketKey: "BTL-1" }) }, (t: Ticket, q) => (asked.push([t.key, q]), { lessons: [{ id: 1 }], total: 1, truncated: false }));
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: "s", op: "lessons", paths: ["a.ts"], query: "x" })).toEqual({ v: 1, ok: true, value: { lessons: [{ id: 1 }], total: 1, truncated: false } });
    expect(asked).toEqual([["BTL-1", { paths: ["a.ts"], query: "x" }]]);
  });

  it("refuses unknown callers, another ticket's session, archived tickets, and when not wired; a throwing lookup is an error, not a crash", async () => {
    const heads = { t: session("t", { ticketKey: "BTL-1" }) };
    const calls: string[] = [];
    const handle = setup(heads, (t) => (calls.push(t.key), []));
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: null, op: "lessons" })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, ticketKey: "BTL-1", from: "ghost", op: "lessons" })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, ticketKey: "BTL-2", from: "t", op: "lessons" })).toMatchObject({ ok: false });
    expect(await handle({ v: 1, ticketKey: "OLD-1", from: "t", op: "lessons" })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    expect(await setup(heads)({ v: 1, ticketKey: "BTL-1", from: "t", op: "lessons" })).toMatchObject({ ok: false });
    const boom = setup(heads, () => {
      throw new Error("db");
    });
    expect(await boom({ v: 1, ticketKey: "BTL-1", from: "t", op: "lessons" })).toMatchObject({ ok: false });
  });
});
