import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { shipherdMcpFile, featureMcpFile, hubRoutes, memoryServers, pruneTerminalMcpConfigs, writeForkMcpConfig, FORK_MCP_SUBDIR, removeTerminalMcpConfig, terminalMcpFile, writeTerminalMcpConfig, removeFeatureMcpConfig, removeTicketMcpConfigs, SESSIONS_AUTO_ALLOW, sessionsServer, TICKET_MCP_SUBDIR, ticketMcpFile, writeShipherdMcpConfig, writeFeatureMcpConfig, writeTicketMcpConfig } from "./mcp-config";

const launcher = { command: "/Applications/Shipherd.app/Contents/MacOS/Shipherd", script: "/Applications/Shipherd.app/Contents/Resources/memory-mcp/statecore-mcp.cjs" };

describe("ticket MCP config (design 4.2, 8.4)", () => {
  it("mounts the ticket scope and the workspace scope under Shipherd's own server names", () => {
    const server = (scope: string) => ({
      type: "stdio",
      command: launcher.command,
      args: [launcher.script, "--data", "/h/.shipherd/statecore"],
      env: { ELECTRON_RUN_AS_NODE: "1", STATECORE_SCOPE: scope, LOG_LEVEL: "warn" },
    });
    expect(memoryServers({ launcher, statecoreDir: "/h/.shipherd/statecore", ticketKey: "PROJ-1" })).toEqual({
      "shipherd-memory": server("ticket:PROJ-1"),
      "shipherd-workspace": server("workspace"),
    });
  });

  it("writes mcp/tickets/<ticket>.json privately, replaces it atomically and never puts a model key in it (R1)", () => {
    const mcpDir = join(tempDir(), "mcp");
    const file = writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", servers: memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "PROJ-1" }) });
    expect(file).toBe(join(mcpDir, "tickets", "PROJ-1.json"));
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({ mcpServers: memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "PROJ-1" }) });
    expect(text).not.toMatch(/MODEL_|OPENAI|ANTHROPIC|FEATURE_LLM|API_KEY/i);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", servers: memoryServers({ launcher, statecoreDir: "/sc2", ticketKey: "PROJ-1" }) });
    expect(readFileSync(file, "utf8")).toContain("/sc2");
    expect(readdirSync(mcpDir)).toEqual(["tickets"]);
    expect(readdirSync(join(mcpDir, "tickets"))).toEqual(["PROJ-1.json"]);
  });

  it("keeps the coordinator's config (with the coordinator's shipherd-sessions) in its own file", () => {
    const mcpDir = join(tempDir(), "mcp");
    const sessions = sessionsServer({ launcher, scope: { ticketKey: "PROJ-1" }, requestsDir: "/b/control/requests", resultsDir: "/b/control/results" });
    expect(sessions).toEqual({
      "shipherd-sessions": {
        type: "stdio", command: launcher.command, args: [launcher.script],
        env: { ELECTRON_RUN_AS_NODE: "1", SHIPHERD_TICKET: "PROJ-1", SHIPHERD_LANG: "zh", SHIPHERD_CONTROL_REQUESTS: "/b/control/requests", SHIPHERD_CONTROL_RESULTS: "/b/control/results" },
      },
    });
    const plain = writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", servers: memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "PROJ-1" }) });
    // 以前 ticket 总控（BTL-246 起没有了）留下的配置：归档时一起删掉。
    const boss = join(mcpDir, "tickets", "coordinator", "PROJ-1.json");
    mkdirSync(dirname(boss), { recursive: true });
    writeFileSync(boss, "{}");
    expect(readFileSync(plain, "utf8")).not.toContain("shipherd-sessions");
    removeTicketMcpConfigs(mcpDir, "PROJ-1");
    expect(existsSync(plain) || existsSync(boss)).toBe(false);
    removeTicketMcpConfigs(mcpDir, "PROJ-1");
  });

  it("keeps the file for an odd ticket key inside mcpDir/tickets (Review Focus 5)", () => {
    const mcpDir = join(tempDir(), "mcp");
    for (const key of ["../../etc/passwd", "A B/C", "..", "PROJ-1", "名字-1", "", "A.", "CON", "x".repeat(300)]) {
      const f = ticketMcpFile(mcpDir, key);
      expect(dirname(f), key).toBe(join(mcpDir, TICKET_MCP_SUBDIR));
      expect(basename(f), key).toMatch(/^[A-Za-z0-9._-]+\.json$/);
    }
    expect(ticketMcpFile(mcpDir, "A B")).not.toBe(ticketMcpFile(mcpDir, "A_B"));
    expect(ticketMcpFile(mcpDir, "PROJ-1")).toBe(join(mcpDir, "tickets", "PROJ-1.json"));
  });

  it("can never land on a plan-3 project-/local- file, even on a case-insensitive filesystem (P4-R6)", () => {
    const mcpDir = join(tempDir(), "mcp");
    for (const key of ["PROJECT-123456789012", "project-123456789012", "LOCAL-123456789012", "local-123456789012"]) {
      const f = ticketMcpFile(mcpDir, key);
      // 计划 3 的文件是 mcpDir 下的直接子文件：project-<12 hex>.json / local-<12 hex>.json。
      expect(dirname(f), key).not.toBe(mcpDir);
      expect(f.toLowerCase(), key).not.toBe(join(mcpDir, `${key}.json`).toLowerCase());
      expect(dirname(f), key).toBe(join(mcpDir, TICKET_MCP_SUBDIR));
    }
  });

  it("caps long keys and avoids Windows reserved names with a truncated key plus a hash of the full key", () => {
    const mcpDir = join(tempDir(), "mcp");
    const name = (key: string) => basename(ticketMcpFile(mcpDir, key), ".json");

    // 80 个字符以内原样保留；更长的截到 60 个字符再加 8 位哈希，结果稳定、不同的 key 不撞名。
    expect(name(`A-${"1".repeat(78)}`)).toBe(`A-${"1".repeat(78)}`);
    const long1 = `A-${"1".repeat(200)}`;
    const long2 = `A-${"1".repeat(201)}`;
    expect(name(long1)).toMatch(/^A-1{58}-[0-9a-f]{8}$/);
    expect(name(long1)).toBe(name(long1));
    expect(name(long1)).not.toBe(name(long2));

    // 保留名不分大小写、带不带扩展名都换掉；换出来的名字不含点，Windows 不会再把它当设备名。
    const reserved = ["CON", "con", "PRN", "AUX", "NUL", "nul.txt", "COM1", "com9.json", "LPT1", "Lpt9", "CON.foo.bar"];
    for (const key of reserved) {
      expect(name(key), key).toMatch(/^[A-Za-z0-9_]+-[0-9a-f]{8}$/);
      expect(name(key), key).not.toMatch(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i);
    }
    expect(new Set(reserved.map(name)).size).toBe(reserved.length);
    // 只是以保留名开头的普通 key 不受影响。
    for (const key of ["CONF-1", "COM10", "LPT0", "NULL-2"]) expect(name(key), key).toBe(key);
    // Windows 会吃掉结尾的点：以点结尾的 key 也换成带哈希的名字。
    expect(name("A.")).toMatch(/^A_-[0-9a-f]{8}$/);
  });
});

