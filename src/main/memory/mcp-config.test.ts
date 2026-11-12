import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { epicMcpFile, featureMcpFile, memoryServers, removeEpicMcpConfig, removeFeatureMcpConfig, removeTicketMcpConfigs, sessionsServer, TICKET_MCP_SUBDIR, ticketMcpFile, writeEpicMcpConfig, writeFeatureMcpConfig, writeTicketMcpConfig } from "./mcp-config";

const launcher = { command: "/Applications/Butler.app/Contents/MacOS/Butler", script: "/Applications/Butler.app/Contents/Resources/memory-mcp/statecore-mcp.cjs" };

describe("ticket MCP config (design 4.2, 8.4)", () => {
  it("mounts the ticket scope and the workspace scope under Butler's own server names", () => {
    const server = (scope: string) => ({
      type: "stdio",
      command: launcher.command,
      args: [launcher.script, "--data", "/h/.butler/statecore"],
      env: { ELECTRON_RUN_AS_NODE: "1", STATECORE_SCOPE: scope, LOG_LEVEL: "warn" },
    });
    expect(memoryServers({ launcher, statecoreDir: "/h/.butler/statecore", ticketKey: "PROJ-1" })).toEqual({
      "butler-memory": server("ticket:PROJ-1"),
      "butler-workspace": server("workspace"),
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

  it("keeps the coordinator's config (with the coordinator's butler-sessions) in its own file", () => {
    const mcpDir = join(tempDir(), "mcp");
    const sessions = sessionsServer({ launcher, scope: { ticketKey: "PROJ-1" }, requestsDir: "/b/control/requests", resultsDir: "/b/control/results" });
    expect(sessions).toEqual({
      "butler-sessions": {
        type: "stdio", command: launcher.command, args: [launcher.script],
        env: { ELECTRON_RUN_AS_NODE: "1", BUTLER_TICKET: "PROJ-1", BUTLER_LANG: "zh", BUTLER_CONTROL_REQUESTS: "/b/control/requests", BUTLER_CONTROL_RESULTS: "/b/control/results" },
      },
    });
    const plain = writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", servers: memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "PROJ-1" }) });
    const boss = writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", servers: sessions, coordinator: true });
    expect(boss).toBe(join(mcpDir, "tickets", "coordinator", "PROJ-1.json"));
    // 叫 PROJ-1-coordinator 的 ticket 也不会和 PROJ-1 的总控配置撞上。
    expect(ticketMcpFile(mcpDir, "PROJ-1-coordinator")).not.toBe(boss);
    expect(readFileSync(plain, "utf8")).not.toContain("butler-sessions");
    expect(readFileSync(boss, "utf8")).not.toContain("BUTLER_MEMBER");
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
  it("adds butler-feature to a feature ticket's servers, and gives the feature coordinator no ticket memory", () => {
    const ticket = memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "DMS-1", featureId: 7 });
    expect(Object.keys(ticket)).toEqual(["butler-memory", "butler-workspace", "butler-feature"]);
    expect(ticket["butler-feature"].env.STATECORE_SCOPE).toBe("feature:7");
    const coord = memoryServers({ launcher, statecoreDir: "/sc", featureId: 7 });
    expect(Object.keys(coord)).toEqual(["butler-workspace", "butler-feature"]);
  });

  it("points the feature coordinator's sessions server at the feature, not a ticket", () => {
    const s = sessionsServer({ launcher, scope: { featureId: 7 }, requestsDir: "/req", resultsDir: "/res" })["butler-sessions"];
    expect(s.env.BUTLER_FEATURE).toBe("7");
    expect(s.env.BUTLER_TICKET).toBeUndefined();
    const t = sessionsServer({ launcher, scope: { ticketKey: "A-1" }, requestsDir: "/req", resultsDir: "/res" })["butler-sessions"];
    expect(t.env.BUTLER_TICKET).toBe("A-1");
    expect(t.env.BUTLER_MEMBER).toBeUndefined();
  });

  it("gives a normal ticket session a member sessions server: only ask_user and report (BTL-190 2+3)", () => {
    const m = sessionsServer({ launcher, scope: { ticketKey: "A-1", member: true }, requestsDir: "/req", resultsDir: "/res" })["butler-sessions"];
    expect(m.env).toMatchObject({ BUTLER_TICKET: "A-1", BUTLER_MEMBER: "1", BUTLER_CONTROL_REQUESTS: "/req", BUTLER_CONTROL_RESULTS: "/res" });
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

describe("epic memory (design 2026-11-01)", () => {
  const servers = (o: { ticketKey?: string; featureId?: number | null; epicId?: number | null }) => memoryServers({ launcher, statecoreDir: "/sc", ...o });

  it("gives the epic session butler-epic and butler-workspace, and no ticket or feature memory", () => {
    const epic = servers({ epicId: 4 });
    expect(Object.keys(epic).sort()).toEqual(["butler-epic", "butler-workspace"]);
    expect(epic["butler-epic"].env.STATECORE_SCOPE).toBe("epic:4");
  });

  it("adds butler-epic to the coordinator and the ticket sessions of a feature in an epic", () => {
    expect(Object.keys(servers({ featureId: 7, epicId: 4 }))).toEqual(["butler-workspace", "butler-feature", "butler-epic"]);
    const ticket = servers({ ticketKey: "DMS-1", featureId: 7, epicId: 4 });
    expect(Object.keys(ticket)).toEqual(["butler-memory", "butler-workspace", "butler-feature", "butler-epic"]);
    expect(ticket["butler-epic"].env.STATECORE_SCOPE).toBe("epic:4");
  });

  it("leaves features and tickets outside an epic with the servers they had", () => {
    expect(servers({ featureId: 7, epicId: null })).toEqual(servers({ featureId: 7 }));
    expect(servers({ ticketKey: "DMS-1", featureId: 7, epicId: null })).toEqual(servers({ ticketKey: "DMS-1", featureId: 7 }));
    expect(servers({ ticketKey: "A-1", epicId: null })).toEqual(servers({ ticketKey: "A-1" }));
    expect(Object.keys(servers({ ticketKey: "A-1", featureId: null, epicId: null }))).toEqual(["butler-memory", "butler-workspace"]);
  });

  it("writes the epic's config under mcp/epics", () => {
    const mcpDir = tempDir();
    const file = writeEpicMcpConfig({ mcpDir, epicId: 4, servers: servers({ epicId: 4 }) });
    expect(file).toBe(epicMcpFile(mcpDir, 4));
    expect(file).toBe(join(mcpDir, "epics", "4.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: servers({ epicId: 4 }) });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("removes the epic's config, and does not mind when there is none", () => {
    const mcpDir = tempDir();
    const file = writeEpicMcpConfig({ mcpDir, epicId: 4, servers: servers({ epicId: 4 }) });
    removeEpicMcpConfig(mcpDir, 4);
    expect(existsSync(file)).toBe(false);
    expect(() => removeEpicMcpConfig(mcpDir, 4)).not.toThrow();
  });
});

describe("epic sessions server (design 2026-11-01)", () => {
  it("points the epic session's sessions server at the epic", () => {
    const s = sessionsServer({ launcher, scope: { epicId: 3 }, requestsDir: "/req", resultsDir: "/res" })["butler-sessions"];
    expect(s.env.BUTLER_EPIC).toBe("3");
    expect(s.env.BUTLER_FEATURE).toBeUndefined();
    expect(s.env.BUTLER_TICKET).toBeUndefined();
    expect(s.env.BUTLER_FEATURE_EPIC).toBeUndefined();
  });

  it("marks a feature coordinator that belongs to an epic", () => {
    const inEpic = sessionsServer({ launcher, scope: { featureId: 7, epic: true }, requestsDir: "/req", resultsDir: "/res" })["butler-sessions"];
    expect(inEpic.env).toMatchObject({ BUTLER_FEATURE: "7", BUTLER_FEATURE_EPIC: "1" });
    const plain = sessionsServer({ launcher, scope: { featureId: 7 }, requestsDir: "/req", resultsDir: "/res" })["butler-sessions"];
    expect(plain.env.BUTLER_FEATURE_EPIC).toBeUndefined();
  });
});
