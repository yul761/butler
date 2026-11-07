import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import { MAX_RUNNING_PER_TICKET } from "../../shared/control";
import type { RefreshRefusal } from "../../shared/types";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { PtyManager } from "../sessions/pty-manager";
import type { RefreshResult, RefreshTrigger } from "../sessions/session-refresher";
import { SessionService } from "../sessions/session-service";
import { fakePtyFactory, makeRepo, memDb, tempDir } from "../test-utils";
import { TicketService } from "../tickets/ticket-service";
import { controlHandler } from "./control-handler";

async function setup(o: { memoryEnabled?: () => boolean } = {}) {
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
  const activities = new Map<string, SessionActivity>();
  const outputs = new Map<string, string>();
  const killed: string[] = [];
  /** 假的换新：precheck 返回 refusal；refresh 永远不结束（证明 refresh_session 不等它）。 */
  const refresh = { refusal: null as RefreshRefusal | null, prechecked: [] as [string, RefreshTrigger][], started: [] as [string, RefreshTrigger][] };
  const handle = controlHandler({
    tickets, sessions, ticketService, sessionService,
    refresher: {
      precheck: (id, trigger) => (refresh.prechecked.push([id, trigger]), refresh.refusal),
      refresh: (id, trigger) => (refresh.started.push([id, trigger]), new Promise<RefreshResult>(() => undefined)),
    },
    activity: (id) => activities.get(id) ?? null,
    activityOutput: async (id) => outputs.get(id) ?? "",
    submit: async (termId, task) => (submitted.push([termId, task]), "sent" as const),
    notify: () => notified++,
    kill: (termId) => void killed.push(termId),
    screenNeedsUser: () => false,
    lastReply: () => null,
    memoryEnabled: o.memoryEnabled,
  });
  const web = makeRepo();
  const api = makeRepo();
  await ticketService.create({ key: "FULL-1" });
  await ticketService.addRepo({ ticketKey: "FULL-1", repoPath: web, workMode: "worktree" });
  await ticketService.addRepo({ ticketKey: "FULL-1", repoPath: api, workMode: "worktree" });
  return { handle, sessionService, sessions, tickets, spawned, submitted, notified: () => notified, web, api, activities, outputs, ticketService, killed, refresh };
}

const base = { v: 1 as const, ticketKey: "FULL-1", from: null };

