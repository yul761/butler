import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { TicketService } from "../tickets/ticket-service";
import { cleanupTicketWorktrees } from "../tickets/worktree-cleanup";
import { NPM_EXE_SHIM, NPM_SHIM, PNPM_NODE_PATH, PNPM_NODE_PATH_SHIM } from "../claude/__fixtures__/shims";
import { fakePtyFactory, makeRepo, memDb, tempDir } from "../test-utils";
import type { TranscriptState } from "./discovery";
import { PtyManager, type PtyFactory } from "./pty-manager";
import { SessionService } from "./session-service";

async function setup(opts: {
  transcripts?: string[];
  transcriptState?: TranscriptState;
  claudePath?: string | null;
  workMode?: "branch" | "worktree";
  ready?: () => Promise<void>;
  factory?: PtyFactory;
  mcpConfig?: (ticketKey: string, opts: { coordinator: boolean }) => string | null;
  mcpSettings?: (dirs: string[]) => string | null;
  syncMemory?: (ticketKey: string) => void;
  platform?: NodeJS.Platform;
  launchFs?: { read: (f: string) => string; exists: (p: string) => boolean };
  pathValue?: string;
} = {}) {
  const stateOf = (id: string): TranscriptState =>
    opts.transcriptState ?? (opts.transcripts === undefined || opts.transcripts.includes(id) ? "present" : "absent");
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const settings = new SettingsRepo(db);
  const ticketService = new TicketService({ tickets, settings, now: () => 1, workspacesDir: tempDir("butler-ws-") });
  const { factory, spawned } = fakePtyFactory();
  const pty = new PtyManager(opts.factory ?? factory, { data: () => undefined, exit: () => undefined });
  const logs: string[] = [];
  let n = 0;
  const service = new SessionService({
    tickets, sessions, settings, ticketService, pty,
    ready: opts.ready ?? (async () => undefined),
    transcriptExists: (id) => stateOf(id) !== "absent",
    transcriptState: stateOf,
    claude: () => ({ path: opts.claudePath === undefined ? "/bin/claude" : opts.claudePath, pathValue: opts.pathValue ?? "/login/bin" }),
    newId: () => `new-${++n}`,
    now: () => 1000,
    platform: opts.platform ?? "darwin",
    baseEnv: { HOME: "/h" },
    mcpConfig: opts.mcpConfig,
    mcpSettings: opts.mcpSettings,
    syncMemory: opts.syncMemory,
    launchFs: opts.launchFs,
    log: (m) => logs.push(m),
  });
  const repo = makeRepo();
  const ticket = await ticketService.create({ key: "PROJ-1", repoPath: repo, workMode: opts.workMode ?? "worktree" });
  return { service, sessions, tickets, spawned, pty, repo, ticket, ticketService, logs };
}

