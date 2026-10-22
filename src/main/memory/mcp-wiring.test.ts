import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectMcpConfigs } from "../claude/project-mcp";
import { tempDir } from "../test-utils";
import { TICKET_MCP_SUBDIR, writeTicketMcpConfig } from "./mcp-config";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const indexSource = readFileSync(join(root, "src", "main", "index.ts"), "utf8");

/** 仓库里的非测试 TypeScript 源文件（相对路径，用 /）。 */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sources(rel));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** index.ts 里从 start 开始到同一缩进的结束符（默认 `});`）为止的那一段。 */
function block(start: string, close = "\n  });"): string {
  const from = indexSource.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const end = indexSource.indexOf(close, from);
  expect(end, start).toBeGreaterThan(from);
  return indexSource.slice(from, end);
}

describe("the ticket memory MCP only reaches interactive sessions (P4-R6)", () => {
  it("only index.ts uses mcp-config, and only to hand memoryMcpConfig to SessionService", () => {
    const importers = [...sources("src"), ...sources("memory-mcp")].filter((f) =>
      /from\s+["'][^"']*\/mcp-config["']/.test(readFileSync(join(root, f), "utf8")),
    );
    expect(importers).toEqual(["src/main/index.ts"]);

    // memoryMcpConfig：一处定义、一处传给 SessionService，别的地方（HandoffRunner、MCP 探测、定时任务）都拿不到。
    expect(indexSource.match(/\bmemoryMcpConfig\b/g)).toHaveLength(2);
    expect(block("const sessionService = new SessionService({")).toContain("mcpConfig: memoryMcpConfig,");
    expect(indexSource.match(/\bwriteTicketMcpConfig\(/g)).toHaveLength(1);
    expect(block("const memoryMcpConfig =", "\n  };")).toContain("writeTicketMcpConfig(");

    // headless 的两条路径只用 projectMcp（计划 3 的 project-* / local-* 文件）。
    for (const start of ["const runner = new HandoffRunner({", "return probeMcpTools({"]) {
      const b = block(start);
      expect(b, start).not.toMatch(/memoryMcpConfig|mcpConfig:|writeTicketMcpConfig|TICKET_MCP_SUBDIR/);
      expect(b, start).toMatch(/\bprojectMcp\b/);
    }
  });

  it("projectMcp never returns a file under mcp/tickets, even when ticket configs with look-alike keys sit next to it", () => {
    const base = tempDir("butler-wiring-");
    const repo = join(base, "repo");
    const mcpDir = join(base, "mcp");
    const claudeJson = join(base, ".claude.json");
    mkdirSync(repo);
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "node", args: ["jira"] } } }));
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { enabledMcpjsonServers: ["jira"], mcpServers: { mine: { command: "node", args: ["mine"] } } } } }),
    );
    const launcher = { command: "/x/Butler", script: "/x/statecore-mcp.cjs" };
    const ticketFiles = ["PROJ-1", "PROJECT-123456789012", "project-123456789012", "LOCAL-123456789012"].map((ticketKey) =>
      writeTicketMcpConfig({ mcpDir, ticketKey, launcher, statecoreDir: "/sc" }),
    );

    // HandoffRunner、MCP 探测和定时刷新的 --mcp-config 全部来自 projectMcpConfigs（index.ts 的 projectMcp）。
    const files = projectMcpConfigs(repo, { claudeJson, claudeSettings: join(base, "settings.json"), mcpDir });
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(dirname(f)).toBe(mcpDir);
      expect(relative(mcpDir, f).split(sep)).not.toContain(TICKET_MCP_SUBDIR);
      expect(readFileSync(f, "utf8")).not.toContain("butler-memory");
    }
    // 计划 3 的文件也没有覆盖 ticket 的配置。
    for (const f of ticketFiles) expect(readFileSync(f, "utf8")).toContain("butler-memory");
  });
});
