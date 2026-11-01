import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { EpicsRepo } from "../db/epics-repo";
import { FeaturesRepo } from "../db/features-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, memDb } from "../test-utils";
import { applyHookEnvelope } from "./hook-events";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  insertTicket(tickets, { key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
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

  it("ignores every event from Butler's own headless runs", () => {
    const { sessions, deps } = setup();
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
      expect(applyHookEnvelope(env(ev, "h1", { butlerSession: "headless:run-1" }, { source: "fork" }), deps)).toEqual({ kind: "ignored", reason: "headless" });
    }
    expect(sessions.get("h1")).toBeNull();
  });
});

describe("hook sessions on multi-repo tickets", () => {
  it("records which repo (or the coordinator) a hook-created session belongs to", () => {
    const { sessions, tickets } = setup();
    const repoId = tickets.get("PROJ-1")!.repos[0].id;
    const placement = (key: string, cwd: string) => (cwd === "/ws/PROJ-1" ? { repoId: null, coordinator: true } : { repoId: cwd.startsWith("/r") ? repoId : null, coordinator: false });
    const deps = { sessions, tickets, placement };
    applyHookEnvelope(env("SessionStart", "a", { ticket: "PROJ-1", butlerSession: "a" }, { cwd: "/r/src" }), deps);
    applyHookEnvelope(env("SessionStart", "b", { ticket: "PROJ-1", butlerSession: "b" }, { cwd: "/ws/PROJ-1" }), deps);
    expect(sessions.get("a")).toMatchObject({ repoId, coordinator: false });
    expect(sessions.get("b")).toMatchObject({ repoId: null, coordinator: true });
  });
});