describe("SessionService and cleaned-up worktrees (design 2026-10-26)", () => {
  it("rebuilds the worktree before resuming a session that ran in it, and before a new one", async () => {
    const { service, sessions, spawned, ticket, tickets, ticketService, pty } = await setup({ workMode: "worktree" });
    const dir = ticket.repos[0].worktreePath!;
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: dir, origin: "butler", createdAt: 1, repoId: ticket.repos[0].id });
    await cleanupTicketWorktrees({ tickets, ticketService, repoBusy: () => false, now: () => 5 }, "PROJ-1");
    expect(existsSync(dir)).toBe(false);
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "old" })).toMatchObject({ ok: true });
    expect(spawned[0].opts.cwd).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(tickets.getRepo(ticket.repos[0].id)?.worktreeRemovedAt).toBeNull();

    pty.kill("old");
    await cleanupTicketWorktrees({ tickets, ticketService, repoBusy: () => false, now: () => 6 }, "PROJ-1");
    expect(await service.open({ ticketKey: "PROJ-1" })).toMatchObject({ ok: true });
    expect(existsSync(dir)).toBe(true);
  });

  it("rebuilds the worktree before resuming a session that ran in a subdirectory of it", async () => {
    const { service, sessions, spawned, ticket, tickets, ticketService } = await setup({ workMode: "worktree" });
    const dir = ticket.repos[0].worktreePath!;
    const sub = join(dir, "packages", "api");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "index.ts"), "x");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "sub"], { cwd: dir });
    sessions.insertIfAbsent({ id: "nested", ticketKey: "PROJ-1", cwd: sub, origin: "discovered", createdAt: 1, repoId: ticket.repos[0].id });
    await cleanupTicketWorktrees({ tickets, ticketService, repoBusy: () => false, now: () => 5 }, "PROJ-1");
    expect(existsSync(sub)).toBe(false);
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "nested", force: true })).toMatchObject({ ok: true });
    expect(spawned[0].opts.cwd).toBe(sub);
    expect(existsSync(sub)).toBe(true);
  });

  it("counts only the repo's own sessions as busy for cleanup", async () => {
    const { service, ticket } = await setup({ workMode: "worktree" });
    const repoId = ticket.repos[0].id;
    expect(service.hasRepoTerminal("PROJ-1", repoId)).toBe(false);
    await service.open({ ticketKey: "PROJ-1", coordinator: true });
    expect(service.hasRepoTerminal("PROJ-1", repoId)).toBe(false);
    await service.open({ ticketKey: "PROJ-1" });
    expect(service.hasRepoTerminal("PROJ-1", repoId)).toBe(true);
  });
});

