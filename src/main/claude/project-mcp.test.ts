import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../test-utils";
import { INCLUDE_LOCAL_SCOPE, projectMcpConfigs } from "./project-mcp";

beforeEach(() => {
  // 隔离全局 git 配置，测试里的提交不受用户配置（签名、模板……）影响。
  vi.stubEnv("GIT_CONFIG_GLOBAL", process.platform === "win32" ? "NUL" : "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => vi.unstubAllEnvs());

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
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "pipe" }).toString();
  const gitInit = () => git("init", "-q");
  return { git, gitInit, root, repo, mcpDir, cfg, paths, p, logs, writeMcp, writeClaudeJson };
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
    // untracked settings.local.json in a git repo: user-local, where Claude Code records approvals
    s.gitInit();
    writeFileSync(join(s.repo, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["jira"] }));
    expect(servers(projectMcpConfigs(s.repo, s.p)[0])).toEqual(["jira"]);
  });

  describe("a settings.local.json the repo can ship does not count", () => {
    function repoWithApproval() {
      const s = setup();
      s.writeMcp(["jira"]);
      s.writeClaudeJson({});
      s.gitInit();
      return s;
    }
    const approve = JSON.stringify({ enableAllProjectMcpServers: true });

    it("plain tracked file", () => {
      const s = repoWithApproval();
      mkdirSync(join(s.repo, ".claude"));
      writeFileSync(join(s.repo, ".claude", "settings.local.json"), approve);
      s.git("add", "-f", ".claude/settings.local.json");
      s.git("commit", "-q", "-m", "x");
      expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    });

    it("(a) .claude committed as a symlink to an in-repo dir", () => {
      const s = repoWithApproval();
      mkdirSync(join(s.repo, "claudedir"));
      writeFileSync(join(s.repo, "claudedir", "settings.local.json"), approve);
      symlinkSync("claudedir", join(s.repo, ".claude"));
      s.git("add", "-f", ".");
      s.git("commit", "-q", "-m", "x");
      expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    });

    it("(b) a case variant of the name is tracked", () => {
      const s = repoWithApproval();
      mkdirSync(join(s.repo, ".claude"));
      writeFileSync(join(s.repo, ".claude", "Settings.Local.json"), approve);
      s.git("add", "-f", ".claude");
      s.git("commit", "-q", "-m", "x");
      expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
      const t = repoWithApproval();
      mkdirSync(join(t.repo, ".CLAUDE"));
      writeFileSync(join(t.repo, ".CLAUDE", "settings.local.json"), approve);
      t.git("add", "-f", ".CLAUDE");
      t.git("commit", "-q", "-m", "x");
      expect(projectMcpConfigs(t.repo, t.p)).toEqual([]);
    });

    it("(c) .claude is a submodule (gitlink)", () => {
      const s = repoWithApproval();
      mkdirSync(join(s.repo, ".claude"));
      writeFileSync(join(s.repo, ".claude", "settings.local.json"), approve);
      s.git("update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,.claude");
      expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    });

    it("(d) a fatal git error (corrupt index, exit 128) means untrusted", () => {
      const s = repoWithApproval();
      mkdirSync(join(s.repo, ".claude"));
      writeFileSync(join(s.repo, ".claude", "settings.local.json"), approve);
      expect(projectMcpConfigs(s.repo, s.p)).toHaveLength(1); // sanity: trusted while git is healthy
      writeFileSync(join(s.repo, ".git", "index"), "garbage");
      expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    });

    it("not a git repo at all means untrusted; GIT_DIR in the environment is ignored", () => {
      const s = setup();
      s.writeMcp(["jira"]);
      s.writeClaudeJson({});
      mkdirSync(join(s.repo, ".claude"));
      writeFileSync(join(s.repo, ".claude", "settings.local.json"), approve);
      expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
      const other = setup();
      other.gitInit();
      vi.stubEnv("GIT_DIR", join(other.repo, ".git"));
      expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    });

    it("settings.local.json that is itself a symlink", () => {
      const s = repoWithApproval();
      mkdirSync(join(s.repo, ".claude"));
      writeFileSync(join(s.repo, "elsewhere.json"), approve);
      symlinkSync(join(s.repo, "elsewhere.json"), join(s.repo, ".claude", "settings.local.json"));
      expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    });
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
    writeFileSync(s.paths.claudeJson, '{"oauthToken": "sk-ant-SECRET-123" broken');
    projectMcpConfigs(s.repo, s.p);
    expect(s.logs.join("\n")).not.toContain("SECRET");
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
    const repoBefore = readdirSync(s.repo, { recursive: true }).sort();
    const cfgBefore = readdirSync(s.cfg).sort();
    projectMcpConfigs(s.repo, s.p);
    expect(readFileSync(s.paths.claudeJson, "utf8")).toBe(before);
    expect(readdirSync(s.repo, { recursive: true }).sort()).toEqual(repoBefore);
    expect(readdirSync(s.cfg).sort()).toEqual(cfgBefore);
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

describe("projectMcpConfigs: repo-controlled files are read safely", () => {
  it("a symlinked .mcp.json is refused and logged", () => {
    const s = setup();
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    writeFileSync(join(s.root, "real.json"), JSON.stringify({ mcpServers: { jira: { command: "x" } } }));
    symlinkSync(join(s.root, "real.json"), join(s.repo, ".mcp.json"));
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    expect(s.logs.some((l) => l.includes("symlink"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("a .mcp.json symlinked to /dev/zero does not hang", () => {
    const s = setup();
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    symlinkSync("/dev/zero", join(s.repo, ".mcp.json"));
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  }, 5000);

  it("an oversized .mcp.json is refused and logged", () => {
    const s = setup();
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    writeFileSync(join(s.repo, ".mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "x".repeat(2 * 1024 * 1024) } } }));
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    expect(s.logs.some((l) => l.includes("too large"))).toBe(true);
  });

  it("on a name collision the local server wins and the project entry is dropped", () => {
    const s = setup();
    s.writeMcp(["jira", "gitlab"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true, mcpServers: { jira: { command: "mine" } } });
    const files = projectMcpConfigs(s.repo, s.p);
    const all = files.map((f) => (JSON.parse(readFileSync(f, "utf8")) as { mcpServers: Record<string, { command?: string }> }).mcpServers);
    expect(all.flatMap((m) => Object.keys(m)).sort()).toEqual(["gitlab", "jira"]);
    expect(all.find((m) => m.jira)?.jira.command).toBe("mine");
    expect(readdirSync(s.mcpDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("projectMcpConfigs: case-insensitive file systems (plan 3 parked)", () => {
  it.skipIf(process.platform !== "darwin")("does not trust a settings.local.json that git tracks under another letter case (APFS alias)", () => {
    const s = setup();
    s.gitInit();
    s.writeMcp(["repoServer"]);
    // 仓库提交的是 .CLAUDE/SETTINGS.LOCAL.JSON；在大小写不敏感的 APFS 上它就是 .claude/settings.local.json。
    mkdirSync(join(s.repo, ".CLAUDE"));
    writeFileSync(join(s.repo, ".CLAUDE", "SETTINGS.LOCAL.JSON"), JSON.stringify({ enabledMcpjsonServers: ["repoServer"] }));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "ship approvals");
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
  });

  it("writes through a randomly named temporary file and leaves none behind", () => {
    const s = setup();
    s.writeMcp(["a"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    projectMcpConfigs(s.repo, s.p);
    projectMcpConfigs(s.repo, s.p);
    expect(readdirSync(s.mcpDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
