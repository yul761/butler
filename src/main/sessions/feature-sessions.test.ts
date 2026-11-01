import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import { MAX_RUNNING_PER_FEATURE } from "../../shared/control";
import { EpicsRepo } from "../db/epics-repo";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { applyHookEnvelope } from "../hooks/hook-events";
import { FeatureService } from "../tickets/feature-service";
import { TicketService } from "../tickets/ticket-service";
import { setLang } from "../i18n";
import { fakePtyFactory, makeRepo, memDb, tempDir } from "../test-utils";
import { PtyManager } from "./pty-manager";
import { SessionService } from "./session-service";

/** 一个 feature：frontend 的 ticket 用 worktree（在工作区里），backend 的 ticket 用分支模式（在工作区外面）。 */
async function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const features = new FeaturesRepo(db);
  const epics = new EpicsRepo(db);
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
  const mcpAsked: { key: string; coordinator: boolean; featureId: number | null; epicId: number | null }[] = [];
  const featureMcpAsked: [number, number | null][] = [];
  const epicMcpAsked: number[] = [];
  const settingsAsked: string[][] = [];
  const activities = new Map<string, SessionActivity>();
  const names = new Map<string, string>();
  const namesAsked: string[] = [];
  const submitted: [string, string][] = [];
  const claude: { path: string | null } = { path: "/bin/claude" };
  const logs: string[] = [];
  let submit: (termId: string, message: string) => Promise<"sent" | "exited" | "timeout"> = async (termId, message) => (submitted.push([termId, message]), "sent");
  let n = 0;
  const service = new SessionService({
    tickets, sessions, settings, ticketService, pty, features, epics, featureHandoffs, handoffs,
    activity: (id) => activities.get(id) ?? null,
    sessionName: async (id) => (namesAsked.push(id), names.get(id) ?? null),
    submit: (termId, message) => submit(termId, message),
    log: (m) => logs.push(m),
    ready: async () => undefined,
    transcriptExists: () => true,
    transcriptState: () => "present",
    claude: () => ({ path: claude.path, pathValue: "/login/bin" }),
    newId: () => `new-${++n}`,
    now: () => 1000,
    platform: "darwin",
    baseEnv: { HOME: "/h" },
    mcpConfig: (key, o) => (mcpAsked.push({ key, ...o }), `/mcp/${key}.json`),
    featureMcpConfig: (id, epicId) => (featureMcpAsked.push([id, epicId]), `/mcp/features/${id}.json`),
    epicMcpConfig: (id) => (epicMcpAsked.push(id), `/mcp/epics/${id}.json`),
    mcpSettings: (dirs) => (settingsAsked.push(dirs), "/mcp/approve.json"),
  });
  return {
    service, featureHandoffs, handoffs, sessions, tickets, features, epics, spawned, pty, feature, fe, be, frontend, backend, mcpAsked, featureMcpAsked, epicMcpAsked, settingsAsked,
    activities, names, namesAsked, submitted, claude, logs, setSubmit: (f: typeof submit) => (submit = f),
  };
}