describe("hook sessions in a fix session's terminal", () => {
  function fixSetup() {
    const db = memDb();
    const tickets = new TicketsRepo(db);
    const sessions = new SessionsRepo(db);
    const featureId = new FeaturesRepo(db).insert({ name: "f", workspaceDir: "/ws", createdAt: 1 });
    sessions.insertIfAbsent({ id: "fix", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, fixesSession: "stuck-1" });
    return { sessions, featureId, deps: { sessions, tickets, featureForCwd: (cwd: string) => (cwd === "/ws" ? featureId : null) } };
  }
  const inFix = { butlerSession: "fix" };

  it("keeps a fix session's new head a fix session across /clear", () => {
    const { sessions, featureId, deps } = fixSetup();
    applyHookEnvelope(env("SessionStart", "fix-2", inFix, { cwd: "/ws", source: "clear" }), deps);
    expect(sessions.head("fix")).toMatchObject({ id: "fix-2", featureId, coordinator: false, fixesSession: "stuck-1" });
    // 再 clear 一次，还是修复 session
    applyHookEnvelope(env("SessionStart", "fix-3", inFix, { cwd: "/ws", source: "clear" }), deps);
    expect(sessions.head("fix")).toMatchObject({ id: "fix-3", featureId, coordinator: false, fixesSession: "stuck-1" });
    expect(sessions.listFeatureCoordinators(featureId)).toEqual([]);
  });

  it("does not make the new head a coordinator when Stop arrives before SessionStart", () => {
    const { sessions, deps } = fixSetup();
    applyHookEnvelope(env("Stop", "fix-2", inFix, { cwd: "/ws" }), deps);
    expect(sessions.get("fix-2")).toMatchObject({ coordinator: false, fixesSession: "stuck-1" });
  });

  it("does not make a session the scan left outside any feature a coordinator", () => {
    const { sessions, featureId, deps } = fixSetup();
    sessions.insertIfAbsent({ id: "fix-2", ticketKey: null, cwd: "/elsewhere", origin: "discovered", createdAt: 2 });
    applyHookEnvelope(env("Stop", "fix-2", inFix, { cwd: "/ws" }), deps);
    expect(sessions.get("fix-2")).toMatchObject({ coordinator: false });
    applyHookEnvelope(env("SessionStart", "fix-2", inFix, { cwd: "/ws", source: "clear" }), deps);
    expect(sessions.get("fix-2")).toMatchObject({ coordinator: false, featureId, fixesSession: "stuck-1" });
  });

  it("does not hand fixesSession to a nested claude started in that terminal", () => {
    const { sessions, deps } = fixSetup();
    expect(applyHookEnvelope(env("SessionStart", "nested", inFix, { cwd: "/ws", source: "startup" }), deps)).toEqual({ kind: "nested", sessionId: "nested" });
    expect(sessions.get("nested")).toMatchObject({ fixesSession: null, featureId: null, dismissed: true });
    expect(sessions.head("fix")?.id).toBe("fix");
  });

  it("leaves an existing coordinator a coordinator when /resume in the fix terminal picks it", () => {
    const { sessions, featureId, deps } = fixSetup();
    sessions.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, coordinator: true });
    const eff = applyHookEnvelope(env("SessionStart", "c", inFix, { cwd: "/ws", source: "resume" }), deps);
    expect(eff).toEqual({ kind: "session_started", sessionId: "c", ticketKey: null, replaced: "fix" });
    expect(sessions.head("fix")?.id).toBe("c");
    expect(sessions.get("c")).toMatchObject({ coordinator: true, fixesSession: null, featureId });
    expect(sessions.listFeatureCoordinators(featureId).map((s) => s.id)).toEqual(["c"]);
  });

  it("leaves an existing fix session a fix session when /resume in a coordinator terminal picks it", () => {
    const { sessions, featureId, deps } = fixSetup();
    sessions.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, coordinator: true });
    applyHookEnvelope(env("SessionStart", "fix", { butlerSession: "c" }, { cwd: "/ws", source: "resume" }), deps);
    expect(sessions.head("c")?.id).toBe("fix");
    expect(sessions.get("fix")).toMatchObject({ coordinator: false, fixesSession: "stuck-1", featureId });
  });

  it("does not pull an unclaimed session into the feature when /resume in the fix terminal picks it", () => {
    const { sessions, featureId, deps } = fixSetup();
    sessions.insertIfAbsent({ id: "loose", ticketKey: null, cwd: "/elsewhere", origin: "discovered", createdAt: 1 });
    applyHookEnvelope(env("SessionStart", "loose", inFix, { cwd: "/elsewhere", source: "resume" }), deps);
    expect(sessions.head("fix")?.id).toBe("loose");
    expect(sessions.get("loose")).toMatchObject({ coordinator: false, fixesSession: null, featureId: null });
    expect(sessions.listFeatureCoordinators(featureId)).toEqual([]);
  });

  it("gives a new id from /resume in the fix terminal the fix session's place", () => {
    const { sessions, featureId, deps } = fixSetup();
    applyHookEnvelope(env("SessionStart", "fix-2", inFix, { cwd: "/ws", source: "resume" }), deps);
    expect(sessions.head("fix")).toMatchObject({ id: "fix-2", coordinator: false, fixesSession: "stuck-1", featureId });
  });

  it("still claims an unclaimed session for the feature when /resume in a coordinator terminal picks it", () => {
    const { sessions, featureId, deps } = fixSetup();
    sessions.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, coordinator: true });
    sessions.insertIfAbsent({ id: "loose", ticketKey: null, cwd: "/elsewhere", origin: "discovered", createdAt: 1 });
    applyHookEnvelope(env("SessionStart", "loose", { butlerSession: "c" }, { cwd: "/elsewhere", source: "resume" }), deps);
    expect(sessions.get("loose")).toMatchObject({ coordinator: true, fixesSession: null, featureId });
  });

  it("still makes a real coordinator's new head a coordinator", () => {
    const { sessions, featureId, deps } = fixSetup();
    sessions.insertIfAbsent({ id: "c", ticketKey: null, cwd: "/ws", origin: "butler", createdAt: 1, featureId, coordinator: true });
    applyHookEnvelope(env("SessionStart", "c-2", { butlerSession: "c" }, { cwd: "/ws", source: "clear" }), deps);
    expect(sessions.get("c-2")).toMatchObject({ coordinator: true, featureId, fixesSession: null });
  });
});

