import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { INCLUDE_LOCAL_SCOPE, projectMcpConfigs } from "./project-mcp";

function setup() {
  const root = tempDir("butler-mcp-");
  const repo = join(root, "repo");
  const mcpDir = join(root, "mcp");
  const cfg = join(root, "claude-config");
  mkdirSync(repo);
  mkdirSync(mcpDir);
  mkdirSync(cfg);
  const paths = { claudeJson: join(cfg, ".claude.json"), claudeSettings: join(cfg, "settings.json"), mcpDir };
  const logs: string[] = [];
  const p = { ...paths, log: (m: string) => logs.push(m) };
  const writeMcp = (names: string[]) =>
    writeFileSync(join(repo, ".mcp.json"), `\uFEFF${JSON.stringify({ mcpServers: Object.fromEntries(names.map((n) => [n, { command: "node", args: [n] }])) })}`);
  const writeClaudeJson = (project: Record<string, unknown>) => writeFileSync(paths.claudeJson, JSON.stringify({ projects: { [repo]: project, "/other": { mcpServers: { x: {} } } } }));
  return { root, repo, mcpDir, cfg, paths, p, logs, writeMcp, writeClaudeJson };
}

const servers = (file: string): string[] => Object.keys((JSON.parse(readFileSync(file, "utf8")) as { mcpServers: object }).mcpServers).sort();
const mode = (file: string) => statSync(file).mode & 0o777;