describe("feature memory and coordinator config (design 2026-10-26)", () => {
  it("adds shipherd-feature to a feature ticket's servers, and gives the feature coordinator no ticket memory", () => {
    const ticket = memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "DMS-1", featureId: 7 });
    expect(Object.keys(ticket)).toEqual(["shipherd-memory", "shipherd-workspace", "shipherd-feature"]);
    expect(ticket["shipherd-feature"].env.STATECORE_SCOPE).toBe("feature:7");
    const coord = memoryServers({ launcher, statecoreDir: "/sc", featureId: 7 });
    expect(Object.keys(coord)).toEqual(["shipherd-workspace", "shipherd-feature"]);
  });

  it("points the feature coordinator's sessions server at the feature, not a ticket", () => {
    const s = sessionsServer({ launcher, scope: { featureId: 7 }, requestsDir: "/req", resultsDir: "/res" })["shipherd-sessions"];
    expect(s.env.SHIPHERD_FEATURE).toBe("7");
    expect(s.env.SHIPHERD_TICKET).toBeUndefined();
    const t = sessionsServer({ launcher, scope: { ticketKey: "A-1" }, requestsDir: "/req", resultsDir: "/res" })["shipherd-sessions"];
    expect(t.env.SHIPHERD_TICKET).toBe("A-1");
    expect(t.env.SHIPHERD_MEMBER).toBeUndefined();
  });

  it("gives a ticket session a sessions server scoped to its ticket (BTL-190 2+3)", () => {
    const m = sessionsServer({ launcher, scope: { ticketKey: "A-1" }, requestsDir: "/req", resultsDir: "/res" })["shipherd-sessions"];
    expect(m.env).toMatchObject({ SHIPHERD_TICKET: "A-1", SHIPHERD_CONTROL_REQUESTS: "/req", SHIPHERD_CONTROL_RESULTS: "/res" });
  });

  it("writes and removes the feature's config under mcp/features", () => {
    const mcpDir = tempDir();
    const file = writeFeatureMcpConfig({ mcpDir, featureId: 7, servers: memoryServers({ launcher, statecoreDir: "/sc", featureId: 7 }) });
    expect(file).toBe(featureMcpFile(mcpDir, 7));
    expect(file).toBe(join(mcpDir, "features", "7.json"));
    expect(existsSync(file)).toBe(true);
    removeFeatureMcpConfig(mcpDir, 7);
    expect(existsSync(file)).toBe(false);
  });
});

