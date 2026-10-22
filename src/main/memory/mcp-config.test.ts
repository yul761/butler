import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { memoryServers, TICKET_MCP_SUBDIR, ticketMcpFile, writeTicketMcpConfig } from "./mcp-config";

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
    const file = writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", launcher, statecoreDir: "/sc" });
    expect(file).toBe(join(mcpDir, "tickets", "PROJ-1.json"));
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({ mcpServers: memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "PROJ-1" }) });
    expect(text).not.toMatch(/MODEL_|OPENAI|ANTHROPIC|FEATURE_LLM|API_KEY/i);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", launcher, statecoreDir: "/sc2" });
    expect(readFileSync(file, "utf8")).toContain("/sc2");
    expect(readdirSync(mcpDir)).toEqual(["tickets"]);
    expect(readdirSync(join(mcpDir, "tickets"))).toEqual(["PROJ-1.json"]);
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
