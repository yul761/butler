import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import { BlocksRepo } from "../db/blocks-repo";
import { FeaturesRepo } from "../db/features-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { PtyManager } from "../sessions/pty-manager";
import { SessionService } from "../sessions/session-service";
import { fakePtyFactory, makeRepo, memDb, tempDir } from "../test-utils";
import { FeatureService } from "../tickets/feature-service";
import { TicketService } from "../tickets/ticket-service";
import { controlHandler, type ControlHandlerDeps } from "./control-handler";
import type { SendInput } from "../mailbox/mailbox";
import { StackControl, type StackControlDeps } from "./stack-control";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function setup(opts: {
  stacks?: (d: { tickets: TicketsRepo; features: FeaturesRepo }) => StackControl;
  mailState?: "busy" | "idle" | "closed";
  resume?: ControlHandlerDeps["resume"];
  wakeState?: ControlHandlerDeps["wakeState"];
} = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const settings = new SettingsRepo(db);
  const blocks = new BlocksRepo(db);
  const ticketService = new TicketService({ tickets, features, settings, now: () => 1, workspacesDir: tempDir("shipherd-ws-") });
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
  const refreshed: string[] = [];
  const mailed: SendInput[] = [];
  const mailbox = {
    send: (x: SendInput) => (mailed.push(x), { id: `m${mailed.length}`, state: opts.mailState ?? ("busy" as const) }),
    opened: async () => true,
    views: () => [],
  };
  const handle = controlHandler({
    mailbox,
    tickets, sessions, features, blocks, ticketService, sessionService,
    refresher: { precheck: () => null, refresh: async (id) => (refreshed.push(id), "done" as const) },
    activity: (id) => activities.get(id) ?? null,
    activityOutput: async () => "out",
    submit: async (termId, task) => (submitted.push([termId, task]), "sent" as const),
    notify: () => void notified++,
    kill: (termId) => void killed.push(termId),
    screenNeedsUser: (termId) => needsUser.has(termId),
    lastReply: (id) => replies.get(id) ?? null,
    ...(opts.stacks && { stacks: opts.stacks({ tickets, features }) }),
    ...(opts.resume && { resume: opts.resume }),
    ...(opts.wakeState && { wakeState: opts.wakeState }),
    log: (m) => void logs.push(m),
  });
  const parent = join(tempDir("shipherd-code-"), "shop");
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
  return { handle, blocks, sessionService, sessions, tickets, spawned, submitted, feature, other, base, frontend, backend, activities, notified: () => notified, killed, needsUser, replies, logs, refreshed, mailed };
}

