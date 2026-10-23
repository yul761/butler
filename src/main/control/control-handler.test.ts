import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_RUNNING_PER_TICKET } from "../../shared/control";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { PtyManager } from "../sessions/pty-manager";
import { SessionService } from "../sessions/session-service";
import { fakePtyFactory, makeRepo, memDb, tempDir } from "../test-utils";
import { TicketService } from "../tickets/ticket-service";
import { controlHandler } from "./control-handler";

async function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const settings = new SettingsRepo(db);
  const ticketService = new TicketService({ tickets, settings, now: () => 1, workspacesDir: tempDir("butler-ws-") });
  const { factory, spawned } = fakePtyFactory();
  const pty = new PtyManager(factory, { data: () => undefined, exit: () => undefined });
  let n = 0;
  const sessionService = new SessionService({
    tickets, sessions, settings, ticketService, pty,
    ready: async () => undefined,
    transcriptExists: () => false,
    transcriptState: () => "absent",
    claude: () => ({ path: "/bin/claude", pathValue: "/bin" }),
    newId: () => `s-${++n}`,
    now: () => 1000,
    platform: "darwin",
    baseEnv: {},
  });
  const submitted: [string, string][] = [];
  let notified = 0;
  const handle = controlHandler({
    tickets, sessions, ticketService, sessionService,
    submit: async (termId, task) => (submitted.push([termId, task]), true),
    notify: () => notified++,
  });
  const web = makeRepo();
  const api = makeRepo();
  await ticketService.create({ key: "FULL-1" });
  await ticketService.addRepo({ ticketKey: "FULL-1", repoPath: web, workMode: "worktree" });
  await ticketService.addRepo({ ticketKey: "FULL-1", repoPath: api, workMode: "worktree" });
  return { handle, sessionService, sessions, tickets, spawned, submitted, notified: () => notified, web, api };
}

const base = { v: 1 as const, ticketKey: "FULL-1", from: null };

describe("controlHandler", () => {
  it("lists the ticket's repos by name and working directory", async () => {
    const { handle, tickets } = await setup();
    const [w, a] = tickets.get("FULL-1")!.repos;
    const r = await handle({ ...base, op: "list_repos" });
    expect(r).toEqual({
      v: 1, ok: true,
      value: [
        { name: expect.any(String), dir: w.worktreePath, workMode: "worktree", branch: "feature/FULL-1" },
        { name: expect.any(String), dir: a.worktreePath, workMode: "worktree", branch: "feature/FULL-1" },
      ],
    });
  });

  it("starts a session in the named repo, records the coordinator as its spawner and hands it the task", async () => {
    const { handle, sessionService, sessions, tickets, spawned, submitted, notified, api } = await setup();
    await sessionService.open({ ticketKey: "FULL-1", coordinator: true });
    const apiRepo = tickets.get("FULL-1")!.repos[1];
    const r = await handle({ ...base, from: "s-1", op: "start_session", repo: api.split(/[\\/]/).pop()!.toUpperCase(), task: "写接口\x1b[201~\r\n加测试" });
    expect(r).toEqual({ v: 1, ok: true, value: { sessionId: "s-2", repo: expect.any(String), dir: apiRepo.worktreePath } });
    expect(spawned[1].opts.cwd).toBe(apiRepo.worktreePath);
    expect(sessions.get("s-2")).toMatchObject({ ticketKey: "FULL-1", repoId: apiRepo.id, spawnedBy: "s-1", coordinator: false });
    expect(submitted).toEqual([["s-2", "写接口[201~\n加测试"]]);
    expect(notified()).toBe(1);

    const listed = await handle({ ...base, op: "list_sessions" });
    expect(listed.ok && (listed.value as { id: string; running: boolean; startedByCoordinator: boolean; repo: string | null }[])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "s-1", repo: "总控", running: true, startedByCoordinator: false }),
        expect.objectContaining({ id: "s-2", running: true, startedByCoordinator: true }),
      ]),
    );
  });

  it("accepts the repo's working directory, and does not trust a spawner that is not this ticket's coordinator", async () => {
    const { handle, sessions, tickets } = await setup();
    const web = tickets.get("FULL-1")!.repos[0];
    const r = await handle({ ...base, from: "someone-else", op: "start_session", repo: join(web.worktreePath!, "."), task: "做前端" });
    expect(r.ok).toBe(true);
    expect(sessions.get("s-1")).toMatchObject({ repoId: web.id, spawnedBy: null });
  });

  it("refuses unknown or archived tickets, unknown repos and empty tasks", async () => {
    const { handle, tickets } = await setup();
    expect(await handle({ ...base, ticketKey: "NOPE-1", op: "list_repos" })).toMatchObject({ ok: false });
    expect(await handle({ ...base, op: "start_session", repo: "mobile", task: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("没有仓库 mobile") });
    expect(await handle({ ...base, op: "start_session", repo: tickets.get("FULL-1")!.repos[0].worktreePath!, task: "\x07\x1b" })).toMatchObject({ ok: false });
    tickets.archive("FULL-1", 5);
    expect(await handle({ ...base, op: "list_sessions" })).toMatchObject({ ok: false });
  });

  it(`stops at ${MAX_RUNNING_PER_TICKET} running terminals per ticket`, async () => {
    const { handle, tickets } = await setup();
    const dir = tickets.get("FULL-1")!.repos[0].worktreePath!;
    for (let i = 0; i < MAX_RUNNING_PER_TICKET; i++) expect((await handle({ ...base, op: "start_session", repo: dir, task: `t${i}` })).ok).toBe(true);
    expect(await handle({ ...base, op: "start_session", repo: dir, task: "one more" })).toMatchObject({ ok: false, error: expect.stringContaining(`${MAX_RUNNING_PER_TICKET}`) });
  });
});