describe("projectMcpConfigs: project scope needs the user's approval", () => {
  it("includes nothing when the repo has no usable .mcp.json (missing, broken, empty)", () => {
    const s = setup();
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    writeFileSync(join(s.repo, ".mcp.json"), "{ broken");
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    writeFileSync(join(s.repo, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("approved: only servers in the project's enabledMcpjsonServers are exported, into the mcp dir with mode 0600", () => {
    const s = setup();
    s.writeMcp(["jira", "evil"]);
    s.writeClaudeJson({ enabledMcpjsonServers: ["jira"] });
    const files = projectMcpConfigs(s.repo, s.p);
    expect(files).toHaveLength(1);
    expect(files[0].startsWith(s.mcpDir)).toBe(true);
    expect(files).not.toContain(join(s.repo, ".mcp.json"));
    expect(servers(files[0])).toEqual(["jira"]);
    if (process.platform !== "win32") expect(mode(files[0])).toBe(0o600);
  });

  it("unapproved: a server nobody approved is not mounted", () => {
    const s = setup();
    s.writeMcp(["jira"]);
    s.writeClaudeJson({});
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    s.writeClaudeJson({ enabledMcpjsonServers: ["other"] });
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("disabled: disabledMcpjsonServers wins over enabled and over enableAll", () => {
    const s = setup();
    s.writeMcp(["jira", "evil"]);
    s.writeClaudeJson({ enabledMcpjsonServers: ["jira", "evil"], disabledMcpjsonServers: ["evil"] });
    expect(servers(projectMcpConfigs(s.repo, s.p)[0])).toEqual(["jira"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ["evil"] });
    expect(servers(projectMcpConfigs(s.repo, s.p)[0])).toEqual(["jira"]);
    // disabled in user settings too
    writeFileSync(s.paths.claudeSettings, JSON.stringify({ disabledMcpjsonServers: ["jira"] }));
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("enableAll: enableAllProjectMcpServers true approves every (not disabled) server, from ~/.claude.json or user settings", () => {
    const s = setup();
    s.writeMcp(["jira", "gitlab"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    expect(servers(projectMcpConfigs(s.repo, s.p)[0])).toEqual(["gitlab", "jira"]);
    s.writeClaudeJson({});
    writeFileSync(s.paths.claudeSettings, JSON.stringify({ enableAllProjectMcpServers: true }));
    expect(servers(projectMcpConfigs(s.repo, s.p)[0])).toEqual(["gitlab", "jira"]);
    writeFileSync(s.paths.claudeSettings, JSON.stringify({ enableAllProjectMcpServers: "true" }));
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("approval in the repo's own settings files does not count (repo-controlled), except an untracked settings.local.json", () => {
    const s = setup();
    s.writeMcp(["jira"]);
    s.writeClaudeJson({});
    mkdirSync(join(s.repo, ".claude"));
    writeFileSync(join(s.repo, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["jira"] }));
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    // settings.local.json that is not in a git repo: user-local, where Claude Code records approvals
    writeFileSync(join(s.repo, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["jira"] }));
    expect(servers(projectMcpConfigs(s.repo, s.p)[0])).toEqual(["jira"]);
  });

  it("a settings.local.json committed to the repo does not count", () => {
    const s = setup();
    s.writeMcp(["jira"]);
    s.writeClaudeJson({});
    mkdirSync(join(s.repo, ".claude"));
    writeFileSync(join(s.repo, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: s.repo, stdio: "pipe" });
    git("init", "-q");
    git("add", "-f", ".claude/settings.local.json");
    git("commit", "-q", "-m", "x");
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("a disabled list in settings.local.json is honoured", () => {
    const s = setup();
    s.writeMcp(["jira"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    mkdirSync(join(s.repo, ".claude"));
    writeFileSync(join(s.repo, ".claude", "settings.local.json"), JSON.stringify({ disabledMcpjsonServers: ["jira"] }));
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("missing ~/.claude.json: no extra servers, no throw", () => {
    const s = setup();
    s.writeMcp(["jira"]);
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("corrupt ~/.claude.json: no extra servers, logged, no throw", () => {
    const s = setup();
    s.writeMcp(["jira"]);
    writeFileSync(s.paths.claudeJson, "{ not json");
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    expect(s.logs.some((l) => l.includes("claude.json"))).toBe(true);
    // parseable but wrong shape
    writeFileSync(s.paths.claudeJson, JSON.stringify({ projects: [1, 2] }));
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    writeFileSync(s.paths.claudeJson, "null");
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("never writes into the repo or the config dir", () => {
    const s = setup();
    s.writeMcp(["jira"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true, mcpServers: { l: { command: "x" } } });
    const before = readFileSync(s.paths.claudeJson, "utf8");
    projectMcpConfigs(s.repo, s.p);
    expect(readFileSync(s.paths.claudeJson, "utf8")).toBe(before);
    expect(() => statSync(join(s.repo, "mcp"))).toThrow();
  });

  it("mcp dir not writable: skipped, logged, no throw", () => {
    const s = setup();
    s.writeMcp(["jira"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    expect(projectMcpConfigs(s.repo, { ...s.p, mcpDir: join(s.root, "missing") })).toEqual([]);
    expect(s.logs.length).toBeGreaterThan(0);
  });
});

describe("projectMcpConfigs: local scope", () => {
  it.skipIf(!INCLUDE_LOCAL_SCOPE)("exports this directory's local-scope servers to a private file under the mcp dir", () => {
    const s = setup();
    const local = { linear: { command: "node", args: ["l"], env: { TOKEN: "t" } } };
    s.writeClaudeJson({ mcpServers: local });
    const [file] = projectMcpConfigs(s.repo, s.p);
    expect(file.startsWith(s.mcpDir)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: local });
    if (process.platform !== "win32") expect(mode(file)).toBe(0o600);
    // rewriting keeps the mode
    projectMcpConfigs(s.repo, s.p);
    if (process.platform !== "win32") expect(mode(file)).toBe(0o600);
  });

  it.skipIf(!INCLUDE_LOCAL_SCOPE)("local and approved project servers come as separate files; project servers need approval even when local exists", () => {
    const s = setup();
    s.writeMcp(["jira"]);
    s.writeClaudeJson({ mcpServers: { linear: { command: "l" } } });
    const files = projectMcpConfigs(s.repo, s.p);
    expect(files).toHaveLength(1);
    expect(servers(files[0])).toEqual(["linear"]);
    s.writeClaudeJson({ mcpServers: { linear: { command: "l" } }, enabledMcpjsonServers: ["jira"] });
    const both = projectMcpConfigs(s.repo, s.p);
    expect(both.map((f) => servers(f)).sort()).toEqual([["jira"], ["linear"]]);
    expect(new Set(both).size).toBe(2);
  });
});
