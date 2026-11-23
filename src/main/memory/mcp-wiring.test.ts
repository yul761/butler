import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectMcpConfigs } from "../claude/project-mcp";
import { tempDir } from "../test-utils";
import { memoryServers, TICKET_MCP_SUBDIR, writeTicketMcpConfig } from "./mcp-config";

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

    // memoryMcpConfig：一处定义、一处传给 SessionService，再一处给完整分叉（UI 重做第 5 层：跟开发 session 同一组 server，
    // 只读 hook 只放行 recall/facts/why）；别的地方（HandoffRunner、MCP 探测、定时任务）都拿不到。
    expect(indexSource.match(/\bmemoryMcpConfig\b/g)).toHaveLength(3);
    expect(block("const sessionService = new SessionService({")).toContain("mcpConfig: memoryMcpConfig,");
    expect(block("const forkMcpConfig = (dev: DevLaunch, runId: string)", "\n  };")).toMatch(/memoryMcpConfig\(s\.ticketKey, [^\n]*, termId\)/);
  });

  it("forks never go through the shared MCP hub: every builder they call takes termId null, which writes the fork's own stdio file (Task 8 review I1)", () => {
    const fork = block("const forkMcpConfig = (dev: DevLaunch, runId: string)", "\n  };");
    expect(fork).toContain("const termId = null;");
    expect(fork).not.toMatch(/sharedMcpConfig|mcpHub|writeTerminalMcpConfig/);
    for (const name of ["memoryMcpConfig", "featureMcpConfig", "shipherdMcpConfig"]) {
      expect(fork, name).toMatch(new RegExp(`\\b${name}\\([^\\n]*termId\\)`));
      // 每个配置函数都经 placeMcp 决定写到哪。
      expect(block(`const ${name} = (`, "\n  };"), name).toMatch(/return placeMcp\(termId, servers, /);
    }
    // termId 是 null：直接写分叉自己的文件，不碰 hub（sharedMcpConfig 里才 route）。
    const place = block("const placeMcp = (", "\n  };");
    expect(place).toMatch(/termId === null\s*\?\s*writeForkMcpConfig\(\{ mcpDir: paths\.mcp, servers \}\)\s*:\s*\(sharedMcpConfig\(termId, servers\) \?\? stdio\(\)\)/);
    expect(indexSource.match(/\bwriteTicketMcpConfig\(/g)).toHaveLength(1);
    expect(block("const memoryMcpConfig =", "\n  };")).toContain("writeTicketMcpConfig(");

    // headless 的两条路径只用 projectMcp（计划 3 的 project-* / local-* 文件）。
    for (const start of ["const runner = new HandoffRunner({", "return probeMcpTools({"]) {
      const b = block(start);
      expect(b, start).not.toMatch(/memoryMcpConfig|mcpConfig:|writeTicketMcpConfig|TICKET_MCP_SUBDIR/);
      expect(b, start).toMatch(/\bprojectMcp\b/);
    }
  });

  it("interactive sessions (ticket, feature, fix all go through mcpSettings) pre-allow ask_user and report (BTL-190 2+3)", () => {
    const at = indexSource.indexOf("mcpSettings: (dirs, sessionId) =>");
    expect(at).toBeGreaterThan(0);
    const block = indexSource.slice(at, indexSource.indexOf("checksAbsence,", at));
    expect(block).toContain("projectMcpApprovalSettings(");
    expect(block).toContain("allowTools: SESSIONS_AUTO_ALLOW");
  });

  it("projectMcp never returns a file under mcp/tickets, even when ticket configs with look-alike keys sit next to it", () => {
    const base = tempDir("shipherd-wiring-");
    const repo = join(base, "repo");
    const mcpDir = join(base, "mcp");
    const claudeJson = join(base, ".claude.json");
    mkdirSync(repo);
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "node", args: ["jira"] } } }));
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { enabledMcpjsonServers: ["jira"], mcpServers: { mine: { command: "node", args: ["mine"] } } } } }),
    );
    const launcher = { command: "/x/Shipherd", script: "/x/statecore-mcp.cjs" };
    const ticketFiles = ["PROJ-1", "PROJECT-123456789012", "project-123456789012", "LOCAL-123456789012"].map((ticketKey) =>
      writeTicketMcpConfig({ mcpDir, ticketKey, servers: memoryServers({ launcher, statecoreDir: "/sc", ticketKey }) }),
    );

    // HandoffRunner、MCP 探测和定时刷新的 --mcp-config 全部来自 projectMcpConfigs（index.ts 的 projectMcp）。
    const files = projectMcpConfigs(repo, { claudeJson, claudeSettings: join(base, "settings.json"), mcpDir });
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(dirname(f)).toBe(mcpDir);
      expect(relative(mcpDir, f).split(sep)).not.toContain(TICKET_MCP_SUBDIR);
      expect(readFileSync(f, "utf8")).not.toContain("shipherd-memory");
    }
    // 计划 3 的文件也没有覆盖 ticket 的配置。
    for (const f of ticketFiles) expect(readFileSync(f, "utf8")).toContain("shipherd-memory");
  });
});