describe("SessionService.open", () => {
  it("mounts the ticket's memory MCP config on new and resumed sessions (design 4.2)", async () => {
    const asked: string[] = [];
    const { service, spawned, sessions } = await setup({ mcpConfig: (key) => (asked.push(key), "/b/mcp/PROJ-1.json") });
    await service.open({ ticketKey: "PROJ-1" });
    expect(spawned[0].args).toEqual(["--session-id", "new-1", "--mcp-config", "/b/mcp/PROJ-1.json"]);
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: "/elsewhere", origin: "butler", createdAt: 1 });
    await service.open({ ticketKey: "PROJ-1", sessionId: "old" });
    expect(spawned[1].args).toEqual(["--resume", "old", "--mcp-config", "/b/mcp/PROJ-1.json"]);
    expect(asked).toEqual(["PROJ-1", "PROJ-1"]);
  });

  it("passes the .mcp.json approval settings, asked with the session's folder and the repo roots", async () => {
    const asked: string[][] = [];
    const { service, spawned, sessions, repo, ticket } = await setup({ mcpSettings: (dirs) => (asked.push(dirs), "/b/mcp/approve-1.json") });
    await service.open({ ticketKey: "PROJ-1" });
    expect(spawned[0].args).toEqual(["--session-id", "new-1", "--settings", "/b/mcp/approve-1.json"]);
    expect(asked[0]).toEqual([ticket.repos[0].worktreePath, repo]);
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: "/elsewhere", origin: "butler", createdAt: 1 });
    await service.open({ ticketKey: "PROJ-1", sessionId: "old" });
    expect(spawned[1].args).toEqual(["--resume", "old", "--settings", "/b/mcp/approve-1.json"]);
  });

  it("opens the session without the approval settings when they cannot be written", async () => {
    const { service, spawned, logs } = await setup({
      mcpSettings: () => {
        throw new Error("disk full");
      },
    });
    expect(await service.open({ ticketKey: "PROJ-1" })).toMatchObject({ ok: true });
    expect(spawned[0].args).toEqual(["--session-id", "new-1"]);
    expect(logs.some((l) => l.includes("MCP approval settings for PROJ-1 not written"))).toBe(true);
  });

  it("opens the session without memory when the config is off, fails, or cannot pass through cmd.exe", async () => {
    const off = await setup({ mcpConfig: () => null });
    await off.service.open({ ticketKey: "PROJ-1" });
    expect(off.spawned[0].args).toEqual(["--session-id", "new-1"]);

    const broken = await setup({
      mcpConfig: () => {
        throw new Error("disk full");
      },
    });
    expect(await broken.service.open({ ticketKey: "PROJ-1" })).toMatchObject({ ok: true });
    expect(broken.spawned[0].args).toEqual(["--session-id", "new-1"]);
    expect(broken.logs.some((l) => l.includes("memory MCP config for PROJ-1 not written"))).toBe(true);

    const shim = await setup({ platform: "win32", claudePath: "C:\\npm\\claude.cmd", mcpConfig: () => "C:\\Users\\John Smith\\.butler\\mcp\\PROJ-1.json" });
    await shim.service.open({ ticketKey: "PROJ-1" });
    expect(shim.spawned[0].args).not.toContain("--mcp-config");
    expect(shim.logs.some((l) => l.includes("memory MCP config not passed for PROJ-1"))).toBe(true);
    // 认不出的 shim 回退到 cmd.exe：仍然经过 cmd.exe /c 启动。
    expect(shim.spawned[0].file).toBe("cmd.exe");
    expect(shim.spawned[0].args).toEqual(["/c", "C:\\npm\\claude.cmd", "--session-id", "new-1"]);
  });

  it("mounts memory with a spaced path when a recognised npm shim is started with node (plan 5, P4-R7 lifted)", async () => {
    const npmDir = "C:\\Users\\John Smith\\AppData\\Roaming\\npm";
    const cli = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const files = new Map([[`${npmDir}\\claude.cmd`, NPM_SHIM], [`${npmDir}\\node.exe`, ""], [cli, ""]]);
    const config = "C:\\Users\\John Smith\\.butler\\mcp\\tickets\\PROJ-1.json";
    const shim = await setup({
      platform: "win32",
      claudePath: `${npmDir}\\claude.cmd`,
      mcpConfig: () => config,
      launchFs: { read: (f) => files.get(f) ?? "", exists: (p) => files.has(p) },
    });
    await shim.service.open({ ticketKey: "PROJ-1" });
    expect(shim.spawned[0].file).toBe(`${npmDir}\\node.exe`);
    expect(shim.spawned[0].args).toEqual([cli, "--session-id", "new-1", "--mcp-config", config]);
    expect(shim.logs.some((l) => l.includes("memory MCP config not passed"))).toBe(false);
  });

  it("starts the native claude.exe behind a real npm shim directly and mounts memory (claude-code 2.1.307)", async () => {
    const npmDir = "C:\\Users\\John Smith\\AppData\\Roaming\\npm";
    const exe = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    const files = new Map([[`${npmDir}\\claude.cmd`, NPM_EXE_SHIM], [exe, ""]]);
    const config = "C:\\Users\\John Smith\\.butler\\mcp\\tickets\\PROJ-1.json";
    const shim = await setup({
      platform: "win32",
      claudePath: `${npmDir}\\claude.cmd`,
      mcpConfig: () => config,
      launchFs: { read: (f) => files.get(f) ?? "", exists: (p) => files.has(p) },
    });
    await shim.service.open({ ticketKey: "PROJ-1" });
    expect(shim.spawned[0].file).toBe(exe);
    expect(shim.spawned[0].args).toEqual(["--session-id", "new-1", "--mcp-config", config]);
    expect(shim.logs.some((l) => l.includes("memory MCP config not passed"))).toBe(false);
  });

  it("finds a pnpm shim's node on the login PATH and passes the shim's NODE_PATH on", async () => {
    const pnpmDir = "D:\\pnpm\\bin";
    const cli = "D:\\pnpm\\@anthropic-ai\\claude-code\\cli.js";
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const files = new Map([[`${pnpmDir}\\claude.cmd`, PNPM_NODE_PATH_SHIM], [cli, ""], [node, ""]]);
    const launchFs = { read: (f: string) => files.get(f) ?? "", exists: (p: string) => files.has(p) };
    const found = await setup({ platform: "win32", claudePath: `${pnpmDir}\\claude.cmd`, launchFs, pathValue: "C:\\Program Files\\nodejs;C:\\Windows" });
    await found.service.open({ ticketKey: "PROJ-1" });
    expect(found.spawned[0].file).toBe(node);
    expect(found.spawned[0].args).toEqual([cli, "--session-id", "new-1"]);
    expect(found.spawned[0].opts.env.NODE_PATH).toBe(PNPM_NODE_PATH);
    // 登录 PATH 里没有 node：回退到 cmd.exe。
    const missing = await setup({ platform: "win32", claudePath: `${pnpmDir}\\claude.cmd`, launchFs, pathValue: "C:\\Windows" });
    await missing.service.open({ ticketKey: "PROJ-1" });
    expect(missing.spawned[0].file).toBe("cmd.exe");
  });

  it("asks for a memory catch-up sync of the ticket on every new or resumed session it starts (final review 6)", async () => {
    const synced: string[] = [];
    const { service, sessions } = await setup({ syncMemory: (key) => synced.push(key) });
    await service.open({ ticketKey: "PROJ-1" });
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: "/elsewhere", origin: "butler", createdAt: 1 });
    await service.open({ ticketKey: "PROJ-1", sessionId: "old" });
    // 已经开着的 session 只是切过去，不再同步；不存在的 ticket 什么都不做。
    await service.open({ ticketKey: "PROJ-1", sessionId: "old" });
    await service.open({ ticketKey: "NOPE-1" });
    expect(synced).toEqual(["PROJ-1", "PROJ-1"]);
  });

  it("opens the session anyway when starting the memory sync throws, and only logs it", async () => {
    const { service, spawned, logs } = await setup({
      syncMemory: () => {
        throw new Error("queue gone");
      },
    });
    expect(await service.open({ ticketKey: "PROJ-1" })).toMatchObject({ ok: true });
    expect(spawned).toHaveLength(1);
    expect(logs.some((l) => l.includes("memory sync for PROJ-1 not started"))).toBe(true);
  });

  it("starts a new session in the ticket workdir with Butler env", async () => {
    const { service, sessions, spawned, ticket } = await setup();
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: true, termId: "new-1", alreadyOpen: false });
    expect(spawned[0].file).toBe("/bin/claude");
    expect(spawned[0].args).toEqual(["--session-id", "new-1"]);
    expect(spawned[0].opts.cwd).toBe(ticket.repos[0].worktreePath);
    expect(spawned[0].opts.env).toMatchObject({ PATH: "/login/bin", BUTLER_TICKET: "PROJ-1", BUTLER_SESSION: "new-1" });
    expect(sessions.get("new-1")).toMatchObject({ ticketKey: "PROJ-1", origin: "butler", cwd: ticket.repos[0].worktreePath });
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

  it("starts a session with no saved transcript fresh under the same id instead of resuming", async () => {
    const { service, sessions, spawned } = await setup({ transcripts: [] });
    sessions.insertIfAbsent({ id: "empty", ticketKey: "PROJ-1", cwd: "/elsewhere", origin: "butler", createdAt: 1 });
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "empty" })).toEqual({ ok: true, termId: "empty", alreadyOpen: false });
    expect(spawned[0].args).toEqual(["--session-id", "empty"]);
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

  it("waits for the first health refresh before deciding claude is missing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service, spawned } = await setup({ ready: () => gate });
    let settled = false;
    const p = service.open({ ticketKey: "PROJ-1" }).then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    release();
    expect(await p).toMatchObject({ ok: true });
    expect(spawned).toHaveLength(1);
  });

  it("reports missing claude, unknown ticket and unknown session", async () => {
    const { service } = await setup({ claudePath: null });
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: false, reason: "claude_missing" });
    expect(await service.open({ ticketKey: "NOPE-1" })).toEqual({ ok: false, reason: "no_ticket" });
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "ghost" })).toEqual({ ok: false, reason: "no_session" });
  });

  it("stops on a branch mismatch unless forced", async () => {
    const { service, spawned, repo, ticket } = await setup({ workMode: "branch" });
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({
      ok: false, reason: "branch_mismatch", repoId: ticket.repos[0].id, current: "main", expected: "feature/PROJ-1", dirty: false,
    });
    writeFileSync(join(repo, "README.md"), "dirty\n");
    expect(await service.open({ ticketKey: "PROJ-1" })).toMatchObject({ reason: "branch_mismatch", dirty: true });
    expect(spawned).toHaveLength(0);
    expect(await service.open({ ticketKey: "PROJ-1", force: true })).toMatchObject({ ok: true });
    expect(spawned[0].opts.cwd).toBe(repo);
  });
  it("prefills a single line even when the request text has newlines", async () => {
    const { service, spawned } = await setup();
    await service.open({ ticketKey: "PROJ-1" });
    spawned[0].pty.emit("ready");
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "new-1", prefill: "继续\n做 PROJ-1\r\n" })).toMatchObject({ alreadyOpen: true });
    expect(spawned[0].pty.written).toEqual(["继续 做 PROJ-1"]);
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

