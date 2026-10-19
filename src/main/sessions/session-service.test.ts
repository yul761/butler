import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { TicketService } from "../tickets/ticket-service";
import { fakePtyFactory, makeRepo, memDb } from "../test-utils";
import { PtyManager } from "./pty-manager";
import { SessionService } from "./session-service";

async function setup(opts: { claudePath?: string | null; workMode?: "branch" | "worktree" } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const settings = new SettingsRepo(db);
  const ticketService = new TicketService({ tickets, settings, now: () => 1 });
  const { factory, spawned } = fakePtyFactory();
  const pty = new PtyManager(factory, { data: () => undefined, exit: () => undefined });
  let n = 0;
  const service = new SessionService({
    tickets, sessions, settings, ticketService, pty,
    claude: () => ({ path: opts.claudePath === undefined ? "/bin/claude" : opts.claudePath, pathValue: "/login/bin" }),
    newId: () => `new-${++n}`,
    now: () => 1000,
    platform: "darwin",
    baseEnv: { HOME: "/h" },
  });
  const repo = makeRepo();
  const ticket = await ticketService.create({ key: "PROJ-1", repoPath: repo, workMode: opts.workMode ?? "worktree" });
  return { service, sessions, tickets, spawned, pty, repo, ticket, ticketService };
}

describe("SessionService.open", () => {
  it("starts a new session in the ticket workdir with Butler env", async () => {
    const { service, sessions, spawned, ticket } = await setup();
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: true, termId: "new-1", alreadyOpen: false });
    expect(spawned[0].file).toBe("/bin/claude");
    expect(spawned[0].args).toEqual(["--session-id", "new-1"]);
    expect(spawned[0].opts.cwd).toBe(ticket.worktreePath);
    expect(spawned[0].opts.env).toMatchObject({ PATH: "/login/bin", BUTLER_TICKET: "PROJ-1", BUTLER_SESSION: "new-1" });
    expect(sessions.get("new-1")).toMatchObject({ ticketKey: "PROJ-1", origin: "butler", cwd: ticket.worktreePath });
  });

  it("resumes the head of a replaced chain in the session's own cwd", async () => {
    const { service, sessions, spawned } = await setup();
    sessions.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/elsewhere", origin: "discovered", createdAt: 1 });
    sessions.insertIfAbsent({ id: "b", ticketKey: "PROJ-1", cwd: "/elsewhere", origin: "butler", createdAt: 2 });
    sessions.setReplacedBy("a", "b");
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "a" })).toEqual({ ok: true, termId: "b", alreadyOpen: false });
    expect(spawned[0].args).toEqual(["--resume", "b"]);
    expect(spawned[0].opts.cwd).toBe("/elsewhere");
  });

  it("never spawns a second claude for a session that is already open, even after /clear", async () => {
    const { service, sessions, spawned } = await setup();
    const first = await service.open({ ticketKey: "PROJ-1" });
    expect(first).toMatchObject({ ok: true, termId: "new-1" });
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "new-1" })).toEqual({ ok: true, termId: "new-1", alreadyOpen: true });

    // 终端里执行了 /clear：hook 把 new-1 链到了 c2
    sessions.insertIfAbsent({ id: "c2", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 3 });
    sessions.setReplacedBy("new-1", "c2");
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "c2" })).toEqual({ ok: true, termId: "new-1", alreadyOpen: true });
    expect(spawned).toHaveLength(1);
  });

  it("reports missing claude, unknown ticket and unknown session", async () => {
    const { service } = await setup({ claudePath: null });
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: false, reason: "claude_missing" });
    expect(await service.open({ ticketKey: "NOPE-1" })).toEqual({ ok: false, reason: "no_ticket" });
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "ghost" })).toEqual({ ok: false, reason: "no_session" });
  });

  it("stops on a branch mismatch unless forced", async () => {
    const { service, spawned, repo } = await setup({ workMode: "branch" });
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: false, reason: "branch_mismatch", current: "main", expected: "feature/PROJ-1", dirty: false });
    writeFileSync(join(repo, "README.md"), "dirty\n");
    expect(await service.open({ ticketKey: "PROJ-1" })).toMatchObject({ reason: "branch_mismatch", dirty: true });
    expect(spawned).toHaveLength(0);
    expect(await service.open({ ticketKey: "PROJ-1", force: true })).toMatchObject({ ok: true });
    expect(spawned[0].opts.cwd).toBe(repo);
  });
});

describe("SessionService views", () => {
  it("ticketViews hides replaced sessions and marks open/waiting ones", async () => {
    const { service, sessions } = await setup();
    await service.open({ ticketKey: "PROJ-1" });
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 1 });
    sessions.insertIfAbsent({ id: "c2", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 1 });
    sessions.setReplacedBy("old", "c2");
    sessions.setWaiting("new-1", true, 2000);
    const [view] = service.ticketViews();
    expect(view.effectiveStatus).toBe("active");
    expect(view.waiting).toBe(true);
    expect(view.sessions.map((s) => [s.id, s.termId])).toEqual([["new-1", "new-1"], ["c2", null]]);
  });

  it("unclaimed suggests tickets and claim/dismiss work", async () => {
    const { service, sessions } = await setup();
    sessions.insertIfAbsent({ id: "u1", ticketKey: null, cwd: "/w", origin: "discovered", gitBranch: "feature/proj-1-x", lastActivityAt: 900, createdAt: 900 });
    sessions.insertIfAbsent({ id: "u2", ticketKey: null, cwd: "/w", origin: "discovered", firstPrompt: "看 PROJ-77", lastActivityAt: 900, createdAt: 900 });
    const list = service.unclaimed();
    expect(list.map((s) => [s.id, s.suggestedTicket, s.suggestionExists])).toEqual([["u1", "PROJ-1", true], ["u2", "PROJ-77", false]]);
    service.claim("u1", "PROJ-1");
    service.dismiss("u2");
    expect(service.unclaimed()).toEqual([]);
    expect(() => service.claim("u2", "NOPE-1")).toThrow();
  });
});
