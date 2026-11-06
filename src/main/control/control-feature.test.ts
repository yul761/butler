import { mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import { MAX_RUNNING_PER_FEATURE } from "../../shared/control";
import { FeaturesRepo } from "../db/features-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { PtyManager } from "../sessions/pty-manager";
import { SessionService } from "../sessions/session-service";
import { fakePtyFactory, makeRepo, memDb, tempDir } from "../test-utils";
import { FeatureService } from "../tickets/feature-service";
import { TicketService } from "../tickets/ticket-service";
import { controlHandler } from "./control-handler";

async function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const settings = new SettingsRepo(db);
  const ticketService = new TicketService({ tickets, features, settings, now: () => 1, workspacesDir: tempDir("butler-ws-") });
  const featureService = new FeatureService({ features, tickets, now: () => 1 });
  const { factory, spawned } = fakePtyFactory();
  const pty = new PtyManager(factory, { data: () => undefined, exit: () => undefined });
  let n = 0;
  const activities = new Map<string, SessionActivity>();
  const sessionService = new SessionService({
    tickets, sessions, settings, ticketService, pty, features,
    activity: (id) => activities.get(id) ?? null,
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
  const killed: string[] = [];
  const needsUser = new Set<string>();
  const replies = new Map<string, string>();
  const logs: string[] = [];
  const handle = controlHandler({
    tickets, sessions, features, ticketService, sessionService,
    activity: (id) => activities.get(id) ?? null,
    activityOutput: async () => "out",
    submit: async (termId, task) => (submitted.push([termId, task]), "sent" as const),
    notify: () => void notified++,
    kill: (termId) => void killed.push(termId),
    screenNeedsUser: (termId) => needsUser.has(termId),
    lastReply: (id) => replies.get(id) ?? null,
    log: (m) => void logs.push(m),
  });
  const parent = join(tempDir("butler-code-"), "shop");
  mkdirSync(parent);
  const frontend = join(parent, "frontend");
  const backend = join(parent, "backend");
  renameSync(makeRepo(), frontend);
  renameSync(makeRepo(), backend);
  const feature = await featureService.create({ name: "checkout", repoPaths: [frontend, backend] });
  const other = await featureService.create({ name: "other", repoPaths: [frontend] });
  await ticketService.create({ key: "DMS-1", title: "Cart", featureId: feature.id, repoPaths: [frontend], workMode: "worktree" });
  await ticketService.create({ key: "DMS-2", featureId: feature.id, repoPaths: [frontend, backend], workMode: "worktree" });
  await ticketService.create({ key: "OTH-1", featureId: other.id, repoPaths: [frontend], workMode: "worktree" });
  const base = { v: 1 as const, featureId: feature.id, from: null };
  return { handle, sessionService, sessions, tickets, spawned, submitted, feature, other, base, frontend, backend, activities, notified: () => notified, killed, needsUser, replies, logs };
}

describe("controlHandler for a feature coordinator (design 2026-10-26)", () => {
  it("lists the feature's tickets with their repos", async () => {
    const { handle, base, feature } = await setup();
    const r = await handle({ ...base, op: "list_tickets" });
    expect(r).toEqual({
      v: 1, ok: true,
      value: [
        { key: "DMS-1", title: "Cart", status: "active", repos: [{ name: "frontend", dir: join(feature.workspaceDir, "frontend-dms-1"), branch: "feature/DMS-1" }] },
        {
          key: "DMS-2", title: null, status: "active",
          repos: [
            { name: "frontend", dir: join(feature.workspaceDir, "frontend-dms-2"), branch: "feature/DMS-2" },
            { name: "backend", dir: join(feature.workspaceDir, "backend-dms-2"), branch: "feature/DMS-2" },
          ],
        },
      ],
    });
  });

  it("starts a session in a single-repo ticket without naming the repo", async () => {
    const { handle, base, spawned, sessions, submitted, feature } = await setup();
    const r = await handle({ ...base, op: "start_session", ticket: "dms-1", task: "做购物车" });
    expect(r).toMatchObject({ ok: true, value: { sessionId: "s-1", ticket: "DMS-1", repo: "frontend" } });
    expect(spawned[0].opts.cwd).toBe(join(feature.workspaceDir, "frontend-dms-1"));
    expect(sessions.get("s-1")).toMatchObject({ ticketKey: "DMS-1", featureId: null });
    await new Promise((res) => setTimeout(res, 0));
    expect(submitted[0][0]).toBe("s-1");
  });

  it("passes the model to the new session in a feature", async () => {
    const { handle, base, spawned, sessions } = await setup();
    const r = await handle({ ...base, op: "start_session", ticket: "dms-1", task: "补测试", model: "opus" });
    expect(r).toMatchObject({ ok: true, value: { sessionId: "s-1", model: "opus" } });
    expect(sessions.get("s-1")).toMatchObject({ model: "opus" });
    expect(spawned[0].args).toEqual(expect.arrayContaining(["--model", "opus"]));
  });

  it("asks for the repo when the ticket has several, and accepts it by name", async () => {
    const { handle, base } = await setup();
    const r = await handle({ ...base, op: "start_session", ticket: "DMS-2", task: "x" });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain("frontend, backend");
    expect(await handle({ ...base, op: "start_session", ticket: "DMS-2", repo: "backend", task: "x" })).toMatchObject({ ok: true, value: { repo: "backend" } });
  });

  it("refuses a ticket of another feature, an archived ticket and an archived feature", async () => {
    const { handle, base, tickets } = await setup();
    const r = await handle({ ...base, op: "start_session", ticket: "OTH-1", task: "x" });
    expect(!r.ok && r.error).toContain("这个 feature 下没有 ticket OTH-1");
    expect(!r.ok && r.error).toContain("DMS-1, DMS-2");
    tickets.archive("DMS-1", 5);
    expect(await handle({ ...base, op: "start_session", ticket: "DMS-1", task: "x" })).toMatchObject({ ok: false });
    expect(await handle({ ...base, featureId: 999, op: "list_tickets" })).toMatchObject({ ok: false });
  });

  it("stops at the feature's terminal limit", async () => {
    const { handle, base, sessionService, feature } = await setup();
    await sessionService.openFeature({ featureId: feature.id });
    // 单个 ticket 最多 6 个：分到两个 ticket 上，先碰到的是 feature 的上限。
    for (let i = 1; i < MAX_RUNNING_PER_FEATURE; i++) {
      const target = i <= 4 ? { ticket: "DMS-1" } : { ticket: "DMS-2", repo: "backend" };
      expect(await handle({ ...base, op: "start_session", ...target, task: `t${i}` }), String(i)).toMatchObject({ ok: true });
    }
    expect(sessionService.featureTerminalCount(feature.id)).toBe(MAX_RUNNING_PER_FEATURE);
    const r = await handle({ ...base, op: "start_session", ticket: "DMS-1", task: "one more" });
    expect(!r.ok && r.error).toContain(`${MAX_RUNNING_PER_FEATURE} 个终端`);
  });

  it("records the spawner only when it is this feature's coordinator", async () => {
    const { handle, base, sessionService, sessions, feature, other } = await setup();
    const mine = await sessionService.openFeature({ featureId: feature.id });
    const theirs = await sessionService.openFeature({ featureId: other.id });
    if (!mine.ok || !theirs.ok) throw new Error("coordinators did not open");
    await handle({ ...base, from: mine.termId, op: "start_session", ticket: "DMS-1", task: "a" });
    await handle({ ...base, from: theirs.termId, op: "start_session", ticket: "DMS-1", task: "b" });
    const started = sessions.listByTicket("DMS-1");
    expect(started.map((s) => s.spawnedBy).sort()).toEqual([mine.termId, null].sort());
  });

  it("lists the coordinator and every ticket's sessions with the ticket they belong to", async () => {
    const { handle, base, sessionService, feature } = await setup();
    const c = await sessionService.openFeature({ featureId: feature.id });
    if (!c.ok) throw new Error("no coordinator");
    await handle({ ...base, from: c.termId, op: "start_session", ticket: "DMS-1", task: "a" });
    const r = await handle({ ...base, op: "list_sessions" });
    if (!r.ok) throw new Error(r.error);
    const rows = r.value as { id: string; ticket: string | null; repo: string | null; startedByCoordinator: boolean }[];
    expect(rows.map((x) => [x.ticket, x.repo, x.startedByCoordinator]).sort()).toEqual([
      ["DMS-1", basename(join("x", "frontend")), true],
      [null, "总控", false],
    ].sort());
  });

  it("lists the feature's repos", async () => {
    const { handle, base, frontend, backend } = await setup();
    expect(await handle({ ...base, op: "list_repos" })).toEqual({ v: 1, ok: true, value: [{ name: "frontend", path: frontend }, { name: "backend", path: backend }] });
  });

  it("creates a ticket in the chosen repos, inside the feature's workspace, and starts a session in it", async () => {
    const { handle, base, feature, tickets, spawned, notified } = await setup();
    const r = await handle({ ...base, op: "create_ticket", ticket: "dms-3", title: "Payment", repos: ["Backend"] });
    expect(r).toEqual({
      v: 1, ok: true,
      value: {
        key: "DMS-3", title: "Payment",
        repos: [{ name: "backend", dir: join(feature.workspaceDir, "backend-dms-3"), branch: "feature/DMS-3" }],
        note: expect.stringContaining("start_session"),
      },
    });
    expect(tickets.get("DMS-3")).toMatchObject({ featureId: feature.id, title: "Payment" });
    expect(notified()).toBe(1);
    expect(await handle({ ...base, op: "start_session", ticket: "DMS-3", task: "做支付" })).toMatchObject({ ok: true, value: { ticket: "DMS-3", repo: "backend" } });
    expect(spawned.at(-1)!.opts.cwd).toBe(join(feature.workspaceDir, "backend-dms-3"));
  });

  it("takes the only repo of a single-repo feature, and a branch name", async () => {
    const { handle, other } = await setup();
    const r = await handle({ v: 1, featureId: other.id, from: null, op: "create_ticket", ticket: "OTH-2", branch: "oth/two" });
    expect(r).toMatchObject({ ok: true, value: { key: "OTH-2", repos: [{ name: "frontend", branch: "oth/two" }] } });
  });

  it("explains what is wrong instead of creating anything", async () => {
    const { handle, base, tickets, notified } = await setup();
    const err = async (req: object) => {
      const r = await handle({ ...base, op: "create_ticket", ticket: "DMS-4", ...req });
      if (r.ok) throw new Error("created");
      return r.error;
    };
    expect(await err({})).toContain("frontend, backend");
    expect(await err({ repos: ["mobile"] })).toContain("这个 feature 没有仓库 mobile");
    expect(await err({ ticket: "cart work", repos: ["frontend"] })).toContain("[A-Z][A-Z0-9]+-\\d+");
    expect(await err({ ticket: "DMS-1", repos: ["frontend"] })).toContain("DMS-1");
    expect(tickets.get("DMS-4")).toBeNull();
    expect(notified()).toBe(0);
    expect(await handle({ ...base, featureId: 999, op: "create_ticket", ticket: "DMS-4" })).toMatchObject({ ok: false });
  });

  it("lists an activity per session and reads one live, for the coordinator and for a ticket's session", async () => {
    const { handle, base, sessionService, feature, activities } = await setup();
    const c = await sessionService.openFeature({ featureId: feature.id });
    if (!c.ok) throw new Error("no coordinator");
    const child = await handle({ ...base, from: c.termId, op: "start_session", ticket: "DMS-1", task: "a" });
    const id = child.ok ? (child.value as { sessionId: string }).sessionId : "";
    activities.set(id, { sessionId: id, kind: "command", detail: "sleep 99", background: false, startedAt: 1, lastOutputAt: 2, stuck: true, reason: "r", action: "a", lastOutput: ["x"] });
    const listed = await handle({ ...base, op: "list_sessions" });
    const rows = (listed.ok ? listed.value : []) as { id: string; activity: { stuck: boolean | null } | null }[];
    expect(rows.find((x) => x.id === id)!.activity).toMatchObject({ stuck: true });
    expect(rows.find((x) => x.id === id)!.activity).not.toHaveProperty("lastOutput");
    expect(rows.find((x) => x.id === c.termId)!.activity).toBeNull();
    expect(await handle({ ...base, op: "session_activity", session: id })).toMatchObject({ ok: true, value: { kind: "command", stuck: true, output: "out" } });
    expect(await handle({ ...base, op: "session_activity", session: c.termId })).toMatchObject({ ok: true });
  });

  it("lists a fix session with the session it fixes, and lets the coordinator read one in its own feature", async () => {
    const { handle, base, sessions, sessionService, feature, other, activities } = await setup();
    const c = await sessionService.openFeature({ featureId: feature.id });
    if (!c.ok) throw new Error("no coordinator");
    const child = await handle({ ...base, op: "start_session", ticket: "DMS-1", task: "a" });
    if (!child.ok) throw new Error(child.error);
    const stuck = (child.value as { sessionId: string }).sessionId;
    sessions.insertIfAbsent({ id: "fix", ticketKey: null, cwd: feature.workspaceDir, origin: "butler", createdAt: 1, featureId: feature.id, fixesSession: stuck });
    sessions.insertIfAbsent({ id: "their-fix", ticketKey: null, cwd: other.workspaceDir, origin: "butler", createdAt: 1, featureId: other.id, fixesSession: "stuck-2" });
    activities.set("fix", { sessionId: "fix", kind: "command", detail: null, background: false, startedAt: 1, lastOutputAt: 2, stuck: null, reason: null, action: null, lastOutput: [] });
    const rows = async () => {
      const r = await handle({ ...base, op: "list_sessions" });
      if (!r.ok) throw new Error(r.error);
      return (r.value as { id: string; ticket: string | null; repo: string | null; fixes: string | null }[]).map((x) => [x.id, x.ticket, x.repo, x.fixes]);
    };
    const fixRow = (fixes: string) => ["fix", null, null, fixes];
    const coordinatorRow = [c.termId, null, "总控", null];
    expect(await rows()).toEqual(expect.arrayContaining([coordinatorRow, fixRow(stuck), [stuck, "DMS-1", "frontend", null]]));
    expect(await rows()).toHaveLength(3);
    // 卡住的 session /clear 之后，fixes 还能对上列表里的 id
    sessions.insertIfAbsent({ id: "stuck-new", ticketKey: "DMS-1", cwd: "/w", origin: "butler", createdAt: 2 });
    sessions.setReplacedBy(stuck, "stuck-new");
    expect(await rows()).toEqual(expect.arrayContaining([fixRow("stuck-new"), ["stuck-new", "DMS-1", "frontend", null]]));
    expect(await handle({ ...base, op: "session_activity", session: "fix" })).toMatchObject({ ok: true, value: { sessionId: "fix", kind: "command", output: "out" } });
    expect(await handle({ ...base, op: "session_activity", session: "their-fix" })).toEqual({ v: 1, ok: false, error: expect.stringContaining("their-fix") });
  });

  it("does not record a fix session as the spawner of a child session", async () => {
    const { handle, base, sessions, feature } = await setup();
    sessions.insertIfAbsent({ id: "fix", ticketKey: null, cwd: feature.workspaceDir, origin: "butler", createdAt: 1, featureId: feature.id, fixesSession: "stuck-1" });
    const r = await handle({ ...base, from: "fix", op: "start_session", ticket: "DMS-1", task: "a" });
    if (!r.ok) throw new Error("did not open");
    expect(sessions.get((r.value as { sessionId: string }).sessionId)?.spawnedBy).toBeNull();
  });

  it("refuses to read a session of another feature or of a ticket outside this feature", async () => {
    const { handle, base, sessionService, other, feature } = await setup();
    const theirs = await sessionService.openFeature({ featureId: other.id });
    const oth = await handle({ v: 1, featureId: other.id, from: null, op: "start_session", ticket: "OTH-1", task: "b" });
    if (!theirs.ok || !oth.ok) throw new Error("did not open");
    const ticketSession = (oth.value as { sessionId: string }).sessionId;
    for (const session of [theirs.termId, ticketSession]) {
      const r = await handle({ ...base, featureId: feature.id, op: "session_activity", session });
      expect(r).toEqual({ v: 1, ok: false, error: expect.stringContaining(session) });
    }
    expect(await handle({ ...base, op: "session_activity", session: "nope" })).toMatchObject({ ok: false });
  });
});

describe("end_session from a feature coordinator (task 11)", () => {
  const idle = (id: string, kind: SessionActivity["kind"] = "waiting"): SessionActivity => ({
    sessionId: id, kind, detail: null, background: false, startedAt: null, lastOutputAt: 1, stuck: null, reason: null, action: null, lastOutput: [],
  });

  /** feature 总控开着，DMS-1 有一个停下来在等输入的子 session。 */
  async function withChild() {
    const t = await setup();
    const c = await t.sessionService.openFeature({ featureId: t.feature.id });
    if (!c.ok) throw new Error("no coordinator");
    const r = await t.handle({ ...t.base, from: c.termId, op: "start_session", ticket: "DMS-1", task: "a" });
    if (!r.ok) throw new Error(r.error);
    const child = (r.value as { sessionId: string }).sessionId;
    t.sessions.setWaiting(child, true, 5);
    t.activities.set(child, idle(child));
    const end = (session: string, from: string | null = c.termId) => t.handle({ ...t.base, from, op: "end_session", session, reason: "PR 已合并" });
    return { ...t, coordinator: c.termId, child, end };
  }

  it("ends a ticket session that stopped and waits for input, the same as the user clicking ×", async () => {
    const { end, child, killed, logs, sessions, coordinator } = await withChild();
    expect(await end(child)).toEqual({ v: 1, ok: true, value: { ended: true } });
    expect(killed).toEqual([child]);
    expect(logs).toContain(`end_session ${child} by ${coordinator}: PR 已合并`);
    // 记录都在：session 没删、没隐藏
    expect(sessions.get(child)).toMatchObject({ dismissed: false, replacedBy: null });
  });

  it("also ends an idle session", async () => {
    const { end, child, killed, activities } = await withChild();
    activities.set(child, idle(child, "idle"));
    expect(await end(child)).toMatchObject({ ok: true });
    expect(killed).toEqual([child]);
  });

  it("refuses a session that is working, or not waiting for input, or not seen yet", async () => {
    const { end, child, killed, activities, sessions } = await withChild();
    activities.set(child, idle(child, "test"));
    expect(await end(child)).toEqual({ v: 1, ok: false, error: `session ${child} 正在干活（test），不能结束` });
    activities.set(child, idle(child));
    sessions.setWaiting(child, false, 6);
    expect(await end(child)).toMatchObject({ ok: false, error: expect.stringContaining("正在干活") });
    sessions.setWaiting(child, true, 7);
    activities.delete(child);
    expect(await end(child)).toMatchObject({ ok: false, error: expect.stringContaining("正在干活") });
    expect(killed).toEqual([]);
  });

  it("refuses a session with a permission prompt or a startup dialog on screen", async () => {
    const { end, child, killed, needsUser } = await withChild();
    needsUser.add(child);
    expect(await end(child)).toEqual({ v: 1, ok: false, error: `session ${child} 的屏幕上有一个等用户回答的确认，不能结束` });
    expect(killed).toEqual([]);
  });

  it("refuses a session whose terminal is not open", async () => {
    const { end, killed, sessions } = await withChild();
    sessions.insertIfAbsent({ id: "old", ticketKey: "DMS-1", cwd: "/w", origin: "butler", createdAt: 1 });
    sessions.setWaiting("old", true, 5);
    expect(await end("old")).toEqual({ v: 1, ok: false, error: "session old 已经结束了" });
    expect(killed).toEqual([]);
  });

  it("refuses itself, the feature's coordinators and sessions of another feature", async () => {
    const { end, handle, coordinator, killed, other, sessionService, activities, sessions } = await withChild();
    const theirs = await handle({ v: 1, featureId: other.id, from: null, op: "start_session", ticket: "OTH-1", task: "b" });
    const theirCoordinator = await sessionService.openFeature({ featureId: other.id });
    if (!theirs.ok || !theirCoordinator.ok) throw new Error("did not open");
    const theirChild = (theirs.value as { sessionId: string }).sessionId;
    for (const id of [coordinator, theirChild, theirCoordinator.termId]) {
      sessions.setWaiting(id, true, 5);
      activities.set(id, idle(id));
      expect(await end(id), id).toEqual({ v: 1, ok: false, error: expect.stringContaining(`找不到 session ${id}`) });
    }
    expect(await end("nope")).toMatchObject({ ok: false });
    expect(killed).toEqual([]);
  });

  it("ends a fix session of this feature", async () => {
    const { end, child, feature, sessionService, sessions, activities, killed } = await withChild();
    const fix = await sessionService.openFix({ featureId: feature.id, stuckSessionId: child });
    if (!fix.ok) throw new Error(`no fix: ${fix.reason}`);
    expect(sessions.get(fix.termId)).toMatchObject({ featureId: feature.id, fixesSession: child });
    sessions.setWaiting(fix.termId, true, 5);
    activities.set(fix.termId, idle(fix.termId));
    expect(await end(fix.termId)).toMatchObject({ ok: true });
    expect(killed).toEqual([fix.termId]);
  });

  it("ends a session by an id from before /clear, killing the terminal that runs it", async () => {
    const { end, child, killed, sessions, activities } = await withChild();
    sessions.insertIfAbsent({ id: "after-clear", ticketKey: "DMS-1", cwd: "/w", origin: "butler", createdAt: 2 });
    sessions.setReplacedBy(child, "after-clear");
    sessions.setWaiting("after-clear", true, 5);
    activities.set("after-clear", idle("after-clear"));
    expect(await end(child)).toMatchObject({ ok: true });
    expect(killed).toEqual([child]);
  });

  it("gives every listed session and session_activity the end of its last reply", async () => {
    const { handle, base, child, coordinator, replies } = await withChild();
    replies.set(child, "PR 已经合并了。");
    const r = await handle({ ...base, op: "list_sessions" });
    const rows = (r.ok ? r.value : []) as { id: string; last_reply: string | null }[];
    expect(rows.find((x) => x.id === child)!.last_reply).toBe("PR 已经合并了。");
    expect(rows.find((x) => x.id === coordinator)!.last_reply).toBeNull();
    expect(await handle({ ...base, op: "session_activity", session: child })).toMatchObject({ ok: true, value: { last_reply: "PR 已经合并了。" } });
  });
});