describe("SessionService orphan rows", () => {
  it("removes the row it inserted when claude cannot be spawned", async () => {
    const { service, sessions } = await setup({
      factory: () => {
        throw new Error("spawn ENOENT");
      },
    });
    await expect(service.open({ ticketKey: "PROJ-1" })).rejects.toThrow("spawn ENOENT");
    expect(sessions.listByTicket("PROJ-1")).toEqual([]);
  });

  it("forgets a new session that exited before the first message and keeps real ones", async () => {
    const { service, sessions } = await setup({ transcripts: [] });
    await service.open({ ticketKey: "PROJ-1" });
    await service.open({ ticketKey: "PROJ-1" });
    sessions.fillDetails("new-2", { firstPrompt: "修登录" });
    service.handleExit("new-1");
    service.handleExit("new-2");
    expect(sessions.get("new-1")).toBeNull();
    expect(sessions.get("new-2")).not.toBeNull();
  });

  it("keeps the row when the transcript state cannot be determined", async () => {
    const { service, sessions } = await setup({ transcriptState: "unknown" });
    await service.open({ ticketKey: "PROJ-1" });
    service.handleExit("new-1");
    expect(sessions.get("new-1")).not.toBeNull();
  });

  it("keeps sessions that have a transcript", async () => {
    const { service, sessions } = await setup({ transcripts: ["new-1"] });
    await service.open({ ticketKey: "PROJ-1" });
    service.handleExit("new-1");
    expect(sessions.get("new-1")).not.toBeNull();
  });
});

