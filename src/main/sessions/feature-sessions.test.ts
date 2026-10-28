import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { applyHookEnvelope } from "../hooks/hook-events";
import { FeatureService } from "../tickets/feature-service";
import { TicketService } from "../tickets/ticket-service";
import { fakePtyFactory, makeRepo, memDb, tempDir } from "../test-utils";
import { PtyManager } from "./pty-manager";
import { SessionService } from "./session-service";

/** 一个 feature：frontend 的 ticket 用 worktree（在工作区里），backend 的 ticket 用分支模式（在工作区外面）。 */
async function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const featureHandoffs = new FeatureHandoffsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const settings = new SettingsRepo(db);
  const ticketService = new TicketService({ tickets, features, settings, now: () => 1, workspacesDir: tempDir("butler-ws-") });
  const featureService = new FeatureService({ features, tickets, now: () => 1 });
  const parent = join(tempDir("butler-code-"), "shop");
  mkdirSync(parent);
  const frontend = join(parent, "frontend");
  const backend = join(parent, "backend");
  renameSync(makeRepo(), frontend);
  renameSync(makeRepo(), backend);
  const feature = await featureService.create({ name: "checkout", repoPaths: [frontend, backend] });
  const fe = await ticketService.create({ key: "DMS-1", featureId: feature.id, repoPaths: [frontend], workMode: "worktree" });
  const be = await ticketService.create({ key: "DMS-2", featureId: feature.id, repoPaths: [backend], workMode: "branch" });
  await ticketService.create({ key: "SOLO-1", repoPath: makeRepo(), workMode: "branch" });
  const { factory, spawned } = fakePtyFactory();
  const pty = new PtyManager(factory, { data: () => undefined, exit: () => undefined });
  const mcpAsked: { key: string; coordinator: boolean; featureId: number | null }[] = [];
  let n = 0;
  const service = new SessionService({
    tickets, sessions, settings, ticketService, pty, features, featureHandoffs, handoffs,
    ready: async () => undefined,
    transcriptExists: () => true,
    transcriptState: () => "present",
    claude: () => ({ path: "/bin/claude", pathValue: "/login/bin" }),
    newId: () => `new-${++n}`,
    now: () => 1000,
    platform: "darwin",
    baseEnv: { HOME: "/h" },
    mcpConfig: (key, o) => (mcpAsked.push({ key, ...o }), `/mcp/${key}.json`),
    featureMcpConfig: (id) => `/mcp/features/${id}.json`,
  });
  return { service, featureHandoffs, handoffs, sessions, tickets, features, spawned, pty, feature, fe, be, backend, mcpAsked };
}

