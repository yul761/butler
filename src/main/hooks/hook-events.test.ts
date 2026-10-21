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

  it("a nested claude (startup, other id) in a Butler terminal does not hijack the chain", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "A", { ticket: "PROJ-1", butlerSession: "A" }), deps);
    const eff = applyHookEnvelope(env("SessionStart", "N", { ticket: "PROJ-1", butlerSession: "A" }, { source: "startup" }), deps);
    expect(eff).toEqual({ kind: "nested", sessionId: "N" });
    expect(sessions.head("A")?.id).toBe("A");
    expect(sessions.get("N")).toMatchObject({ ticketKey: null, dismissed: true });
    // 缺少 source 同样按嵌套处理
    expect(applyHookEnvelope(env("SessionStart", "M", { butlerSession: "A" }), deps).kind).toBe("nested");
    expect(sessions.head("A")?.id).toBe("A");
  });

  it("later events from a nested session never attach the ticket", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "A", { ticket: "PROJ-1", butlerSession: "A" }), deps);
    applyHookEnvelope(env("SessionStart", "N", { ticket: "PROJ-1", butlerSession: "A" }, { source: "startup" }), deps);
    for (const ev of ["Stop", "UserPromptSubmit", "SessionEnd"]) applyHookEnvelope(env(ev, "N", { ticket: "PROJ-1", butlerSession: "A" }), deps);
    expect(sessions.get("N")).toMatchObject({ ticketKey: null, dismissed: true });
  });

  it("compact and resume chain like clear", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "A", { ticket: "PROJ-1", butlerSession: "A" }), deps);
    applyHookEnvelope(env("SessionStart", "B", { butlerSession: "A" }, { source: "compact" }), deps);
    applyHookEnvelope(env("SessionStart", "C", { butlerSession: "A" }, { source: "resume" }), deps);
    expect(sessions.head("A")?.id).toBe("C");
    expect(sessions.get("C")?.ticketKey).toBe("PROJ-1");
  });

  it("out-of-order: Stop(B) before SessionStart(B, clear) still chains and keeps the ticket", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "A", { ticket: "PROJ-1", butlerSession: "A" }), deps);
    applyHookEnvelope(env("Stop", "B", { butlerSession: "A" }), deps);
    applyHookEnvelope(env("SessionStart", "B", { butlerSession: "A" }, { source: "clear" }), deps);
    expect(sessions.head("A")?.id).toBe("B");
    expect(sessions.get("B")).toMatchObject({ ticketKey: "PROJ-1", dismissed: false });
  });

  it("UserPromptSubmit fills an empty firstPrompt once, with discovery's normalisation", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("UserPromptSubmit", "s1", {}, { prompt: "  fix PROJ-1 please  " }), deps);
    expect(sessions.get("s1")?.firstPrompt).toBe("fix PROJ-1 please");
    applyHookEnvelope(env("UserPromptSubmit", "s1", {}, { prompt: "second" }), deps);
    expect(sessions.get("s1")?.firstPrompt).toBe("fix PROJ-1 please");
    applyHookEnvelope(env("UserPromptSubmit", "s2", {}, { prompt: "<system-reminder>x</system-reminder>" }), deps);
    applyHookEnvelope(env("UserPromptSubmit", "s3", {}, { prompt: "   " }), deps);
    expect(sessions.get("s2")?.firstPrompt).toBeNull();
    expect(sessions.get("s3")?.firstPrompt).toBeNull();
    applyHookEnvelope(env("UserPromptSubmit", "s4", {}, { prompt: "x".repeat(300) }), deps);
    expect(sessions.get("s4")?.firstPrompt).toBe(`${"x".repeat(200)}…`);
  });

  it("late envelopes do not resurrect a deleted orphan row; a real prompt does", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "o1", { ticket: "PROJ-1", butlerSession: "o1" }), deps);
    sessions.delete("o1");
    applyHookEnvelope(env("Stop", "o1", { ticket: "PROJ-1", butlerSession: "o1" }), deps);
    applyHookEnvelope(env("SessionEnd", "o1"), deps);
    applyHookEnvelope(env("SessionStart", "o1", { butlerSession: "o1" }, { source: "startup" }), deps);
    expect(sessions.get("o1")).toBeNull();
    applyHookEnvelope(env("UserPromptSubmit", "o1", { ticket: "PROJ-1", butlerSession: "o1" }, { prompt: "hi" }), deps);
    expect(sessions.get("o1")).toMatchObject({ ticketKey: "PROJ-1", origin: "butler", firstPrompt: "hi" });
  });

  it("a late event re-creates a deleted row when its transcript now exists", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "o2", { ticket: "PROJ-1", butlerSession: "o2" }), deps);
    sessions.delete("o2");
    applyHookEnvelope(env("Stop", "o2", { ticket: "PROJ-1", butlerSession: "o2" }), { ...deps, transcriptState: () => "present" });
    expect(sessions.get("o2")).not.toBeNull();
  });

  it("a tombstoned id in a clear chain does not point the previous head at a missing row", () => {
    const { sessions, deps } = setup();
    applyHookEnvelope(env("SessionStart", "A", { ticket: "PROJ-1", butlerSession: "A" }), deps);
    sessions.delete("B");
    const eff = applyHookEnvelope(env("SessionStart", "B", { butlerSession: "A" }, { source: "clear" }), deps);
    expect(eff).toEqual({ kind: "session_started", sessionId: "B", ticketKey: "PROJ-1", replaced: null });
    expect(sessions.get("B")).toBeNull();
    expect(sessions.head("A")?.id).toBe("A");
  });

  it("upgrades a discovered session to butler once a Butler terminal reports it", () => {
    const { sessions, deps } = setup();
    sessions.insertIfAbsent({ id: "d1", ticketKey: "PROJ-1", cwd: "/w", origin: "discovered", createdAt: 1 });
    applyHookEnvelope(env("Stop", "d1"), deps);
    expect(sessions.get("d1")?.origin).toBe("discovered");
    applyHookEnvelope(env("UserPromptSubmit", "d1", { ticket: "PROJ-1", butlerSession: "d1" }), deps);
    expect(sessions.get("d1")?.origin).toBe("butler");
  });
});