describe("SessionService.pruneEmptySessions (startup, after a quit that skipped handleExit)", () => {
  const row = (id: string, extra: Partial<{ origin: "butler" | "discovered"; firstPrompt: string }> = {}) => ({
    id, ticketKey: "PROJ-1", cwd: "/w", origin: extra.origin ?? ("butler" as const), firstPrompt: extra.firstPrompt ?? null, createdAt: 1,
  });

  it("deletes only Butler sessions with no prompt, no replacement and no transcript", async () => {
    const { service, sessions } = await setup({ transcripts: ["has-transcript"] });
    sessions.insertIfAbsent(row("empty"));
    sessions.insertIfAbsent(row("prompted", { firstPrompt: "修登录" }));
    sessions.insertIfAbsent(row("discovered", { origin: "discovered" }));
    sessions.insertIfAbsent(row("has-transcript"));
    sessions.insertIfAbsent(row("cleared"));
    sessions.insertIfAbsent(row("after-clear", { firstPrompt: "继续" }));
    sessions.setReplacedBy("cleared", "after-clear");
    expect(service.pruneEmptySessions()).toBe(1);
    expect(sessions.get("empty")).toBeNull();
    for (const id of ["prompted", "discovered", "has-transcript", "cleared", "after-clear"]) expect(sessions.get(id), id).not.toBeNull();
  });

  it("keeps rows whose transcript state is unknown", async () => {
    const { service, sessions } = await setup({ transcriptState: "unknown" });
    sessions.insertIfAbsent(row("empty"));
    expect(service.pruneEmptySessions()).toBe(0);
    expect(sessions.get("empty")).not.toBeNull();
  });

  it("never deletes a session whose terminal is still open", async () => {
    const { service, sessions } = await setup({ transcripts: [] });
    await service.open({ ticketKey: "PROJ-1" });
    sessions.insertIfAbsent(row("orphan"));
    expect(service.pruneEmptySessions()).toBe(1);
    expect(sessions.get("new-1")).not.toBeNull();
    expect(sessions.get("orphan")).toBeNull();
  });
});