describe("feature coordinator sessions (design 2026-10-26)", () => {
  it("opens in the workspace, adds only the repos outside it, and is not a ticket session", async () => {
    const { service, spawned, sessions, feature, backend } = await setup();
    expect(await service.openFeature({ featureId: feature.id })).toEqual({ ok: true, termId: "new-1", alreadyOpen: false });
    const s = spawned[0];
    expect(s.opts.cwd).toBe(feature.workspaceDir);
    expect(s.args).toEqual(["--session-id", "new-1", "--mcp-config", `/mcp/features/${feature.id}.json`, "--add-dir", backend]);
    expect(s.opts.env.BUTLER_TICKET).toBeUndefined();
    expect(s.opts.env.BUTLER_SESSION).toBe("new-1");
    expect(sessions.get("new-1")).toMatchObject({ ticketKey: null, featureId: feature.id, coordinator: true, cwd: feature.workspaceDir });
  });

  it("resumes a feature coordinator in the workspace and reuses an open terminal", async () => {
    const { service, spawned, sessions, feature } = await setup();
    sessions.insertIfAbsent({ id: "old", ticketKey: null, cwd: feature.workspaceDir, origin: "discovered", createdAt: 1, featureId: feature.id, coordinator: true });
    expect(await service.openFeature({ featureId: feature.id, sessionId: "old" })).toMatchObject({ ok: true, termId: "old", alreadyOpen: false });
    expect(spawned[0].args.slice(0, 2)).toEqual(["--resume", "old"]);
    expect(await service.openFeature({ featureId: feature.id, sessionId: "old" })).toMatchObject({ ok: true, termId: "old", alreadyOpen: true });
  });

  it("refuses a missing or archived feature", async () => {
    const { service, features, feature } = await setup();
    expect(await service.openFeature({ featureId: 999 })).toEqual({ ok: false, reason: "no_ticket" });
    features.archive(feature.id, 5);
    expect(await service.openFeature({ featureId: feature.id })).toEqual({ ok: false, reason: "no_ticket" });
  });

  it("lists feature tickets under their feature, not among the standalone tickets", async () => {
    const { service, feature } = await setup();
    await service.openFeature({ featureId: feature.id });
    expect(service.ticketViews().map((t) => t.key)).toEqual(["SOLO-1"]);
    const [fv] = service.featureViews();
    expect(fv.id).toBe(feature.id);
    expect(fv.tickets.map((t) => t.key).sort()).toEqual(["DMS-1", "DMS-2"]);
    expect(fv.sessions.map((s) => [s.id, s.termId])).toEqual([["new-1", "new-1"]]);
  });

  it("carries the latest feature summary (degraded too) and each ticket's PRs from its latest valid handoff", async () => {
    const { service, feature, featureHandoffs, handoffs } = await setup();
    expect(service.featureViews()[0].summary).toBeNull();
    const pr = { repo: "frontend", url: "https://x/pr/1", state: "open" } as never;
    const payload = (prs: unknown[]) => ({ ticket: "DMS-1", status: "active", done_today: [], next_steps: [], blockers: [], prs, jira: null, followups: [], decisions: [], learnings: [], open_questions: [] }) as never;
    handoffs.insert({ ticketKey: "DMS-1", sessionId: null, trigger: "manual", createdAt: 10, payload: payload([]), rawText: null });
    handoffs.insert({ ticketKey: "DMS-1", sessionId: null, trigger: "refresh", createdAt: 20, payload: payload([pr]), rawText: null });
    handoffs.insert({ ticketKey: "DMS-2", sessionId: null, trigger: "manual", createdAt: 20, payload: null, rawText: "bad" });
    featureHandoffs.insert({ featureId: feature.id, sessionId: null, trigger: "manual", createdAt: 1, payload: { summary: "a", blockers: [], next_steps: [], decisions: [], open_questions: [] }, rawText: null });
    featureHandoffs.insert({ featureId: feature.id, sessionId: null, trigger: "manual", createdAt: 2, payload: null, rawText: "bad" });
    const fv = service.featureViews()[0];
    expect(fv.summary).toMatchObject({ createdAt: 2, degraded: true });
    expect(fv.ticketPrs["DMS-1"]).toEqual([pr]);
    expect(fv.ticketPrs["DMS-2"]).toEqual([]);
  });

  it("counts the coordinator and every ticket's terminals toward the feature", async () => {
    const { service, feature } = await setup();
    expect(service.hasFeatureTerminal(feature.id)).toBe(false);
    await service.openFeature({ featureId: feature.id });
    await service.open({ ticketKey: "DMS-1" });
    await service.open({ ticketKey: "SOLO-1", force: true });
    expect(service.featureTerminalCount(feature.id)).toBe(2);
    expect(service.hasFeatureTerminal(feature.id)).toBe(true);
  });

  it("tells the memory config which feature a ticket session belongs to", async () => {
    const { service, mcpAsked, feature } = await setup();
    await service.open({ ticketKey: "DMS-1" });
    await service.open({ ticketKey: "SOLO-1", force: true });
    expect(mcpAsked).toEqual([
      { key: "DMS-1", coordinator: false, featureId: feature.id },
      { key: "SOLO-1", coordinator: false, featureId: null },
    ]);
  });

  it("claims a claude the user opened in the workspace as the feature coordinator, across /clear", async () => {
    const { sessions, tickets, features, feature, service } = await setup();
    const deps = { sessions, tickets, featureForCwd: (cwd: string) => features.byWorkspace(cwd)?.id ?? null };
    const env = (id: string, over: Record<string, unknown> = {}, butlerSession: string | null = null) => ({
      v: 1 as const, receivedAt: 100, ticket: null, butlerSession,
      payload: { hook_event_name: "SessionStart", session_id: id, cwd: feature.workspaceDir, ...over },
    });
    applyHookEnvelope(env("d1"), deps);
    expect(sessions.get("d1")).toMatchObject({ featureId: feature.id, coordinator: true, ticketKey: null });
    expect(service.unclaimed().map((s) => s.id)).not.toContain("d1");

    await service.openFeature({ featureId: feature.id });
    applyHookEnvelope(env("c2", { source: "clear", cwd: "/somewhere/else" }, "new-1"), deps);
    expect(sessions.get("c2")).toMatchObject({ featureId: feature.id, coordinator: true });
    expect(sessions.head("new-1")?.id).toBe("c2");
    expect(existsSync(feature.workspaceDir)).toBe(true);
  });

  it("hides and restores a feature coordinator session", async () => {
    const { service, sessions, feature, pty } = await setup();
    await service.openFeature({ featureId: feature.id });
    pty.kill("new-1");
    service.hide("new-1");
    expect(service.featureViews()[0].hiddenSessions.map((s) => s.id)).toEqual(["new-1"]);
    service.unhide("new-1");
    expect(sessions.get("new-1")?.dismissed).toBe(false);
  });
});
