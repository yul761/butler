import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { memoryServers, ticketMcpFile, writeTicketMcpConfig } from "./mcp-config";

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

  it("writes mcp/<ticket>.json privately, replaces it atomically and never puts a model key in it (R1)", () => {
    const mcpDir = join(tempDir(), "mcp");
    const file = writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", launcher, statecoreDir: "/sc" });
    expect(file).toBe(join(mcpDir, "PROJ-1.json"));
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({ mcpServers: memoryServers({ launcher, statecoreDir: "/sc", ticketKey: "PROJ-1" }) });
    expect(text).not.toMatch(/MODEL_|OPENAI|ANTHROPIC|FEATURE_LLM|API_KEY/i);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeTicketMcpConfig({ mcpDir, ticketKey: "PROJ-1", launcher, statecoreDir: "/sc2" });
    expect(readFileSync(file, "utf8")).toContain("/sc2");
    expect(readdirSync(mcpDir)).toEqual(["PROJ-1.json"]);
  });

  it("keeps the file for an odd ticket key inside mcpDir (Review Focus 5)", () => {
    const mcpDir = join(tempDir(), "mcp");
    for (const key of ["../../etc/passwd", "A B/C", "..", "PROJ-1", "名字-1"]) {
      const f = ticketMcpFile(mcpDir, key);
      expect(dirname(f), key).toBe(mcpDir);
      expect(basename(f), key).toMatch(/^[A-Za-z0-9._-]+\.json$/);
    }
    expect(ticketMcpFile(mcpDir, "A B")).not.toBe(ticketMcpFile(mcpDir, "A_B"));
    expect(ticketMcpFile(mcpDir, "PROJ-1")).toBe(join(mcpDir, "PROJ-1.json"));
  });
});