describe("hook sessions and epics", () => {
  function epicSetup() {
    const db = memDb();
    const tickets = new TicketsRepo(db);
    insertTicket(tickets, { key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
    const sessions = new SessionsRepo(db);
    const featureId = new FeaturesRepo(db).insert({ name: "f", workspaceDir: "/fs", createdAt: 1 });
    const epicsRepo = new EpicsRepo(db);
    const epicId = epicsRepo.insert({ name: "e", workspaceDir: "/es", createdAt: 1 });
    const otherEpic = epicsRepo.insert({ name: "o", workspaceDir: "/os", createdAt: 1 });
    sessions.insertIfAbsent({ id: "e1", ticketKey: null, cwd: "/es", origin: "butler", createdAt: 1, epicId });
    const deps = {
      sessions, tickets,
      featureForCwd: (cwd: string) => (cwd === "/fs" ? featureId : null),
      epicForCwd: (cwd: string) => (cwd === "/es" ? epicId : cwd === "/os" ? otherEpic : null),
    };
    return { sessions, featureId, epicId, otherEpic, deps };
  }
  const inEpic = { butlerSession: "e1" };

  it("keeps the new head an epic session across /clear and compact, and never a coordinator", () => {
    const { sessions, epicId, deps } = epicSetup();
    const eff = applyHookEnvelope(env("SessionStart", "e2", inEpic, { cwd: "/es", source: "clear" }), deps);
    expect(eff).toEqual({ kind: "session_started", sessionId: "e2", ticketKey: null, replaced: "e1" });
    expect(sessions.head("e1")).toMatchObject({ id: "e2", epicId, featureId: null, ticketKey: null, coordinator: false });
    applyHookEnvelope(env("SessionStart", "e3", inEpic, { cwd: "/es", source: "compact" }), deps);
    expect(sessions.head("e1")).toMatchObject({ id: "e3", epicId, coordinator: false });
    expect(sessions.listByEpic(epicId).filter((s) => !s.replacedBy).map((s) => s.id)).toEqual(["e3"]);
  });

  it("keeps the epic when Stop arrives before SessionStart, or the new segment reports another directory", () => {
    const { sessions, epicId, deps } = epicSetup();
    applyHookEnvelope(env("Stop", "e2", inEpic, { cwd: "/somewhere/else" }), deps);
    expect(sessions.get("e2")).toMatchObject({ epicId, coordinator: false });
    applyHookEnvelope(env("SessionStart", "e2", inEpic, { cwd: "/somewhere/else", source: "clear" }), deps);
    expect(sessions.head("e1")).toMatchObject({ id: "e2", epicId });
  });

  it("does not turn an epic terminal's new head into a feature coordinator because of its directory", () => {
    const { sessions, featureId, epicId, deps } = epicSetup();
    applyHookEnvelope(env("Stop", "e2", inEpic, { cwd: "/fs" }), deps);
    expect(sessions.get("e2")).toMatchObject({ epicId, featureId: null, coordinator: false });
    applyHookEnvelope(env("SessionStart", "e2", inEpic, { cwd: "/fs", source: "clear" }), deps);
    expect(sessions.head("e1")).toMatchObject({ id: "e2", epicId, featureId: null, coordinator: false });
    expect(sessions.listFeatureCoordinators(featureId)).toEqual([]);
  });

  it("leaves an unclaimed session alone when /resume in the epic terminal picks it, also on its later events", () => {
    const { sessions, deps } = epicSetup();
    sessions.insertIfAbsent({ id: "loose", ticketKey: null, cwd: "/elsewhere", origin: "discovered", createdAt: 1 });
    applyHookEnvelope(env("SessionStart", "loose", inEpic, { cwd: "/elsewhere", source: "resume" }), deps);
    expect(sessions.head("e1")?.id).toBe("loose");
    for (const ev of ["Stop", "UserPromptSubmit"]) applyHookEnvelope(env(ev, "loose", inEpic, { cwd: "/es" }), deps);
    expect(sessions.get("loose")).toMatchObject({ epicId: null, featureId: null, ticketKey: null, coordinator: false });
  });

  it("does not pull an existing session in when its Stop arrives before the /resume SessionStart", () => {
    const { sessions, deps } = epicSetup();
    sessions.insertIfAbsent({ id: "loose", ticketKey: null, cwd: "/es", origin: "discovered", createdAt: 1 });
    applyHookEnvelope(env("Stop", "loose", inEpic, { cwd: "/es" }), deps);
    applyHookEnvelope(env("SessionStart", "loose", inEpic, { cwd: "/es", source: "resume" }), deps);
    expect(sessions.get("loose")?.epicId).toBeNull();
  });

  it("keeps each existing session's owner when /resume picks it", () => {
    const { sessions, featureId, otherEpic, epicId, deps } = epicSetup();
    sessions.insertIfAbsent({ id: "theirs", ticketKey: null, cwd: "/os", origin: "butler", createdAt: 1, epicId: otherEpic });
    sessions.insertIfAbsent({ id: "coord", ticketKey: null, cwd: "/fs", origin: "butler", createdAt: 1, featureId, coordinator: true });
    applyHookEnvelope(env("SessionStart", "theirs", inEpic, { cwd: "/es", source: "resume" }), deps);
    expect(sessions.get("theirs")?.epicId).toBe(otherEpic);
    // 换一个 epic 终端，选到 feature 总控：总控还是总控，不算 epic session。
    sessions.insertIfAbsent({ id: "e9", ticketKey: null, cwd: "/es", origin: "butler", createdAt: 1, epicId });
    applyHookEnvelope(env("SessionStart", "coord", { butlerSession: "e9" }, { cwd: "/fs", source: "resume" }), deps);
    expect(sessions.get("coord")).toMatchObject({ epicId: null, featureId, coordinator: true });
  });

  it("gives a new id from /resume in the epic terminal the epic", () => {
    const { sessions, epicId, deps } = epicSetup();
    applyHookEnvelope(env("SessionStart", "e2", inEpic, { cwd: "/es", source: "resume" }), deps);
    expect(sessions.head("e1")).toMatchObject({ id: "e2", epicId });
  });

  it("leaves an epic session an epic session when a feature or ticket terminal's /resume picks it", () => {
    const { sessions, featureId, epicId, deps } = epicSetup();
    sessions.insertIfAbsent({ id: "coord", ticketKey: null, cwd: "/fs", origin: "butler", createdAt: 1, featureId, coordinator: true });
    applyHookEnvelope(env("SessionStart", "e1", { butlerSession: "coord" }, { cwd: "/es", source: "resume" }), deps);
    expect(sessions.get("e1")).toMatchObject({ epicId, featureId: null, ticketKey: null, coordinator: false });
    sessions.insertIfAbsent({ id: "e2", ticketKey: null, cwd: "/es", origin: "butler", createdAt: 1, epicId });
    sessions.insertIfAbsent({ id: "t1", ticketKey: "PROJ-1", cwd: "/r", origin: "butler", createdAt: 1 });
    applyHookEnvelope(env("SessionStart", "e2", { ticket: "PROJ-1", butlerSession: "t1" }, { cwd: "/es", source: "resume" }), deps);
    expect(sessions.get("e2")).toMatchObject({ epicId, ticketKey: null });
  });

  it("keeps a nested claude out of the epic, in any order of its events", () => {
    const { sessions, epicId, deps } = epicSetup();
    expect(applyHookEnvelope(env("SessionStart", "n1", inEpic, { cwd: "/es", source: "startup" }), deps)).toEqual({ kind: "nested", sessionId: "n1" });
    expect(sessions.get("n1")).toMatchObject({ epicId: null, featureId: null, dismissed: true });
    for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) applyHookEnvelope(env(ev, "n1", inEpic, { cwd: "/es" }), deps);
    expect(sessions.get("n1")).toMatchObject({ epicId: null, dismissed: true });
    // Stop 先到时已经按终端记成了 epic session，SessionStart 认出是嵌套后要清掉。
    applyHookEnvelope(env("Stop", "n2", inEpic, { cwd: "/es" }), deps);
    applyHookEnvelope(env("SessionStart", "n2", inEpic, { cwd: "/es", source: "startup" }), deps);
    expect(sessions.get("n2")).toMatchObject({ epicId: null, dismissed: true });
    expect(sessions.head("e1")?.id).toBe("e1");
    expect(sessions.listByEpic(epicId).map((s) => s.id)).toEqual(["e1"]);
  });

  it("counts a claude the user opened exactly in the epic workspace as an epic session", () => {
    const { sessions, epicId, deps } = epicSetup();
    applyHookEnvelope(env("SessionStart", "d1", {}, { cwd: "/es" }), deps);
    expect(sessions.get("d1")).toMatchObject({ epicId, featureId: null, ticketKey: null, coordinator: false, origin: "discovered" });
    expect(sessions.listUnclaimed(0).map((s) => s.id)).not.toContain("d1");
    applyHookEnvelope(env("SessionStart", "d2", {}, { cwd: "/es/notes" }), deps);
    expect(sessions.get("d2")?.epicId).toBeNull();
  });

  it("does not make an epic session a coordinator when it later reports a feature workspace", () => {
    const { sessions, featureId, epicId, deps } = epicSetup();
    applyHookEnvelope(env("SessionStart", "d1", {}, { cwd: "/es" }), deps);
    applyHookEnvelope(env("Stop", "d1", {}, { cwd: "/fs" }), deps);
    expect(sessions.get("d1")).toMatchObject({ epicId, featureId: null, coordinator: false });
    expect(sessions.listFeatureCoordinators(featureId)).toEqual([]);
  });

  it("keeps ticket and feature terminals theirs in an epic workspace", () => {
    const { sessions, featureId, deps } = epicSetup();
    applyHookEnvelope(env("SessionStart", "t1", { ticket: "PROJ-1", butlerSession: "t1" }, { cwd: "/es" }), deps);
    expect(sessions.get("t1")).toMatchObject({ ticketKey: "PROJ-1", epicId: null });
    sessions.insertIfAbsent({ id: "c1", ticketKey: null, cwd: "/fs", origin: "butler", createdAt: 1, featureId, coordinator: true });
    applyHookEnvelope(env("SessionStart", "c2", { butlerSession: "c1" }, { cwd: "/es", source: "clear" }), deps);
    expect(sessions.get("c2")).toMatchObject({ featureId, epicId: null, coordinator: true });
    applyHookEnvelope(env("SessionStart", "w1", {}, { cwd: "/fs" }), deps);
    expect(sessions.get("w1")).toMatchObject({ featureId, epicId: null, coordinator: true });
  });
});