describe("controlHandler", () => {
  it("hands the task without the recall hint while memory is off (R36)", async () => {
    let on = false;
    const { handle, sessionService, submitted, api } = await setup({ memoryEnabled: () => on });
    await sessionService.open({ ticketKey: "FULL-1", coordinator: true });
    await handle({ ...base, from: "s-1", op: "start_session", repo: api.split(/[\\/]/).pop()!, task: "写接口" });
    expect(submitted).toEqual([["s-2", "总控 session 交给你的任务：\n写接口"]]);
    on = true;
    await handle({ ...base, from: "s-1", op: "start_session", repo: api.split(/[\\/]/).pop()!, task: "写接口" });
    expect(submitted[1][1]).toContain("recall");
  });

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
    expect(r).toEqual({ v: 1, ok: true, value: { sessionId: "s-2", repo: expect.any(String), dir: apiRepo.worktreePath, note: expect.any(String) } });
    expect(spawned[1].opts.cwd).toBe(apiRepo.worktreePath);
    expect(sessions.get("s-2")).toMatchObject({ ticketKey: "FULL-1", repoId: apiRepo.id, spawnedBy: "s-1", coordinator: false });
    expect(submitted).toEqual([["s-2", "总控 session 交给你的任务：\n写接口[201~\n加测试\n\n开始之前先用 recall 读一下 ticket 记忆（butler-memory）里的背景和约定。"]]);
    expect(notified()).toBe(1);

    const listed = await handle({ ...base, op: "list_sessions" });
    expect(listed.ok && (listed.value as { id: string; running: boolean; startedByCoordinator: boolean; repo: string | null }[])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "s-1", repo: "总控", running: true, startedByCoordinator: false }),
        expect.objectContaining({ id: "s-2", running: true, startedByCoordinator: true }),
      ]),
    );
  });

  it("passes the model to the new session and echoes it", async () => {
    const { handle, sessionService, sessions, spawned, tickets } = await setup();
    await sessionService.open({ ticketKey: "FULL-1", coordinator: true });
    const repo = tickets.get("FULL-1")!.repos[1];
    const r = await handle({ ...base, from: "s-1", op: "start_session", repo: repo.worktreePath!, task: "补测试", model: "sonnet" });
    expect(r).toMatchObject({ ok: true, value: { sessionId: "s-2", model: "sonnet" } });
    expect(sessions.get("s-2")).toMatchObject({ model: "sonnet" });
    expect(spawned[1].args).toEqual(expect.arrayContaining(["--model", "sonnet"]));
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

  describe("live activity", () => {
    const activity = (sessionId: string, over: Partial<SessionActivity> = {}): SessionActivity => ({
      sessionId, kind: "test", detail: "pnpm test", background: false, startedAt: 5, lastOutputAt: 6, stuck: null, reason: null, action: null, lastOutput: ["a", "b"], ...over,
    });

    it("gives every listed session an activity without lastOutput, null for one the monitor has not seen", async () => {
      const { handle, sessionService, activities } = await setup();
      await sessionService.open({ ticketKey: "FULL-1", coordinator: true });
      await sessionService.open({ ticketKey: "FULL-1", repoId: 1 });
      activities.set("s-2", activity("s-2", { stuck: false }));
      const r = await handle({ ...base, op: "list_sessions" });
      const rows = (r.ok ? r.value : []) as { id: string; activity: object | null }[];
      expect(rows.find((x) => x.id === "s-1")!.activity).toBeNull();
      const a = rows.find((x) => x.id === "s-2")!.activity!;
      expect(a).toMatchObject({ kind: "test", detail: "pnpm test", stuck: false });
      expect(a).not.toHaveProperty("lastOutput");
    });

    it("returns the activity and the output of a session of this ticket, also by an id from before /clear", async () => {
      const { handle, sessionService, sessions, activities, outputs } = await setup();
      await sessionService.open({ ticketKey: "FULL-1", repoId: 1 });
      activities.set("s-1", activity("s-1"));
      outputs.set("s-1", "tail");
      const shown: Partial<SessionActivity> = activity("s-1");
      delete shown.lastOutput;
      expect(await handle({ ...base, op: "session_activity", session: "s-1" })).toEqual({ v: 1, ok: true, value: { ...shown, output: "tail", last_reply: null } });
      // /clear：旧 id 指向新 id
      await sessionService.open({ ticketKey: "FULL-1", repoId: 1 });
      sessions.setReplacedBy("s-1", "s-2");
      activities.set("s-2", activity("s-2", { kind: "ci" }));
      expect(await handle({ ...base, op: "session_activity", session: "s-1" })).toMatchObject({ ok: true, value: { sessionId: "s-2", kind: "ci" } });
    });

    it("answers a session the monitor has not seen with the same keys, all null", async () => {
      const { handle, sessionService } = await setup();
      await sessionService.open({ ticketKey: "FULL-1", repoId: 1 });
      expect(await handle({ ...base, op: "session_activity", session: "s-1" })).toEqual({
        v: 1, ok: true,
        value: { sessionId: "s-1", kind: null, detail: null, background: null, startedAt: null, lastOutputAt: null, stuck: null, reason: null, action: null, output: "", last_reply: null },
      });
    });

    it("refuses a session of another ticket and an unknown one", async () => {
      const { handle, sessionService, ticketService, web } = await setup();
      await ticketService.create({ key: "OTH-1" });
      await ticketService.addRepo({ ticketKey: "OTH-1", repoPath: web, workMode: "worktree" });
      const r = await sessionService.open({ ticketKey: "OTH-1" });
      if (!r.ok) throw new Error("did not open");
      const refused = await handle({ ...base, op: "session_activity", session: r.termId });
      expect(refused).toEqual({ v: 1, ok: false, error: expect.stringContaining(r.termId) });
      expect(await handle({ ...base, op: "session_activity", session: "nope" })).toMatchObject({ ok: false });
    });
  });

  describe("end_session (task 11)", () => {
    const waiting = (sessionId: string): SessionActivity => ({
      sessionId, kind: "waiting", detail: null, background: false, startedAt: null, lastOutputAt: 1, stuck: null, reason: null, action: null, lastOutput: [],
    });

    it("lets the ticket's coordinator end one of its sessions, but not itself or another ticket's", async () => {
      const { handle, sessionService, sessions, activities, killed, ticketService, web } = await setup();
      await sessionService.open({ ticketKey: "FULL-1", coordinator: true });
      await handle({ ...base, from: "s-1", op: "start_session", repo: web, task: "做前端" });
      await ticketService.create({ key: "OTH-1" });
      await ticketService.addRepo({ ticketKey: "OTH-1", repoPath: web, workMode: "worktree" });
      const theirs = await sessionService.open({ ticketKey: "OTH-1" });
      if (!theirs.ok) throw new Error("did not open");
      for (const id of ["s-1", "s-2", theirs.termId]) {
        sessions.setWaiting(id, true, 5);
        activities.set(id, waiting(id));
      }
      const end = (session: string) => handle({ ...base, from: "s-1", op: "end_session", session, reason: "做完了" });
      expect(await end("s-1")).toMatchObject({ ok: false, error: expect.stringContaining("找不到 session s-1") });
      expect(await end(theirs.termId)).toMatchObject({ ok: false, error: expect.stringContaining(`找不到 session ${theirs.termId}`) });
      expect(killed).toEqual([]);
      expect(await end("s-2")).toEqual({ v: 1, ok: true, value: { ended: true } });
      expect(killed).toEqual(["s-2"]);
    });
  });

  describe("refresh_session (plan 16)", () => {
    /** 总控 s-1 开了 s-2；OTH-1 另有一个 session。 */
    async function withChild() {
      const t = await setup();
      await t.sessionService.open({ ticketKey: "FULL-1", coordinator: true });
      await t.handle({ ...base, from: "s-1", op: "start_session", repo: t.web, task: "做前端" });
      await t.ticketService.create({ key: "OTH-1" });
      await t.ticketService.addRepo({ ticketKey: "OTH-1", repoPath: t.web, workMode: "worktree" });
      const theirs = await t.sessionService.open({ ticketKey: "OTH-1" });
      if (!theirs.ok) throw new Error("did not open");
      const refresh = (session: string, from: string | null = "s-1") => t.handle({ ...base, from, op: "refresh_session", session });
      return { ...t, theirs: theirs.termId, refreshSession: refresh };
    }

    it("refresh_session starts a refresh for a managed session and returns at once", async () => {
      const t = await withChild();
      // refresh 永远不结束：能拿到结果就说明没有等它。
      expect(await t.refreshSession("s-2")).toEqual({ v: 1, ok: true, value: { started: true } });
      expect(t.refresh.prechecked).toEqual([["s-2", "coordinator"]]);
      expect(t.refresh.started).toEqual([["s-2", "coordinator"]]);
      // /clear 之前的旧 id 也认：按 head 换新。
      t.sessions.insertIfAbsent({ id: "s-2b", ticketKey: "FULL-1", cwd: "/w", origin: "butler", createdAt: 2 });
      t.sessions.setReplacedBy("s-2", "s-2b", "clear");
      expect(await t.refreshSession("s-2")).toMatchObject({ ok: true });
      expect(t.refresh.started.at(-1)).toEqual(["s-2b", "coordinator"]);
    });

    it("refresh_session refuses the coordinator itself and sessions it does not manage", async () => {
      const t = await withChild();
      expect(await t.refreshSession("s-1")).toMatchObject({ ok: false, error: expect.stringContaining("找不到 session s-1") });
      expect(await t.refreshSession(t.theirs)).toMatchObject({ ok: false, error: expect.stringContaining(`找不到 session ${t.theirs}`) });
      expect(await t.refreshSession("nope")).toMatchObject({ ok: false, error: expect.stringContaining("找不到 session nope") });
      expect(t.refresh.prechecked).toEqual([]);
      expect(t.refresh.started).toEqual([]);
    });

    it("refresh_session turns a precheck refusal into an error and starts nothing", async () => {
      const t = await withChild();
      const errors: string[] = [];
      for (const refusal of ["busy", "already", "cooldown", "memory_off", "failed"] as const) {
        t.refresh.refusal = refusal;
        const r = await t.refreshSession("s-2");
        if (r.ok) throw new Error(`${refusal} was accepted`);
        expect(r.error).toContain("s-2");
        errors.push(r.error);
      }
      expect(new Set(errors).size).toBe(5);
      expect(t.refresh.started).toEqual([]);
    });
  });
});