describe("sessions tools allowed without a prompt (BTL-190 2+3)", () => {
  it("are only ask_user and report of the sessions server", () => {
    expect(SESSIONS_AUTO_ALLOW).toEqual([
      "mcp__shipherd-sessions__ask_user", "mcp__shipherd-sessions__report",
      "mcp__shipherd-sessions__list_epics", "mcp__shipherd-sessions__list_features", "mcp__shipherd-sessions__list_tickets",
      "mcp__shipherd-sessions__list_prs", "mcp__shipherd-sessions__list_sessions", "mcp__shipherd-sessions__session_activity",
      "mcp__shipherd-sessions__list_inbox", "mcp__shipherd-sessions__progress_overview", "mcp__shipherd-sessions__metrics_overview",
      "mcp__shipherd-sessions__list_stacks",
      "mcp__shipherd-sessions__reorder_features", "mcp__shipherd-sessions__set_ticket_feature",
      "mcp__shipherd-sessions__submit_evidence", "mcp__shipherd-sessions__pre_review_result", "mcp__shipherd-sessions__pr_assessment",
      "mcp__shipherd-sessions__workflow_step_done", "mcp__shipherd-sessions__get_workflow", "mcp__shipherd-sessions__list_workflow_presets",
    ]);
    // 会动别的终端或建东西的不在里面。
    for (const t of ["start_session", "end_session", "send_message", "refresh_session", "refresh_epic_summary", "create_ticket", "create_feature", "start_feature", "stack_define", "stack_rebase", "stack_layer_mode", "set_workflow"]) {
      expect(SESSIONS_AUTO_ALLOW).not.toContain(`mcp__shipherd-sessions__${t}`);
    }
  });
});

describe("feature coordinator sessions server", () => {
  it("points it at the feature and nothing else", () => {
    const s = sessionsServer({ launcher, scope: { featureId: 7 }, requestsDir: "/req", resultsDir: "/res" })["shipherd-sessions"];
    expect(s.env.SHIPHERD_FEATURE).toBe("7");
    for (const k of ["SHIPHERD_TICKET", "SHIPHERD_SCOPE"]) expect(s.env[k]).toBeUndefined();
  });

  it("no longer writes the old epic variables (BTL-246)", () => {
    for (const scope of [{ featureId: 7 }, { ticketKey: "A-1" }, { shipherd: true as const }]) {
      const env = sessionsServer({ launcher, scope, requestsDir: "/req", resultsDir: "/res" })["shipherd-sessions"].env;
      expect(env.SHIPHERD_EPIC).toBeUndefined();
      expect(env.SHIPHERD_FEATURE_EPIC).toBeUndefined();
    }
  });
});