describe("SessionService.hasOpenTerminal", () => {
  it("is true only while one of the ticket's terminals is running", async () => {
    const { service, spawned, tickets, ticketService, repo } = await setup();
    await ticketService.create({ key: "PROJ-2", repoPath: repo, workMode: "branch" });
    expect(service.hasOpenTerminal("PROJ-1")).toBe(false);
    await service.open({ ticketKey: "PROJ-1" });
    expect(service.hasOpenTerminal("PROJ-1")).toBe(true);
    expect(service.hasOpenTerminal("PROJ-2")).toBe(false);
    spawned[0].pty.emitExit(0);
    expect(service.hasOpenTerminal("PROJ-1")).toBe(false);
    expect(tickets.get("PROJ-2")).not.toBeNull();
  });
});

describe("SessionService.open after the ticket's work mode changed", () => {
  it("warns before resuming an old session in a worktree that left the ticket branch; force opens it there", async () => {
    const { service, sessions, ticket, ticketService, spawned } = await setup({ workMode: "worktree" });
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: ticket.repos[0].worktreePath!, origin: "butler", createdAt: 1, repoId: ticket.repos[0].id });
    await ticketService.updateRepo({ repoId: ticket.repos[0].id, workMode: "branch" }, { terminalsOpen: false });
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "old" })).toEqual({
      ok: false, reason: "old_workdir", cwd: ticket.repos[0].worktreePath, current: "HEAD", expected: "feature/PROJ-1",
    });
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "old", force: true })).toMatchObject({ ok: true, termId: "old" });
    expect(spawned[0].opts.cwd).toBe(ticket.repos[0].worktreePath);
  });

  it("does not open sessions while the ticket is being changed", async () => {
    const { service, ticketService, ticket } = await setup({ workMode: "worktree" });
    const update = ticketService.updateRepo({ repoId: ticket.repos[0].id, workMode: "branch" }, { terminalsOpen: false });
    expect(await service.open({ ticketKey: "PROJ-1", force: true })).toEqual({ ok: false, reason: "ticket_busy" });
    await update;
  });
});