describe("controlHandler for a feature coordinator (design 2026-10-26)", () => {
  it("lists the feature's tickets with their repos", async () => {
    const { handle, base, feature } = await setup();
    const r = await handle({ ...base, op: "list_tickets" });
    expect(r).toEqual({
      v: 1, ok: true,
      value: [
        { key: "DMS-1", title: "Cart", status: "active", feature: null, repos: [{ name: "frontend", dir: join(feature.workspaceDir, "frontend-dms-1"), branch: "feature/DMS-1" }] },
        {
          key: "DMS-2", title: null, status: "active", feature: null,
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
    expect(!r.ok && r.error).toContain("这个 epic 下没有 ticket OTH-1");
    expect(!r.ok && r.error).toContain("DMS-1, DMS-2");
    tickets.archive("DMS-1", 5);
    expect(await handle({ ...base, op: "start_session", ticket: "DMS-1", task: "x" })).toMatchObject({ ok: false });
    expect(await handle({ ...base, featureId: 999, op: "list_tickets" })).toMatchObject({ ok: false });
  });

  it("has no per-feature cap any more (workstream W: only memory decides)", async () => {
    const { handle, base, sessionService, feature } = await setup();
    await sessionService.openFeature({ featureId: feature.id });
    // 以前每个 feature 最多 8 个终端（总控也算）：现在没接内存准入时一直放行。
    for (let i = 1; i <= 9; i++) {
      const target = i % 2 ? { ticket: "DMS-1" } : { ticket: "DMS-2", repo: "backend" };
      expect(await handle({ ...base, op: "start_session", ...target, task: `t${i}` }), String(i)).toMatchObject({ ok: true });
    }
    expect(sessionService.featureTerminalCount(feature.id)).toBe(10);
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

  it("stacks a new ticket on another: the branch starts from the parent's branch (workstream K)", async () => {
    const calls: { canStackOn: [string, string][]; stackOn: object[] } = { canStackOn: [], stackOn: [] };
    const service = {
      canStackOn: (repoPath: string, branch: string) => (calls.canStackOn.push([repoPath, branch]), { ok: true as const }),
      stackOn: async (p: object) => (calls.stackOn.push(p), { ok: true as const }),
    } as unknown as StackControlDeps["service"];
    const { handle, base, feature, frontend } = await setup({ stacks: (d) => new StackControl({ service, tickets: () => d.tickets.list(), features: d.features }) });
    // 父 ticket 的分支上先有一个提交
    const parentDir = join(feature.workspaceDir, "frontend-dms-1");
    writeFileSync(join(parentDir, "cart.txt"), "cart");
    git(parentDir, "add", ".");
    git(parentDir, "commit", "-qm", "cart");
    const parentHead = git(parentDir, "rev-parse", "HEAD");
    const r = await handle({ ...base, op: "create_ticket", ticket: "DMS-5", repos: ["frontend"], stack_on: "dms-1" });
    expect(r).toMatchObject({ ok: true, value: { key: "DMS-5", stacked: true } });
    expect(git(join(feature.workspaceDir, "frontend-dms-5"), "rev-parse", "HEAD")).toBe(parentHead);
    expect(calls.canStackOn).toEqual([[frontend, "feature/DMS-1"]]);
    expect(calls.stackOn).toEqual([{ repoPath: frontend, parentBranch: "feature/DMS-1", branch: "feature/DMS-5", featureId: feature.id }]);
    // 父 ticket 不在这个 feature、或者没有这个仓库：什么都不建
    expect(await handle({ ...base, op: "create_ticket", ticket: "DMS-6", repos: ["frontend"], stack_on: "OTH-1" })).toMatchObject({ ok: false });
    expect(await handle({ ...base, op: "create_ticket", ticket: "DMS-6", repos: ["backend"], stack_on: "DMS-1" })).toMatchObject({ ok: false });
  });

  it("says stacks are not available when the handler has none", async () => {
    const { handle, base, tickets } = await setup();
    expect(await handle({ ...base, op: "create_ticket", ticket: "DMS-7", repos: ["frontend"], stack_on: "DMS-1" })).toMatchObject({ ok: false });
    expect(await handle({ ...base, op: "list_stacks" })).toMatchObject({ ok: false });
    expect(tickets.get("DMS-7")).toBeNull();
  });

  it("explains what is wrong instead of creating anything", async () => {
    const { handle, base, tickets, notified } = await setup();
    const err = async (req: object) => {
      const r = await handle({ ...base, op: "create_ticket", ticket: "DMS-4", ...req });
      if (r.ok) throw new Error("created");
      return r.error;
    };
    expect(await err({})).toContain("frontend, backend");
    expect(await err({ repos: ["mobile"] })).toContain("这个 epic 没有仓库 mobile");
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
    sessions.insertIfAbsent({ id: "fix", ticketKey: null, cwd: feature.workspaceDir, origin: "shipherd", createdAt: 1, featureId: feature.id, fixesSession: stuck });
    sessions.insertIfAbsent({ id: "their-fix", ticketKey: null, cwd: other.workspaceDir, origin: "shipherd", createdAt: 1, featureId: other.id, fixesSession: "stuck-2" });
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
    sessions.insertIfAbsent({ id: "stuck-new", ticketKey: "DMS-1", cwd: "/w", origin: "shipherd", createdAt: 2 });
    sessions.setReplacedBy(stuck, "stuck-new");
    expect(await rows()).toEqual(expect.arrayContaining([fixRow("stuck-new"), ["stuck-new", "DMS-1", "frontend", null]]));
    expect(await handle({ ...base, op: "session_activity", session: "fix" })).toMatchObject({ ok: true, value: { sessionId: "fix", kind: "command", output: "out" } });
    expect(await handle({ ...base, op: "session_activity", session: "their-fix" })).toEqual({ v: 1, ok: false, error: expect.stringContaining("their-fix") });
  });

  it("does not record a fix session as the spawner of a child session", async () => {
    const { handle, base, sessions, feature } = await setup();
    sessions.insertIfAbsent({ id: "fix", ticketKey: null, cwd: feature.workspaceDir, origin: "shipherd", createdAt: 1, featureId: feature.id, fixesSession: "stuck-1" });
    const r = await handle({ ...base, from: "fix", op: "start_session", ticket: "DMS-1", task: "a" });
    if (!r.ok) throw new Error("did not open");
    expect(sessions.get((r.value as { sessionId: string }).sessionId)?.spawnedBy).toBeNull();
  });

  it("send_message queues a message for a ticket or fix session of this feature, never refusing a busy one (BTL-245)", async () => {
    const { handle, base, sessions, sessionService, feature, mailed } = await setup();
    const c = await sessionService.openFeature({ featureId: feature.id });
    if (!c.ok) throw new Error("no coordinator");
    const child = await handle({ ...base, op: "start_session", ticket: "DMS-1", task: "a" });
    if (!child.ok) throw new Error(child.error);
    const kid = (child.value as { sessionId: string }).sessionId;
    sessions.insertIfAbsent({ id: "fix", ticketKey: null, cwd: feature.workspaceDir, origin: "shipherd", createdAt: 1, featureId: feature.id, fixesSession: kid });
    const from = { ...base, from: c.termId };
    const r = await handle({ ...from, op: "send_message", session: kid, text: "接口改了", interrupt: true });
    expect(r).toMatchObject({ ok: true, value: { queued: true, sessionId: kid, requestId: "m1", state: "busy" } });
    expect(mailed[0]).toMatchObject({ kind: "instruction", from: c.termId, to: kid, featureId: feature.id, interrupt: true });
    expect(mailed[0].body).toContain("接口改了");
    expect(mailed[0].body).toContain("checkout");
    expect(await handle({ ...from, op: "send_message", session: "fix", text: "x" })).toMatchObject({ ok: true, value: { sessionId: "fix" } });
    expect(mailed[1]).toMatchObject({ to: "fix", interrupt: false });
    // /clear 之后旧 id 也能用：发给链上最新的那个。
    sessions.insertIfAbsent({ id: "kid-new", ticketKey: "DMS-1", cwd: "/w", origin: "shipherd", createdAt: 2 });
    sessions.setReplacedBy(kid, "kid-new");
    expect(await handle({ ...from, op: "send_message", session: kid, text: "y" })).toMatchObject({ ok: true, value: { sessionId: "kid-new" } });
  });

  it("send_message to a closed session says whether Shipherd is resuming it, waiting for memory, or the user ended it (BTL-256)", async () => {
    const answers: Record<string, Awaited<ReturnType<NonNullable<ControlHandlerDeps["resume"]>>>> = {};
    const asked: string[] = [];
    const { handle, base, sessionService, feature, sessions } = await setup({
      mailState: "closed",
      resume: async (id) => (asked.push(id), answers[id] ?? null),
      wakeState: (id) => (id === "fix" ? "ended_by_user" : "resumes"),
    });
    const c = await sessionService.openFeature({ featureId: feature.id });
    if (!c.ok) throw new Error("no coordinator");
    const from = { ...base, from: c.termId };
    for (const id of ["a", "b", "fix", "d"]) {
      sessions.insertIfAbsent({ id, ticketKey: null, cwd: feature.workspaceDir, origin: "shipherd", createdAt: 1, featureId: feature.id, fixesSession: "x" });
    }
    answers.a = { state: "resuming" };
    answers.b = { state: "waiting_memory", error: "only 1 GB free" };
    answers.fix = { state: "ended_by_user" };
    answers.d = { state: "running" };
    const a = await handle({ ...from, op: "send_message", session: "a", text: "x" });
    expect(a).toMatchObject({ ok: true, value: { state: "closed", wake: "resuming" } });
    expect((a as { value: { note: string } }).value.note).toContain("后台恢复");
    expect(await handle({ ...from, op: "send_message", session: "b", text: "x" }))
      .toMatchObject({ ok: true, value: { wake: "waiting_memory", wakeError: "only 1 GB free" } });
    expect(await handle({ ...from, op: "send_message", session: "fix", text: "x" })).toMatchObject({ ok: true, value: { wake: "ended_by_user" } });
    // 恢复的时候发现已经开着了：按开着的说。
    const d = await handle({ ...from, op: "send_message", session: "d", text: "x" });
    expect(d).toMatchObject({ ok: true, value: { state: "idle" } });
    expect((d as { value: object }).value).not.toHaveProperty("wake");
    expect(asked).toEqual(["a", "b", "fix", "d"]);
    const rows = await handle({ ...from, op: "list_sessions" });
    if (!rows.ok) throw new Error(rows.error);
    const byId = new Map((rows.value as { id: string; wake?: string }[]).map((r) => [r.id, r.wake]));
    expect(byId.get("fix")).toBe("ended_by_user");
    expect(byId.get("a")).toBe("resumes");
  });

  it("send_message refuses sessions outside this feature, the coordinator itself, and callers that are not its coordinator (BTL-245)", async () => {
    const { handle, base, sessionService, feature, other, mailed } = await setup();
    const c = await sessionService.openFeature({ featureId: feature.id });
    const theirs = await sessionService.openFeature({ featureId: other.id });
    if (!c.ok || !theirs.ok) throw new Error("no coordinator");
    const otherChild = await handle({ v: 1, featureId: other.id, from: null, op: "start_session", ticket: "OTH-1", task: "a" });
    const mine = await handle({ ...base, op: "start_session", ticket: "DMS-1", task: "a" });
    if (!otherChild.ok || !mine.ok) throw new Error("did not open");
    const theirKid = (otherChild.value as { sessionId: string }).sessionId;
    const kid = (mine.value as { sessionId: string }).sessionId;
    for (const session of [theirKid, c.termId, "nope"]) {
      expect(await handle({ ...base, from: c.termId, op: "send_message", session, text: "x" })).toMatchObject({ ok: false, error: expect.stringContaining(session) });
    }
    // 只有这个 feature 的总控能发：别的 feature 的总控、子 session、认不出来的调用方都不行。
    for (const from of [theirs.termId, kid, null]) {
      expect(await handle({ ...base, from, op: "send_message", session: kid, text: "x" })).toMatchObject({ ok: false });
    }
    expect(mailed).toEqual([]);
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
    sessions.insertIfAbsent({ id: "old", ticketKey: "DMS-1", cwd: "/w", origin: "shipherd", createdAt: 1 });
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
    sessions.insertIfAbsent({ id: "after-clear", ticketKey: "DMS-1", cwd: "/w", origin: "shipherd", createdAt: 2 });
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

describe("refresh_session from a feature coordinator (plan 16)", () => {
  it("refreshes a ticket session of this feature, and not itself or another feature's sessions", async () => {
    const t = await setup();
    const c = await t.sessionService.openFeature({ featureId: t.feature.id });
    const theirCoordinator = await t.sessionService.openFeature({ featureId: t.other.id });
    if (!c.ok || !theirCoordinator.ok) throw new Error("no coordinator");
    const mine = await t.handle({ ...t.base, from: c.termId, op: "start_session", ticket: "DMS-1", task: "a" });
    const theirs = await t.handle({ v: 1, featureId: t.other.id, from: null, op: "start_session", ticket: "OTH-1", task: "b" });
    if (!mine.ok || !theirs.ok) throw new Error("did not open");
    const child = (mine.value as { sessionId: string }).sessionId;
    const theirChild = (theirs.value as { sessionId: string }).sessionId;
    const refresh = (session: string) => t.handle({ ...t.base, from: c.termId, op: "refresh_session", session });
    for (const id of [c.termId, theirChild, theirCoordinator.termId]) {
      expect(await refresh(id), id).toMatchObject({ ok: false, error: expect.stringContaining(`找不到 session ${id}`) });
    }
    expect(t.refreshed).toEqual([]);
    expect(await refresh(child)).toEqual({ v: 1, ok: true, value: { started: true } });
    expect(t.refreshed).toEqual([child]);
  });
});

describe("features inside an epic: blocks (BTL-246)", () => {
  const names = (r: unknown) => ((r as { value: { features: { name: string }[] } }).value.features).map((f) => f.name);

  it("creates features in order, before another when asked, and refuses a duplicate name", async () => {
    const { handle, base, notified } = await setup();
    expect(await handle({ ...base, op: "create_feature", name: "Payment", description: "cards first" })).toMatchObject({ ok: true, value: { name: "Payment" } });
    await handle({ ...base, op: "create_feature", name: "Shipping" });
    await handle({ ...base, op: "create_feature", name: "Refunds", before: "shipping" });
    expect(notified()).toBe(3);
    const r = await handle({ ...base, op: "list_features" });
    expect(names(r)).toEqual(["Payment", "Refunds", "Shipping"]);
    expect(r).toMatchObject({ ok: true, value: { features: [{ name: "Payment", description: "cards first", position: 1, tickets: [], merged: 0, total: 0 }, {}, {}], notInAFeature: [{ key: "DMS-1" }, { key: "DMS-2" }] } });
    const dup = await handle({ ...base, op: "create_feature", name: " payment " });
    expect(dup).toMatchObject({ ok: false });
    expect((dup as { error: string }).error).toContain("Payment");
    expect(await handle({ ...base, op: "create_feature", name: "X", before: "nope" })).toMatchObject({ ok: false });
    expect(names(await handle({ ...base, op: "list_features" }))).toEqual(["Payment", "Refunds", "Shipping"]);
  });

  it("keeps features apart per epic", async () => {
    const { handle, base, other } = await setup();
    await handle({ ...base, op: "create_feature", name: "Payment" });
    expect(await handle({ v: 1, featureId: other.id, from: null, op: "create_feature", name: "Payment" })).toMatchObject({ ok: true });
    expect(names(await handle({ v: 1, featureId: other.id, from: null, op: "list_features" }))).toEqual(["Payment"]);
  });

  it("moves a ticket into a feature and out again; list_features and list_tickets show it", async () => {
    const { handle, base, tickets } = await setup();
    await handle({ ...base, op: "create_feature", name: "Payment" });
    expect(await handle({ ...base, op: "set_ticket_feature", ticket: "dms-2", feature: "payment" })).toMatchObject({ ok: true, value: { ticket: "DMS-2", feature: "Payment" } });
    expect(tickets.get("DMS-2")!.blockId).not.toBeNull();
    expect(await handle({ ...base, op: "list_features" })).toMatchObject({
      ok: true, value: { features: [{ name: "Payment", tickets: [{ key: "DMS-2", title: null, status: "active" }], merged: 0, total: 1 }], notInAFeature: [{ key: "DMS-1" }] },
    });
    expect(await handle({ ...base, op: "list_tickets" })).toMatchObject({ ok: true, value: [{ key: "DMS-1", feature: null }, { key: "DMS-2", feature: "Payment" }] });
    expect(await handle({ ...base, op: "set_ticket_feature", ticket: "DMS-2", feature: null })).toMatchObject({ ok: true, value: { ticket: "DMS-2", feature: null } });
    expect(tickets.get("DMS-2")!.blockId).toBeNull();
  });

  it("counts a done ticket and refers to a feature by id", async () => {
    const { handle, base, tickets } = await setup();
    const made = await handle({ ...base, op: "create_feature", name: "Payment" });
    const id = String((made as { value: { id: number } }).value.id);
    tickets.setStatus("DMS-1", "done", 1);
    await handle({ ...base, op: "set_ticket_feature", ticket: "DMS-1", feature: id });
    expect(await handle({ ...base, op: "list_features" })).toMatchObject({ ok: true, value: { features: [{ name: "Payment", merged: 1, total: 1 }] } });
  });

  it("refuses a ticket of another epic and a feature that does not exist or belongs to another epic", async () => {
    const { handle, base, other } = await setup();
    await handle({ ...base, op: "create_feature", name: "Payment" });
    const theirs = await handle({ v: 1, featureId: other.id, from: null, op: "create_feature", name: "Theirs" });
    const theirId = String((theirs as { value: { id: number } }).value.id);
    expect(await handle({ ...base, op: "set_ticket_feature", ticket: "OTH-1", feature: "Payment" })).toMatchObject({ ok: false });
    expect(await handle({ ...base, op: "set_ticket_feature", ticket: "DMS-1", feature: "Nope" })).toMatchObject({ ok: false });
    expect(await handle({ ...base, op: "set_ticket_feature", ticket: "DMS-1", feature: theirId })).toMatchObject({ ok: false });
  });

  it("reorders when every feature is named exactly once", async () => {
    const { handle, base } = await setup();
    for (const name of ["A", "B", "C"]) await handle({ ...base, op: "create_feature", name });
    expect(await handle({ ...base, op: "reorder_features", order: ["c", "A", "b"] })).toMatchObject({ ok: true, value: { order: ["C", "A", "B"] } });
    expect(names(await handle({ ...base, op: "list_features" }))).toEqual(["C", "A", "B"]);
    for (const order of [["C", "A"], ["C", "A", "B", "A"], ["C", "A", "A"], ["C", "A", "X"]]) {
      expect(await handle({ ...base, op: "reorder_features", order }), order.join()).toMatchObject({ ok: false });
    }
    expect(names(await handle({ ...base, op: "list_features" }))).toEqual(["C", "A", "B"]);
  });

  it("creates a ticket straight into a feature, and checks the feature before creating anything", async () => {
    const { handle, base, tickets } = await setup();
    await handle({ ...base, op: "create_feature", name: "Payment" });
    expect(await handle({ ...base, op: "create_ticket", ticket: "DMS-7", repos: ["frontend"], feature: "Payment" })).toMatchObject({ ok: true, value: { key: "DMS-7", feature: "Payment" } });
    expect(await handle({ ...base, op: "list_tickets" })).toMatchObject({ ok: true, value: [{}, {}, { key: "DMS-7", feature: "Payment" }] });
    expect(await handle({ ...base, op: "create_ticket", ticket: "DMS-8", repos: ["frontend"], feature: "Nope" })).toMatchObject({ ok: false });
    expect(tickets.get("DMS-8")).toBeNull();
  });
});