describe("feature coordinator sessions (design 2026-10-26)", () => {
  it("opens in the workspace, adds only the repos outside it, and is not a ticket session", async () => {
    const { service, spawned, sessions, feature, frontend, backend, settingsAsked } = await setup();
    expect(await service.openFeature({ featureId: feature.id })).toEqual({ ok: true, termId: "new-1", alreadyOpen: false });
    const s = spawned[0];
    expect(s.opts.cwd).toBe(feature.workspaceDir);
    expect(s.args).toEqual(["--session-id", "new-1", "--mcp-config", `/mcp/features/${feature.id}.json`, "--settings", "/mcp/approve.json", "--add-dir", backend]);
    // 仓库 .mcp.json 的审批：工作区和 feature 的每个仓库里用户禁用过的照旧禁用。
    expect(settingsAsked).toEqual([[feature.workspaceDir, frontend, backend]]);
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

  it("carries the latest feature summary (degraded too) and each ticket's PRs from its latest valid handoff, plus merged ones from before", async () => {
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
    // 之后的 handoff 不再提 PR：合并过的照样显示（不会变成“还没有 PR”）。
    const mergedPr = { number: 9, url: "https://x/pr/9", state: "merged", review: null };
    handoffs.insert({ ticketKey: "DMS-2", sessionId: null, trigger: "manual", createdAt: 30, payload: { ...(payload([mergedPr]) as object), ticket: "DMS-2" } as never, rawText: null });
    handoffs.insert({ ticketKey: "DMS-2", sessionId: null, trigger: "refresh", createdAt: 40, payload: { ...(payload([]) as object), ticket: "DMS-2" } as never, rawText: null });
    expect(service.featureViews()[0].ticketPrs["DMS-2"]).toEqual([mergedPr]);
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
      { key: "DMS-1", coordinator: false, featureId: feature.id, epicId: null },
      { key: "SOLO-1", coordinator: false, featureId: null, epicId: null },
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

describe("epic sessions (design 2026-11-01)", () => {
  /** 一个 epic：仓库是 frontend 和 backend，工作区在仓库外面。 */
  async function epicSetup() {
    const ctx = await setup();
    const workspaceDir = tempDir("butler-epic-");
    const epicId = ctx.epics.insert({ name: "launch", workspaceDir, createdAt: 1 });
    ctx.epics.addRepo(epicId, ctx.frontend, 1);
    ctx.epics.addRepo(epicId, ctx.backend, 1);
    return { ...ctx, workspaceDir, epicId };
  }

  it("opens in the epic workspace with an --add-dir per repo, as neither a ticket nor a feature session", async () => {
    const { service, spawned, sessions, frontend, backend, settingsAsked, epicMcpAsked, workspaceDir, epicId } = await epicSetup();
    expect(await service.openEpic({ epicId })).toEqual({ ok: true, termId: "new-1", alreadyOpen: false });
    const s = spawned[0];
    expect(s.opts.cwd).toBe(workspaceDir);
    expect(s.args).toEqual(["--session-id", "new-1", "--mcp-config", `/mcp/epics/${epicId}.json`, "--settings", "/mcp/approve.json", "--add-dir", frontend, "--add-dir", backend]);
    expect(epicMcpAsked).toEqual([epicId]);
    expect(settingsAsked).toEqual([[workspaceDir, frontend, backend]]);
    expect(s.opts.env.BUTLER_TICKET).toBeUndefined();
    expect(s.opts.env.BUTLER_SESSION).toBe("new-1");
    expect(sessions.get("new-1")).toMatchObject({ ticketKey: null, featureId: null, epicId, coordinator: false, fixesSession: null, cwd: workspaceDir, origin: "butler" });
  });

  it("adds no directory for a repo that is gone or already inside the workspace", async () => {
    const { service, spawned, epics, frontend, workspaceDir, epicId } = await epicSetup();
    epics.addRepo(epicId, join(workspaceDir, "inside"), 1);
    epics.addRepo(epicId, join(workspaceDir, "..", "no-such-repo-here"), 1);
    mkdirSync(join(workspaceDir, "inside"));
    await service.openEpic({ epicId });
    const dirs = spawned[0].args.filter((_, i, all) => all[i - 1] === "--add-dir");
    expect(dirs).toContain(frontend);
    expect(dirs).toHaveLength(2);
  });

  it("resumes its own session, reuses an open terminal and prefills there", async () => {
    const { service, spawned, sessions, pty, workspaceDir, epicId } = await epicSetup();
    sessions.insertIfAbsent({ id: "old", ticketKey: null, cwd: workspaceDir, origin: "butler", createdAt: 1, epicId });
    expect(await service.openEpic({ epicId, sessionId: "old" })).toEqual({ ok: true, termId: "old", alreadyOpen: false });
    expect(spawned[0].args.slice(0, 2)).toEqual(["--resume", "old"]);
    const prefill = vi.spyOn(pty, "prefill").mockResolvedValue(undefined as never);
    expect(await service.openEpic({ epicId, sessionId: "old", prefill: "接着规划" })).toEqual({ ok: true, termId: "old", alreadyOpen: true });
    expect(prefill).toHaveBeenCalledWith("old", "接着规划", 0);
    expect(spawned).toHaveLength(1);
  });

  it("refuses a session that is not this epic's", async () => {
    const { service, sessions, epics, feature, workspaceDir, epicId } = await epicSetup();
    const other = epics.insert({ name: "other", workspaceDir: tempDir("butler-epic-"), createdAt: 1 });
    sessions.insertIfAbsent({ id: "theirs", ticketKey: null, cwd: workspaceDir, origin: "butler", createdAt: 1, epicId: other });
    sessions.insertIfAbsent({ id: "coord", ticketKey: null, cwd: feature.workspaceDir, origin: "butler", createdAt: 1, featureId: feature.id, coordinator: true });
    for (const sessionId of ["theirs", "coord", "nope"]) expect(await service.openEpic({ epicId, sessionId }), sessionId).toEqual({ ok: false, reason: "no_session" });
  });

  it("refuses a missing or archived epic, and a missing claude", async () => {
    const { service, epics, claude, spawned, epicId } = await epicSetup();
    expect(await service.openEpic({ epicId: 999 })).toEqual({ ok: false, reason: "no_ticket" });
    claude.path = null;
    expect(await service.openEpic({ epicId })).toEqual({ ok: false, reason: "claude_missing" });
    epics.archive(epicId, 5);
    expect(await service.openEpic({ epicId })).toEqual({ ok: false, reason: "no_ticket" });
    expect(spawned).toEqual([]);
  });

  it("recreates a missing workspace, for a new session and a resumed one, like a feature", async () => {
    const { service, spawned, sessions, workspaceDir, epicId } = await epicSetup();
    sessions.insertIfAbsent({ id: "old", ticketKey: null, cwd: workspaceDir, origin: "butler", createdAt: 1, epicId });
    rmSync(workspaceDir, { recursive: true });
    expect(await service.openEpic({ epicId })).toEqual({ ok: true, termId: "new-1", alreadyOpen: false });
    expect(existsSync(workspaceDir)).toBe(true);
    expect(spawned[0].opts.cwd).toBe(workspaceDir);
    rmSync(workspaceDir, { recursive: true });
    expect(await service.openEpic({ epicId, sessionId: "old" })).toEqual({ ok: true, termId: "old", alreadyOpen: false });
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it("returns an error, without throwing or leaving a row, when the workspace cannot be created", async () => {
    const { service, spawned, sessions, logs, workspaceDir, epicId } = await epicSetup();
    sessions.insertIfAbsent({ id: "old", ticketKey: null, cwd: workspaceDir, origin: "butler", createdAt: 1, epicId });
    rmSync(workspaceDir, { recursive: true });
    // 这个路径上是一个文件，mkdir 建不了目录。
    writeFileSync(workspaceDir, "");
    await expect(service.openEpic({ epicId })).resolves.toEqual({ ok: false, reason: "no_repo" });
    await expect(service.openEpic({ epicId, sessionId: "old" })).resolves.toEqual({ ok: false, reason: "no_repo" });
    expect(spawned).toEqual([]);
    expect(sessions.listByEpic(epicId).map((s) => s.id)).toEqual(["old"]);
    expect(logs.some((l) => l.includes(`epic ${epicId}`))).toBe(true);
  });

  it("leaves no empty row when claude cannot start", async () => {
    const { service, pty, sessions, epicId } = await epicSetup();
    vi.spyOn(pty, "open").mockImplementation(() => {
      throw new Error("spawn failed");
    });
    await expect(service.openEpic({ epicId })).rejects.toThrow("spawn failed");
    expect(sessions.get("new-1")).toBeNull();
  });

  it("follows /clear: the new head stays an epic session on the same terminal", async () => {
    const { service, sessions, tickets, epics, epicId, workspaceDir, spawned } = await epicSetup();
    await service.openEpic({ epicId });
    applyHookEnvelope(
      { v: 1, receivedAt: 100, ticket: null, butlerSession: "new-1", payload: { hook_event_name: "SessionStart", session_id: "e-2", cwd: workspaceDir, source: "clear" } },
      { sessions, tickets, epicForCwd: (cwd) => epics.byWorkspace(cwd)?.id ?? null },
    );
    expect(sessions.head("new-1")).toMatchObject({ id: "e-2", epicId, coordinator: false });
    expect(await service.openEpic({ epicId, sessionId: "new-1" })).toEqual({ ok: true, termId: "new-1", alreadyOpen: true });
    expect(service.epicTerminalCount(epicId)).toBe(1);
    expect(spawned).toHaveLength(1);
  });

  it("is no feature coordinator and not unclaimed", async () => {
    const { service, sessions, feature, epicId } = await epicSetup();
    await service.openEpic({ epicId });
    expect(sessions.listFeatureCoordinators(feature.id)).toEqual([]);
    expect(service.featureViews()[0].sessions).toEqual([]);
    expect(service.featureTerminalCount(feature.id)).toBe(0);
    expect(service.unclaimed()).toEqual([]);
  });

  it("counts only the epic's own terminals", async () => {
    const { service, spawned, feature, epicId } = await epicSetup();
    expect(service.hasEpicTerminal(epicId)).toBe(false);
    await service.openEpic({ epicId });
    await service.openFeature({ featureId: feature.id });
    expect(service.epicTerminalCount(epicId)).toBe(1);
    expect(service.hasEpicTerminal(epicId)).toBe(true);
    spawned[0].pty.emitExit(0);
    expect(service.hasEpicTerminal(epicId)).toBe(false);
  });

  it("fills each epic with its features: status, latest valid summary, stuck and waiting", async () => {
    const { service, sessions, features, featureHandoffs, activities, feature, epicId } = await epicSetup();
    const sum = { summary: "联调完了", blockers: ["等后端"], next_steps: [], decisions: [{ key: "k", statement: "s" }], open_questions: ["q"] };
    featureHandoffs.insert({ featureId: feature.id, sessionId: null, trigger: "manual", createdAt: 5, payload: sum, rawText: null });
    featureHandoffs.insert({ featureId: feature.id, sessionId: null, trigger: "manual", createdAt: 6, payload: null, rawText: "bad" });
    const gone = features.insert({ name: "gone", workspaceDir: tempDir("butler-gone-"), createdAt: 1 });
    features.setEpic(gone, epicId);
    features.archive(gone, 9);
    features.setEpic(feature.id, epicId);
    const row = () => service.epicViews()[0].features.find((f) => f.id === feature.id)!;
    const fresh = features.insert({ name: "fresh", workspaceDir: tempDir("butler-fresh-"), createdAt: 1 });
    features.setEpic(fresh, epicId);
    expect(service.epicViews()[0].features.map((f) => [f.id, f.status])).toEqual([[feature.id, "active"], [fresh, "not_started"], [gone, "archived"]]);
    expect(row()).toMatchObject({ status: "active", summary: "联调完了", summaryAt: 5, blockers: ["等后端"], openQuestions: ["q"] });
    expect(service.epicViews()[0]).toMatchObject({ stuck: false, waiting: false });
    expect(service.epicViews()[0].features[2]).toMatchObject({ status: "archived", summary: null });

    const t = await service.open({ ticketKey: "DMS-1" });
    if (!t.ok) throw new Error("did not open");
    sessions.setWaiting(t.termId, true, 2000);
    expect(row().status).toBe("waiting");
    expect(service.epicViews()[0]).toMatchObject({ waiting: true, stuck: false });
    activities.set(t.termId, stuckActivity(t.termId));
    expect(row().status).toBe("stuck");
    expect(service.epicViews()[0]).toMatchObject({ waiting: true, stuck: true });
    expect(service.epicFeatureRows(epicId)).toEqual(service.epicViews()[0].features);
  });

  it("lists epics with their sessions and terminals; progress comes later", async () => {
    const { service, sessions, epics, pty, epicId, frontend, backend } = await epicSetup();
    const archived = epics.insert({ name: "old", workspaceDir: tempDir("butler-epic-"), createdAt: 1 });
    epics.archive(archived, 5);
    await service.openEpic({ epicId });
    const [view, ...rest] = service.epicViews();
    expect(rest).toEqual([]);
    expect(view).toMatchObject({ id: epicId, name: "launch", features: [], waiting: false, stuck: false, hiddenSessions: [] });
    expect(view.repos.map((r) => r.repoPath)).toEqual([frontend, backend]);
    expect(view.sessions.map((s) => [s.id, s.termId])).toEqual([["new-1", "new-1"]]);
    sessions.setWaiting("new-1", true, 2000);
    expect(service.epicViews()[0].waiting).toBe(true);
    pty.kill("new-1");
    service.hide("new-1");
    expect(service.epicViews()[0]).toMatchObject({ sessions: [], hiddenSessions: [expect.objectContaining({ id: "new-1", termId: null })] });
    service.unhide("new-1");
    expect(service.epicViews()[0].sessions.map((s) => s.id)).toEqual(["new-1"]);
  });

  it("gives every session of a feature in an epic the epic memory, and leaves other features alone", async () => {
    const { service, features, feature, mcpAsked, featureMcpAsked, activities, epicId } = await epicSetup();
    await service.openFeature({ featureId: feature.id });
    await service.open({ ticketKey: "SOLO-1", force: true });
    features.setEpic(feature.id, epicId);
    await service.openFeature({ featureId: feature.id });
    const ticket = await service.open({ ticketKey: "DMS-1" });
    await service.open({ ticketKey: "DMS-1", coordinator: true });
    await service.open({ ticketKey: "SOLO-1", force: true });
    if (!ticket.ok) throw new Error("did not open");
    activities.set(ticket.termId, stuckActivity(ticket.termId));
    await service.openFix({ featureId: feature.id, stuckSessionId: ticket.termId });
    expect(featureMcpAsked).toEqual([[feature.id, null], [feature.id, epicId], [feature.id, epicId]]);
    expect(mcpAsked).toEqual([
      { key: "SOLO-1", coordinator: false, featureId: null, epicId: null },
      { key: "DMS-1", coordinator: false, featureId: feature.id, epicId },
      { key: "DMS-1", coordinator: true, featureId: feature.id, epicId },
      { key: "SOLO-1", coordinator: false, featureId: null, epicId: null },
    ]);
  });

  it("does not rewrite the config of a running session when its feature moves", async () => {
    const { service, features, feature, featureMcpAsked, epicId } = await epicSetup();
    await service.openFeature({ featureId: feature.id });
    features.setEpic(feature.id, epicId);
    expect(featureMcpAsked).toEqual([[feature.id, null]]);
    expect(await service.openFeature({ featureId: feature.id, sessionId: "new-1" })).toMatchObject({ alreadyOpen: true });
    expect(featureMcpAsked).toEqual([[feature.id, null]]);
  });
});

const stuckActivity = (sessionId: string, over: Partial<SessionActivity> = {}): SessionActivity => ({
  sessionId, kind: "test", detail: "pnpm test", background: false, startedAt: 1, lastOutputAt: 2, stuck: true, reason: "测试停在等网络", action: "看看代理", lastOutput: ["waiting for 127.0.0.1", "retry 3"], ...over,
});

describe("fix sessions (design 2026-10-31)", () => {
  /** DMS-1 下一个正在运行、卡住了的 session。 */
  async function stuckSetup() {
    const ctx = await setup();
    const r = await ctx.service.open({ ticketKey: "DMS-1" });
    if (!r.ok) throw new Error("did not open");
    ctx.activities.set(r.termId, stuckActivity(r.termId));
    return { ...ctx, stuckId: r.termId, req: { featureId: ctx.feature.id, stuckSessionId: r.termId } };
  }

  it("opens a non-coordinator feature-level session in the workspace, started like a coordinator", async () => {
    const { service, spawned, sessions, feature, backend, req, stuckId } = await stuckSetup();
    expect(await service.openFix(req)).toEqual({ ok: true, termId: "new-2", alreadyOpen: false });
    expect(sessions.get("new-2")).toMatchObject({ ticketKey: null, featureId: feature.id, coordinator: false, fixesSession: stuckId, cwd: feature.workspaceDir, origin: "butler" });
    const s = spawned[1];
    expect(s.opts.cwd).toBe(feature.workspaceDir);
    expect(s.args).toEqual(["--session-id", "new-2", "--mcp-config", `/mcp/features/${feature.id}.json`, "--settings", "/mcp/approve.json", "--add-dir", backend]);
    expect(s.opts.env.BUTLER_TICKET).toBeUndefined();
    expect(s.opts.env.BUTLER_SESSION).toBe("new-2");
  });

  it("sends the task with submit, not prefill, and does not wait for it", async () => {
    const { service, pty, req, stuckId, submitted, names, activities, sessions, setSubmit } = await stuckSetup();
    const prefill = vi.spyOn(pty, "prefill");
    activities.set(stuckId, stuckActivity(stuckId, { background: true }));
    names.set(stuckId, "swift-fox");
    let finish: (r: "sent") => void = () => undefined;
    setSubmit((termId, message) => (submitted.push([termId, message]), new Promise((r) => (finish = r))));
    await expect(service.openFix(req)).resolves.toMatchObject({ ok: true, termId: "new-2" });
    finish("sent");
    expect(prefill).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(1);
    const [termId, text] = submitted[0];
    expect(termId).toBe("new-2");
    for (const part of ["DMS-1", stuckId, "swift-fox", sessions.get(stuckId)!.cwd, "跑测试 pnpm test（后台）", "测试停在等网络", "waiting for 127.0.0.1", "retry 3"]) expect(text).toContain(part);
  });

  it("writes the task in the current language", async () => {
    const { service, req, submitted } = await stuckSetup();
    setLang("en");
    try {
      await service.openFix(req);
    } finally {
      setLang("zh");
    }
    expect(submitted[0][1]).toContain("Do not take over");
  });

  it("logs a task that did not arrive, and still returns the session", async () => {
    const { service, req, logs, setSubmit } = await stuckSetup();
    setSubmit(async () => "timeout");
    expect(await service.openFix(req)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(logs.some((l) => l.includes("new-2") && l.includes("timeout"))).toBe(true));
  });

  it("logs a failed delivery", async () => {
    const { service, req, logs, setSubmit } = await stuckSetup();
    setSubmit(async () => {
      throw new Error("boom");
    });
    expect(await service.openFix(req)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(logs.some((l) => l.includes("new-2"))).toBe(true));
  });

  it("is not limited by the running sessions of the feature", async () => {
    const { service, feature, req } = await stuckSetup();
    while (service.featureTerminalCount(feature.id) < MAX_RUNNING_PER_FEATURE) await service.openFeature({ featureId: feature.id });
    expect(await service.openFix(req)).toMatchObject({ ok: true, alreadyOpen: false });
    expect(service.featureTerminalCount(feature.id)).toBe(MAX_RUNNING_PER_FEATURE + 1);
  });

  it("returns the running fix session on a second click, without a second session or task", async () => {
    const { service, spawned, submitted, req } = await stuckSetup();
    await service.openFix(req);
    expect(await service.openFix(req)).toEqual({ ok: true, termId: "new-2", alreadyOpen: true });
    expect(spawned).toHaveLength(2);
    expect(submitted).toHaveLength(1);
  });

  it("opens one session when two clicks race", async () => {
    const { service, spawned, submitted, req } = await stuckSetup();
    const results = await Promise.all([service.openFix(req), service.openFix(req)]);
    expect(results).toEqual(expect.arrayContaining([{ ok: true, termId: "new-2", alreadyOpen: false }, { ok: true, termId: "new-2", alreadyOpen: true }]));
    expect(spawned).toHaveLength(2);
    expect(submitted).toHaveLength(1);
  });

  it("finds the running fix session after /clear in it", async () => {
    const { service, spawned, sessions, feature, req, stuckId } = await stuckSetup();
    await service.openFix(req);
    sessions.insertIfAbsent({ id: "fix-2", ticketKey: null, cwd: feature.workspaceDir, origin: "butler", createdAt: 2 });
    sessions.setReplacedBy("new-2", "fix-2");
    expect(sessions.get("fix-2")?.fixesSession).toBe(stuckId);
    expect(await service.openFix(req)).toEqual({ ok: true, termId: "new-2", alreadyOpen: true });
    expect(spawned).toHaveLength(2);
  });

  it("follows /clear in the stuck session: an old id reaches the new head, and the fix session still counts", async () => {
    const { service, spawned, sessions, activities, req, stuckId } = await stuckSetup();
    await service.openFix(req);
    sessions.insertIfAbsent({ id: "stuck-2", ticketKey: "DMS-1", cwd: sessions.get(stuckId)!.cwd, origin: "butler", createdAt: 2 });
    sessions.setReplacedBy(stuckId, "stuck-2");
    activities.delete(stuckId);
    activities.set("stuck-2", stuckActivity("stuck-2"));
    expect(await service.openFix({ ...req, stuckSessionId: "stuck-2" })).toEqual({ ok: true, termId: "new-2", alreadyOpen: true });
    expect(await service.openFix(req)).toEqual({ ok: true, termId: "new-2", alreadyOpen: true });
    expect(spawned).toHaveLength(2);
  });

  it("opens a new fix session after the last one exited, and one per stuck session", async () => {
    const { service, spawned, pty, activities, feature, req } = await stuckSetup();
    await service.openFix(req);
    const other = await service.open({ ticketKey: "DMS-2", force: true });
    if (!other.ok) throw new Error("did not open");
    activities.set(other.termId, stuckActivity(other.termId));
    expect(await service.openFix({ featureId: feature.id, stuckSessionId: other.termId })).toMatchObject({ ok: true, alreadyOpen: false });
    expect(spawned).toHaveLength(4);
    spawned[1].pty.emitExit(0);
    expect(pty.openIds()).not.toContain("new-2");
    expect(await service.openFix(req)).toMatchObject({ ok: true, alreadyOpen: false });
    expect(spawned).toHaveLength(5);
  });

  it("refuses when the monitor knows nothing about the session", async () => {
    const { service, activities, spawned, submitted, req, stuckId } = await stuckSetup();
    activities.delete(stuckId);
    expect(await service.openFix(req)).toEqual({ ok: false, reason: "no_session" });
    expect(spawned).toHaveLength(1);
    expect(submitted).toEqual([]);
  });

  it("refuses an unknown session, a feature-level session, and a session of another feature's ticket", async () => {
    const { service, sessions, features, activities, feature, req, stuckId } = await stuckSetup();
    expect(await service.openFix({ ...req, stuckSessionId: "nope" })).toEqual({ ok: false, reason: "no_session" });
    sessions.insertIfAbsent({ id: "c", ticketKey: null, cwd: feature.workspaceDir, origin: "butler", createdAt: 1, featureId: feature.id, coordinator: true });
    activities.set("c", stuckActivity("c"));
    expect(await service.openFix({ ...req, stuckSessionId: "c" })).toEqual({ ok: false, reason: "no_session" });
    const elsewhere = features.insert({ name: "x", workspaceDir: "/ws/x", createdAt: 1 });
    expect(await service.openFix({ featureId: elsewhere, stuckSessionId: stuckId })).toEqual({ ok: false, reason: "no_session" });
  });

  it("refuses a missing or archived feature, and a missing claude", async () => {
    const { service, features, feature, claude, req } = await stuckSetup();
    expect(await service.openFix({ ...req, featureId: 999 })).toEqual({ ok: false, reason: "no_ticket" });
    claude.path = null;
    expect(await service.openFix(req)).toEqual({ ok: false, reason: "claude_missing" });
    features.archive(feature.id, 5);
    expect(await service.openFix(req)).toEqual({ ok: false, reason: "no_ticket" });
  });

  it("leaves no empty row when claude cannot start", async () => {
    const { service, pty, sessions, req } = await stuckSetup();
    vi.spyOn(pty, "open").mockImplementation(() => {
      throw new Error("spawn failed");
    });
    await expect(service.openFix(req)).rejects.toThrow("spawn failed");
    expect(sessions.get("new-2")).toBeNull();
  });

  it("tells the fix session the name of the running coordinator", async () => {
    const { service, feature, names, submitted, sessions, req } = await stuckSetup();
    await service.openFeature({ featureId: feature.id });
    expect(sessions.get("new-2")?.coordinator).toBe(true);
    names.set("new-2", "calm-owl");
    await service.openFix(req);
    expect(submitted[0][1]).toContain("calm-owl");
  });

  it("tells the fix session to look for a running coordinator whose name is unknown, by the feature workspace", async () => {
    const { service, feature, names, submitted, req, stuckId } = await stuckSetup();
    await service.openFeature({ featureId: feature.id });
    names.set(stuckId, "swift-fox");
    await service.openFix(req);
    expect(submitted[0][1]).toContain(`用 ListAgents 按目录 ${feature.workspaceDir} 找到它`);
    expect(submitted[0][1]).not.toContain("没有运行中的总控");
  });

  it("says no coordinator is running when none is, even if a closed one exists", async () => {
    const { service, feature, names, sessions, submitted, req, stuckId } = await stuckSetup();
    sessions.insertIfAbsent({ id: "closed", ticketKey: null, cwd: feature.workspaceDir, origin: "butler", createdAt: 1, featureId: feature.id, coordinator: true });
    names.set(stuckId, "swift-fox");
    await service.openFix(req);
    expect(submitted[0][1]).toContain("没有运行中的总控 session，跳过这一步");
    expect(submitted[0][1]).not.toContain("ListAgents");
  });

  it("uses the coordinator's current head after /clear", async () => {
    const { service, feature, names, submitted, sessions, req } = await stuckSetup();
    await service.openFeature({ featureId: feature.id });
    sessions.insertIfAbsent({ id: "c-2", ticketKey: null, cwd: feature.workspaceDir, origin: "butler", createdAt: 2 });
    sessions.setReplacedBy("new-2", "c-2");
    names.set("c-2", "calm-owl");
    await service.openFix(req);
    expect(submitted[0][1]).toContain("calm-owl");
  });

  it("does not take a coordinator without a terminal or another fix session for the coordinator", async () => {
    const { service, activities, names, namesAsked, submitted, sessions, feature, req, stuckId } = await stuckSetup();
    sessions.insertIfAbsent({ id: "closed", ticketKey: null, cwd: feature.workspaceDir, origin: "butler", createdAt: 1, featureId: feature.id, coordinator: true });
    names.set("closed", "closed-name");
    await service.openFix(req);
    names.set("new-2", "first-fix");
    const other = await service.open({ ticketKey: "DMS-2", force: true });
    if (!other.ok) throw new Error("did not open");
    activities.set(other.termId, stuckActivity(other.termId));
    await service.openFix({ featureId: feature.id, stuckSessionId: other.termId });
    expect(namesAsked).toEqual([stuckId, other.termId]);
    for (const [, text] of submitted) {
      expect(text).not.toContain("closed-name");
      expect(text).not.toContain("first-fix");
    }
  });

  it("shows the fix session on the feature page, and lets it be resumed there as a fix session", async () => {
    const { service, spawned, sessions, feature, pty, req, stuckId } = await stuckSetup();
    await service.openFix(req);
    expect(service.featureViews()[0].sessions.map((s) => [s.id, s.termId, s.fixesSession])).toEqual([["new-2", "new-2", stuckId]]);
    spawned[1].pty.emitExit(0);
    expect(pty.openIds()).not.toContain("new-2");
    expect(await service.openFeature({ featureId: feature.id, sessionId: "new-2" })).toMatchObject({ ok: true, termId: "new-2", alreadyOpen: false });
    expect(sessions.get("new-2")).toMatchObject({ coordinator: false, fixesSession: stuckId });
  });
});