describe("Shipherd 总控 config (BTL-190 5)", () => {
  it("gives it only shipherd-workspace for memory, and a sessions server with the shipherd scope", () => {
    expect(Object.keys(memoryServers({ launcher, statecoreDir: "/sc" }))).toEqual(["shipherd-workspace"]);
    const s = sessionsServer({ launcher, scope: { shipherd: true }, requestsDir: "/req", resultsDir: "/res" })["shipherd-sessions"];
    expect(s.env.SHIPHERD_SCOPE).toBe("shipherd");
    for (const k of ["SHIPHERD_FEATURE", "SHIPHERD_TICKET", "SHIPHERD_MEMBER"]) expect(s.env[k]).toBeUndefined();
    expect(s.env).toMatchObject({ SHIPHERD_CONTROL_REQUESTS: "/req", SHIPHERD_CONTROL_RESULTS: "/res" });
  });

  it("writes its config to mcp/shipherd.json", () => {
    const mcpDir = tempDir();
    const servers = memoryServers({ launcher, statecoreDir: "/sc" });
    const file = writeShipherdMcpConfig({ mcpDir, servers });
    expect(file).toBe(shipherdMcpFile(mcpDir));
    expect(file).toBe(join(mcpDir, "shipherd.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: servers });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("shared MCP config (WS-M H)", () => {
  it("turns the stdio servers into hub routes: memory by scope, shipherd-sessions with its variables and the terminal as caller", () => {
    const servers = {
      ...memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "PROJ-1", featureId: 3 }),
      ...sessionsServer({ launcher, scope: { ticketKey: "PROJ-1" }, requestsDir: "/req", resultsDir: "/res" }),
    };
    expect(hubRoutes(servers, "term-1")).toEqual({
      "shipherd-memory": { server: "memory", scope: "ticket:PROJ-1" },
      "shipherd-workspace": { server: "memory", scope: "workspace" },
      "shipherd-feature": { server: "memory", scope: "feature:3" },
      "shipherd-sessions": {
        server: "sessions",
        from: "term-1",
        env: { SHIPHERD_TICKET: "PROJ-1", SHIPHERD_LANG: expect.any(String), SHIPHERD_CONTROL_REQUESTS: "/req", SHIPHERD_CONTROL_RESULTS: "/res" },
      },
    });
  });

  it("gives up on a server it does not know, so the terminal keeps stdio", () => {
    expect(hubRoutes({ other: { type: "stdio", command: "x", args: [], env: {} } }, "t")).toBeNull();
  });

  it("writes one private config per terminal under mcp/terms and removes it again", () => {
    const mcpDir = tempDir();
    const servers = { "shipherd-workspace": { type: "http" as const, url: "http://127.0.0.1:4100/mcp/abc" } };
    const file = writeTerminalMcpConfig({ mcpDir, termId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", servers });
    expect(file).toBe(join(mcpDir, "terms", "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: servers });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    removeTerminalMcpConfig(mcpDir, "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
    expect(existsSync(file)).toBe(false);
    removeTerminalMcpConfig(mcpDir, "never-written");
  });

  it("keeps a terminal id with odd characters inside mcp/terms", () => {
    expect(dirname(terminalMcpFile("/m", "../../etc/x"))).toBe(join("/m", "terms"));
  });

  it("clears the configs left from the last run at startup", () => {
    const mcpDir = tempDir();
    expect(pruneTerminalMcpConfigs(mcpDir)).toBe(0);
    writeTerminalMcpConfig({ mcpDir, termId: "a", servers: {} });
    writeTerminalMcpConfig({ mcpDir, termId: "b", servers: {} });
    expect(pruneTerminalMcpConfigs(mcpDir)).toBe(2);
    expect(readdirSync(join(mcpDir, "terms"))).toEqual([]);
  });
});

describe("fork MCP config (Task 8 review I1)", () => {
  const servers = memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "PROJ-1", featureId: 3 });

  it("writes the stdio servers to a private file under mcp/forks named by content, so the same set reuses one file", () => {
    const mcpDir = tempDir();
    const file = writeForkMcpConfig({ mcpDir, servers });
    expect(dirname(file)).toBe(join(mcpDir, FORK_MCP_SUBDIR));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: servers });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(writeForkMcpConfig({ mcpDir, servers })).toBe(file);
    // 换了 server 组（比如记忆关了）写到另一个文件，之前分叉接着问时用的那份不动。
    const other = writeForkMcpConfig({ mcpDir, servers: {} });
    expect(other).not.toBe(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: servers });
  });

  it("survives the startup prune of terminal configs, so a follow-up after a restart still finds it", () => {
    const mcpDir = tempDir();
    const file = writeForkMcpConfig({ mcpDir, servers });
    writeTerminalMcpConfig({ mcpDir, termId: "fork-run-1", servers: {} });
    expect(pruneTerminalMcpConfigs(mcpDir)).toBe(1);
    expect(existsSync(file)).toBe(true);
  });
});
