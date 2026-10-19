import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import { applyHookEnvelope } from "./hook-events";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const sessions = new SessionsRepo(db);
  return { sessions, tickets, deps: { sessions, tickets } };
}

const env = (event: string, sessionId: string, over: Partial<HookEnvelope> = {}, payload: Record<string, unknown> = {}): HookEnvelope => ({
  v: 1, receivedAt: 100, ticket: null, butlerSession: null,
  payload: { hook_event_name: event, session_id: sessionId, cwd: "/w", ...payload }, ...over,
});

describe("applyHookEnvelope", () => {
  it("SessionStart from a Butler terminal binds the ticket", () => {
    const { sessions, deps } = setup();
    expect(applyHookEnvelope(env("SessionStart", "s1", { ticket: "PROJ-1", butlerSession: "s1" }), deps))
      .toEqual({ kind: "session_started", sessionId: "s1", ticketKey: "PROJ-1", replaced: null });
    expect(sessions.get("s1")).toMatchObject({ ticketKey: "PROJ-1", origin: "butler", cwd: "/w", lastActivityAt: 100 });
  });

  it("/clear in a Butler terminal chains the new session and inherits the ticket", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "s1", { ticket: "PROJ-1", butlerSession: "s1" }), deps);
    const eff = applyHookEnvelope(env("SessionStart", "s2", { ticket: null, butlerSession: "s1" }, { source: "clear" }), deps);
    expect(eff).toEqual({ kind: "session_started", sessionId: "s2", ticketKey: "PROJ-1", replaced: "s1" });
    expect(sessions.head("s1")?.id).toBe("s2");
    // 再 clear 一次，链继续延长
    applyHookEnvelope(env("SessionStart", "s3", { butlerSession: "s1" }, { source: "clear" }), deps);
    expect(sessions.head("s1")?.id).toBe("s3");
  });

  it("an unknown ticket in env is ignored, the session is still recorded", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "s1", { ticket: "GONE-9" }), deps);
    expect(sessions.get("s1")).toMatchObject({ ticketKey: null, origin: "butler" });
  });

  it("Stop before SessionStart creates the session and marks it waiting", () => {
    const { sessions, deps } = setup();
    expect(applyHookEnvelope(env("Stop", "s9"), deps)).toEqual({ kind: "waiting", sessionId: "s9", waiting: true });
    expect(sessions.get("s9")).toMatchObject({ waitingForInput: true, origin: "discovered" });
    applyHookEnvelope(env("SessionStart", "s9"), deps);
    expect(sessions.get("s9")?.waitingForInput).toBe(true);
  });

  it("UserPromptSubmit and SessionEnd clear the waiting flag", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("Stop", "s1"), deps);
    applyHookEnvelope(env("UserPromptSubmit", "s1", { receivedAt: 200 }), deps);
    expect(sessions.get("s1")).toMatchObject({ waitingForInput: false, lastActivityAt: 200 });
    applyHookEnvelope(env("Stop", "s1"), deps);
    expect(applyHookEnvelope(env("SessionEnd", "s1"), deps)).toEqual({ kind: "ended", sessionId: "s1" });
    expect(sessions.get("s1")?.waitingForInput).toBe(false);
  });

  it("ignores payloads without event or session id", () => {
    const { deps } = setup();
    expect(applyHookEnvelope({ v: 1, receivedAt: 1, ticket: null, butlerSession: null, payload: null }, deps).kind).toBe("ignored");
    expect(applyHookEnvelope(env("Notification", "s1"), deps)).toEqual({ kind: "ignored", reason: "unhandled_event:Notification" });
  });
});