describe("SessionService with several repos and the coordinator", () => {
  async function multi() {
    const env = await setup({ workMode: "worktree" });
    const api = makeRepo();
    await env.ticketService.addRepo({ ticketKey: "PROJ-1", repoPath: api, workMode: "worktree" });
    const t = env.tickets.get("PROJ-1")!;
    return { ...env, api, web: t.repos[0], apiRepo: t.repos[1] };
  }

  it("asks which repo when there are several, and opens in the chosen one", async () => {
    const { service, spawned, sessions, web, apiRepo } = await multi();
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: false, reason: "pick_repo" });
    expect(await service.open({ ticketKey: "PROJ-1", repoId: 999 })).toEqual({ ok: false, reason: "no_repo" });
    await service.open({ ticketKey: "PROJ-1", repoId: apiRepo.id });
    expect(spawned[0].opts.cwd).toBe(apiRepo.worktreePath);
    expect(sessions.get("new-1")).toMatchObject({ repoId: apiRepo.id, coordinator: false, spawnedBy: null });
    await service.open({ ticketKey: "PROJ-1", repoId: web.id });
    expect(spawned[1].opts.cwd).toBe(web.worktreePath);
  });

  it("opens the coordinator in the ticket workspace with every repo added, and resumes it the same way", async () => {
    const { service, spawned, sessions, web, apiRepo, ticketService, pty } = await multi();
    await service.open({ ticketKey: "PROJ-1", coordinator: true });
    expect(spawned[0].opts.cwd).toBe(ticketService.workspaceDir("PROJ-1"));
    expect(spawned[0].args).toEqual(["--session-id", "new-1", "--add-dir", web.worktreePath, "--add-dir", apiRepo.worktreePath]);
    expect(sessions.get("new-1")).toMatchObject({ coordinator: true, repoId: null });
    pty.kill("new-1");
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "new-1" })).toMatchObject({ ok: true });
    expect(spawned[1].args).toEqual(["--resume", "new-1", "--add-dir", web.worktreePath, "--add-dir", apiRepo.worktreePath]);
  });

  it("opens only the coordinator on a ticket without repos", async () => {
    const { service, spawned, ticketService } = await setup();
    await ticketService.create({ key: "BARE-1" });
    expect(await service.open({ ticketKey: "BARE-1" })).toEqual({ ok: false, reason: "no_repo" });
    expect(await service.open({ ticketKey: "BARE-1", coordinator: true })).toMatchObject({ ok: true });
    expect(spawned[0].args).toEqual(["--session-id", "new-1"]);
  });

  it("tells the memory config whether the session is the coordinator", async () => {
    const seen: [string, boolean][] = [];
    const { service } = await setup({ mcpConfig: (key, o) => (seen.push([key, o.coordinator]), null) });
    await service.open({ ticketKey: "PROJ-1" });
    await service.open({ ticketKey: "PROJ-1", coordinator: true });
    expect(seen).toEqual([["PROJ-1", false], ["PROJ-1", true]]);
  });

  it("counts terminals per repo: the repo's own, the coordinator, and sessions of no known repo", async () => {
    const { service, sessions, web, apiRepo } = await multi();
    await service.open({ ticketKey: "PROJ-1", repoId: web.id });
    expect(service.hasOpenTerminal("PROJ-1", web.id)).toBe(true);
    expect(service.hasOpenTerminal("PROJ-1", apiRepo.id)).toBe(false);
    await service.open({ ticketKey: "PROJ-1", coordinator: true });
    expect(service.hasOpenTerminal("PROJ-1", apiRepo.id)).toBe(true);
    expect(service.openTerminalCount("PROJ-1")).toBe(2);
    expect(sessions.get("new-2")?.coordinator).toBe(true);
  });

  it("files a claimed session under the repo its directory is in", async () => {
    const { service, sessions, apiRepo } = await multi();
    sessions.insertIfAbsent({ id: "ext", ticketKey: null, cwd: join(apiRepo.worktreePath!, "src"), origin: "discovered", createdAt: 1 });
    service.claim("ext", "PROJ-1");
    expect(sessions.get("ext")).toMatchObject({ ticketKey: "PROJ-1", repoId: apiRepo.id });
  });
});

describe("SessionService.hide / unhide", () => {
  it("hides a finished session from the ticket list (records kept), refuses a running one, and can bring it back", async () => {
    const { service, sessions, spawned } = await setup();
    await service.open({ ticketKey: "PROJ-1" });
    expect(() => service.hide("new-1")).toThrow(expect.objectContaining({ code: "sessions_open" }));
    spawned[0].pty.emitExit(0);
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1, firstPrompt: "旧的对话" });
    service.hide("old");
    const [view] = service.ticketViews();
    expect(view.sessions.map((s) => s.id)).not.toContain("old");
    expect(view.hiddenSessions.map((s) => s.id)).toEqual(["old"]);
    expect(sessions.get("old")).toMatchObject({ ticketKey: "PROJ-1", firstPrompt: "旧的对话", dismissed: true });

    // 隐藏的 session 等你输入也不在侧栏亮灯。
    sessions.setWaiting("old", true, 2000);
    expect(service.ticketViews()[0].waiting).toBe(false);

    service.unhide("old");
    expect(service.ticketViews()[0].sessions.map((s) => s.id)).toContain("old");
    expect(service.ticketViews()[0].hiddenSessions).toEqual([]);
    expect(() => service.hide("no-such")).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("keeps showing a hidden session while its terminal runs again", async () => {
    const { service, sessions } = await setup({ transcripts: ["old"] });
    sessions.insertIfAbsent({ id: "old", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    service.hide("old");
    await service.open({ ticketKey: "PROJ-1", sessionId: "old", force: true });
    const [view] = service.ticketViews();
    expect(view.sessions.map((s) => s.id)).toContain("old");
    expect(view.hiddenSessions).toEqual([]);
  });
});
