import { mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
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
  const sessionService = new SessionService({
    tickets, sessions, settings, ticketService, pty, features,
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
    tickets, sessions, features, ticketService, sessionService,
    submit: async (termId, task) => (submitted.push([termId, task]), "sent" as const),
    notify: () => void notified++,
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
  return { handle, sessionService, sessions, tickets, spawned, submitted, feature, other, base, frontend, backend, notified: () => notified };
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
});
