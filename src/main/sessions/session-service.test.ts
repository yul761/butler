import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { TicketService } from "../tickets/ticket-service";
import { NPM_EXE_SHIM, NPM_SHIM, PNPM_NODE_PATH, PNPM_NODE_PATH_SHIM } from "../claude/__fixtures__/shims";
import { fakePtyFactory, makeRepo, memDb } from "../test-utils";
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
  mcpConfig?: (ticketKey: string) => string | null;
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
  const ticketService = new TicketService({ tickets, settings, now: () => 1 });
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
    syncMemory: opts.syncMemory,
    launchFs: opts.launchFs,
    log: (m) => logs.push(m),
  });
  const repo = makeRepo();
  const ticket = await ticketService.create({ key: "PROJ-1", repoPath: repo, workMode: opts.workMode ?? "worktree" });
  return { service, sessions, tickets, spawned, pty, repo, ticket, ticketService, logs };
}

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
    expect(shim.logs.some((l) => l.includes("memory MCP not mounted for PROJ-1"))).toBe(true);
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
    expect(shim.logs.some((l) => l.includes("memory MCP not mounted"))).toBe(false);
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
    expect(shim.logs.some((l) => l.includes("memory MCP not mounted"))).toBe(false);
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
    const { service, spawned, repo } = await setup({ workMode: "branch" });
    expect(await service.open({ ticketKey: "PROJ-1" })).toEqual({ ok: false, reason: "branch_mismatch", current: "main", expected: "feature/PROJ-1", dirty: false });
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
