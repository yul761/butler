import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../test-utils";
import { GIT_SAFE_ARGS, resetGitBinary, setGitBinary } from "../util/git-path";
import { INCLUDE_LOCAL_SCOPE, projectMcpApprovalSettings, projectMcpConfigs } from "./project-mcp";

const mocks = vi.hoisted(() => ({ spawnSync: undefined as undefined | ((...a: unknown[]) => unknown), randomBytes: undefined as undefined | ((n: number) => Buffer), randomResults: [] as string[] }));
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, spawnSync: (...a: unknown[]) => (mocks.spawnSync ?? (actual.spawnSync as (...x: unknown[]) => unknown))(...a) };
});
vi.mock("node:crypto", async (orig) => {
  const actual = await orig<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: (n: number) => {
      const b = mocks.randomBytes ? mocks.randomBytes(n) : actual.randomBytes(n);
      mocks.randomResults.push(b.toString("hex"));
      return b;
    },
  };
});

beforeEach(() => {
  // 隔离全局 git 配置，测试里的提交不受用户配置（签名、模板……）影响。
  vi.stubEnv("GIT_CONFIG_GLOBAL", process.platform === "win32" ? "NUL" : "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.spawnSync = undefined;
  mocks.randomBytes = undefined;
  mocks.randomResults = [];
  resetGitBinary();
});

function setup() {
  const root = tempDir("shipherd-mcp-");
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

describe("projectMcpConfigs: temporary files", () => {
  it("uses a fresh random temp name for every write", () => {
    const s = setup();
    s.writeMcp(["a"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    projectMcpConfigs(s.repo, s.p);
    projectMcpConfigs(s.repo, s.p);
    expect(mocks.randomResults).toHaveLength(2);
    expect(mocks.randomResults[0]).not.toBe(mocks.randomResults[1]);
  });

  it("never overwrites or deletes a temp file it did not create (wx), and does not export that entry", () => {
    const s = setup();
    s.writeMcp(["a"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    const [file] = projectMcpConfigs(s.repo, s.p);
    const planted = `${file}.${process.pid}.deadbeef.tmp`;
    writeFileSync(planted, "PLANTED");
    mocks.randomBytes = () => Buffer.from("deadbeef", "hex");
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    expect(readFileSync(planted, "utf8")).toBe("PLANTED");
  });

  it("removes its own temp file when the rename fails", () => {
    const s = setup();
    s.writeMcp(["a"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    const [file] = projectMcpConfigs(s.repo, s.p);
    rmSync(file);
    mkdirSync(join(file, "blocker"), { recursive: true }); // rename 到非空目录上必然失败
    expect(projectMcpConfigs(s.repo, s.p)).toEqual([]);
    expect(s.logs.some((l) => l.includes("skipping"))).toBe(true);
    expect(readdirSync(s.mcpDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("creates the temp file with mode 0600", () => {
    const s = setup();
    s.writeMcp(["a"]);
    s.writeClaudeJson({ enableAllProjectMcpServers: true });
    const [file] = projectMcpConfigs(s.repo, s.p);
    expect(mode(file)).toBe(0o600);
  });

  it("sweeps stale top-level *.tmp files (older than an hour) but keeps fresh ones, other files and subfolders", () => {
    const s = setup();
    const old = join(s.mcpDir, "project-x.json.1.aaaa.tmp");
    const fresh = join(s.mcpDir, "project-y.json.1.bbbb.tmp");
    const keep = join(s.mcpDir, "project-z.json");
    const sub = join(s.mcpDir, "tickets");
    mkdirSync(sub);
    const inSub = join(sub, "t1.json.1.cccc.tmp");
    for (const f of [old, fresh, keep, inSub]) writeFileSync(f, "x");
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const f of [old, keep, inSub]) utimesSync(f, longAgo, longAgo);
    projectMcpConfigs(s.repo, s.p);
    expect(readdirSync(s.mcpDir).sort()).toEqual(["project-y.json.1.bbbb.tmp", "project-z.json", "tickets"]);
    expect(readdirSync(sub)).toEqual(["t1.json.1.cccc.tmp"]);
  });
});

describe("projectMcpConfigs: git invocation", () => {
  it("runs the resolved absolute git with fsmonitor disabled", () => {
    const s = setup();
    s.writeMcp(["a"]);
    s.writeClaudeJson({});
    mkdirSync(join(s.repo, ".claude"));
    writeFileSync(join(s.repo, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
    const calls: { cmd: unknown; args: unknown }[] = [];
    mocks.spawnSync = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 1, stdout: "", error: undefined };
    };
    const abs = process.platform === "win32" ? "C:\\Git\\cmd\\git.exe" : "/opt/abs/git";
    setGitBinary(abs);
    projectMcpConfigs(s.repo, s.p);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.cmd).toBe(abs);
      expect((c.args as string[]).slice(0, 2)).toEqual(GIT_SAFE_ARGS);
    }
  });
});

describe("projectMcpApprovalSettings: interactive sessions use the same approval rule as headless runs (BTL-262)", () => {
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { enableAllProjectMcpServers?: boolean; enabledMcpjsonServers: string[]; disabledMcpjsonServers: string[] };

  /** s.repo 建成一个有提交的仓库，再加一个真的 worktree（审批按 git 找 worktree 的主目录）。 */
  const withWorktree = (s: ReturnType<typeof setup>): string => {
    mkdirSync(s.repo, { recursive: true });
    s.gitInit();
    s.git("commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(s.root, "worktree");
    s.git("worktree", "add", "-q", "-b", "wt", worktree);
    return worktree;
  };

  it("enables only what the user approved, keeping what the user disabled in the worktree and its main checkout", () => {
    const s = setup();
    const worktree = withWorktree(s);
    writeFileSync(s.paths.claudeJson, JSON.stringify({ projects: { [s.repo]: { disabledMcpjsonServers: ["evil"], enabledMcpjsonServers: ["jira"] }, [worktree]: { disabledMcpjsonServers: ["noisy"] } } }));
    writeFileSync(s.paths.claudeSettings, JSON.stringify({ disabledMcpjsonServers: ["global-off"] }));
    const file = projectMcpApprovalSettings([worktree, s.repo, s.repo], s.p);
    expect(file).not.toBeNull();
    expect(file!.startsWith(s.mcpDir)).toBe(true);
    expect(read(file!)).toEqual({ enabledMcpjsonServers: ["jira"], disabledMcpjsonServers: ["evil", "global-off", "noisy"] });
    if (process.platform !== "win32") expect(mode(file!)).toBe(0o600);
    // 调用方没给仓库路径时，主目录按 git 找。
    expect(read(projectMcpApprovalSettings([worktree], s.p)!).enabledMcpjsonServers).toEqual(["jira"]);
  });

  it("a cloned repo's .mcp.json is not switched on: unapproved servers are left to Claude Code's own prompt", () => {
    const s = setup();
    s.writeMcp(["evil", "jira"]);
    const file = projectMcpApprovalSettings([s.repo], s.p);
    const c = read(file!);
    expect(c.enableAllProjectMcpServers).toBeUndefined();
    expect(c.enabledMcpjsonServers).toEqual([]);
    expect(readFileSync(file!, "utf8")).not.toContain("evil");
  });

  it("approvals from a worktree and the main checkout are merged; a disabled server never ends up enabled", () => {
    const s = setup();
    const worktree = withWorktree(s);
    writeFileSync(s.paths.claudeJson, JSON.stringify({ projects: { [s.repo]: { enabledMcpjsonServers: ["jira", "both"] }, [worktree]: { enabledMcpjsonServers: ["wt"], disabledMcpjsonServers: ["both"] } } }));
    expect(read(projectMcpApprovalSettings([worktree, s.repo], s.p)!)).toEqual({ enabledMcpjsonServers: ["jira", "wt"], disabledMcpjsonServers: ["both"] });
  });

  it("a multi-repo ticket does not carry one repo's approvals into another repo's worktree (BTL-262 review)", () => {
    const s = setup();
    const worktree = withWorktree(s);
    // 用户自己的仓库 B：未跟踪的 settings.local.json 里选过「以后都启用」，~/.claude.json 里也按名字批准过 jira。
    const other = join(s.root, "other");
    mkdirSync(join(other, ".claude"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: other, stdio: "pipe" });
    writeFileSync(join(other, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
    writeFileSync(s.paths.claudeJson, JSON.stringify({ projects: { [other]: { enabledMcpjsonServers: ["jira"] } } }));
    // B 自己的 session 照常拿到。
    expect(read(projectMcpApprovalSettings([other, s.repo, other], s.p)!)).toEqual({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["jira"], disabledMcpjsonServers: [] });
    // 第三方仓库 A 的 worktree 里开的 session：ticket 同时挂着 B，也拿不到 B 的 enableAll 和按名字的批准。
    for (const cwd of [worktree, s.repo]) {
      const c = read(projectMcpApprovalSettings([cwd, s.repo, other], s.p)!);
      expect(c.enableAllProjectMcpServers).toBeUndefined();
      expect(c.enabledMcpjsonServers).toEqual([]);
    }
  });

  it("a directory outside any git repo uses only its own approvals, not the repo paths it was given", () => {
    const s = setup();
    const ws = join(s.root, "workspace");
    mkdirSync(ws);
    mkdirSync(s.repo, { recursive: true });
    s.gitInit();
    writeFileSync(s.paths.claudeJson, JSON.stringify({ projects: { [s.repo]: { enableAllProjectMcpServers: true }, [ws]: { enabledMcpjsonServers: ["mine"] } } }));
    expect(read(projectMcpApprovalSettings([ws, s.repo], s.p)!)).toEqual({ enabledMcpjsonServers: ["mine"], disabledMcpjsonServers: [] });
  });

  it("enableAllProjectMcpServers is written only when the user set it in a trusted place (~/.claude.json, user settings)", () => {
    const s = setup();
    s.writeClaudeJson({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ["x"] });
    expect(read(projectMcpApprovalSettings([s.repo], s.p)!)).toEqual({ enableAllProjectMcpServers: true, enabledMcpjsonServers: [], disabledMcpjsonServers: ["x"] });
    rmSync(s.paths.claudeJson);
    writeFileSync(s.paths.claudeSettings, JSON.stringify({ enableAllProjectMcpServers: true }));
    expect(read(projectMcpApprovalSettings([s.repo], s.p)!).enableAllProjectMcpServers).toBe(true);
  });

  it("approval written in the repo's own .claude/settings.json or a tracked settings.local.json does not count", () => {
    const s = setup();
    s.gitInit();
    mkdirSync(join(s.repo, ".claude"));
    writeFileSync(join(s.repo, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["evil"] }));
    writeFileSync(join(s.repo, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["evil2"] }));
    s.git("add", "-f", ".claude");
    s.git("commit", "-q", "-m", "ship approvals");
    const c = read(projectMcpApprovalSettings([s.repo], s.p)!);
    expect(c.enableAllProjectMcpServers).toBeUndefined();
    expect(c.enabledMcpjsonServers).toEqual([]);
  });

  it("an untracked settings.local.json (the user's own Claude Code answers) counts", () => {
    const s = setup();
    s.gitInit();
    mkdirSync(join(s.repo, ".claude"));
    writeFileSync(join(s.repo, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["jira"] }));
    expect(read(projectMcpApprovalSettings([s.repo], s.p)!).enabledMcpjsonServers).toEqual(["jira"]);
  });

  it("the interactive and headless paths agree on every server", () => {
    const s = setup();
    s.writeMcp(["a", "b", "c", "d"]);
    s.writeClaudeJson({ enabledMcpjsonServers: ["a", "c"], disabledMcpjsonServers: ["c", "d"] });
    const headless = servers(projectMcpConfigs(s.repo, s.p)[0]);
    const c = read(projectMcpApprovalSettings([s.repo], s.p)!);
    const interactive = ["a", "b", "c", "d"].filter((n) => !c.disabledMcpjsonServers.includes(n) && (c.enableAllProjectMcpServers || c.enabledMcpjsonServers.includes(n)));
    expect(interactive).toEqual(headless);
    expect(headless).toEqual(["a"]);
  });

  it("reuses one file for the same content and never writes into the repo", () => {
    const s = setup();
    const a = projectMcpApprovalSettings([s.repo], s.p);
    const b = projectMcpApprovalSettings([s.repo], s.p);
    expect(a).toBe(b);
    expect(read(a!)).toEqual({ enabledMcpjsonServers: [], disabledMcpjsonServers: [] });
    expect(readdirSync(s.repo)).toEqual([]);
    expect(readdirSync(s.mcpDir)).toHaveLength(1);
  });

  it("with a gate command it adds the PreToolUse/PostToolUse/PostToolUseFailure Bash hooks; without one there is no hooks key", () => {
    const s = setup();
    const plain = projectMcpApprovalSettings([s.repo], s.p);
    expect(Object.keys(read(plain!))).not.toContain("hooks");
    const file = projectMcpApprovalSettings([s.repo], { ...s.p, gateCommand: '"/b/shipherd-hook"' });
    const group = [{ matcher: "Bash", hooks: [{ type: "command", command: '"/b/shipherd-hook" gate', timeout: 10 }] }];
    // Skill 调用只记（PR 进度），走写信封的那条路：命令不带 gate，只在 PostToolUse。
    const skill = { matcher: "Skill", hooks: [{ type: "command", command: '"/b/shipherd-hook"', timeout: 10 }] };
    const agent = { matcher: "Agent|Task", hooks: [{ type: "command", command: '"/b/shipherd-hook"', timeout: 10 }] };
    // 推送、开 PR 记下分支是谁的（工作流 W）：同样走写信封的那条路，hook 只为 git push / gh pr create 写。
    const ship = { matcher: "Bash", hooks: [{ type: "command", command: '"/b/shipherd-hook"', timeout: 10 }] };
    expect(file).not.toBe(plain);
    expect(JSON.parse(readFileSync(file!, "utf8"))).toEqual({ enabledMcpjsonServers: [], disabledMcpjsonServers: [], hooks: { PreToolUse: group, PostToolUse: [...group, skill, agent, ship], PostToolUseFailure: [...group, ship] } });
  });

  it("adds the Agent|Task matcher next to Skill only with a gate command", () => {
    const s = setup();
    expect(Object.keys(read(projectMcpApprovalSettings([s.repo], s.p)!))).not.toContain("hooks");
    const post = (JSON.parse(readFileSync(projectMcpApprovalSettings([s.repo], { ...s.p, gateCommand: "/b/h" })!, "utf8")).hooks.PostToolUse as { matcher: string }[]).map((g) => g.matcher);
    expect(post).toEqual(["Bash", "Skill", "Agent|Task", "Bash"]);
  });

  it("with a mailbox command, runs it after every tool (failed ones too) and records feature-memory remembers (BTL-245)", () => {
    const s = setup();
    const hooks = JSON.parse(readFileSync(projectMcpApprovalSettings([s.repo], { ...s.p, gateCommand: "/b/h", mailboxCommand: "MB" })!, "utf8")).hooks;
    const mailbox = { matcher: "", hooks: [{ type: "command", command: "MB", timeout: 10 }] };
    expect(hooks.PostToolUse.slice(-2)).toEqual([mailbox, { matcher: "mcp__shipherd-feature__remember", hooks: [{ type: "command", command: "/b/h", timeout: 10 }] }]);
    expect(hooks.PostToolUseFailure.at(-1)).toEqual(mailbox);
    // 没有 hook 程序就没有信箱 hook。
    expect(Object.keys(read(projectMcpApprovalSettings([s.repo], { ...s.p, mailboxCommand: "MB" })!))).not.toContain("hooks");
  });

  it("with the lessons drip, sends matching lessons after edits and resets on startup, clear and compact (BTL-274)", () => {
    const s = setup();
    const hooks = JSON.parse(readFileSync(projectMcpApprovalSettings([s.repo], { ...s.p, gateCommand: "/b/h", lessons: { command: "LD", resetCommand: "LR" } })!, "utf8")).hooks;
    expect(hooks.PostToolUse.at(-1)).toEqual({ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "LD", timeout: 10 }] });
    expect(hooks.SessionStart).toEqual([{ matcher: "startup|clear|compact", hooks: [{ type: "command", command: "LR", timeout: 10 }] }]);
    expect(Object.keys(read(projectMcpApprovalSettings([s.repo], { ...s.p, lessons: { command: "LD", resetCommand: "LR" } })!))).not.toContain("hooks");
  });

  it("with checks on, adds the edit check after Edit|Write|MultiEdit and the push check before Bash (contract 4.5)", () => {
    const s = setup();
    const hooks = JSON.parse(readFileSync(projectMcpApprovalSettings([s.repo], { ...s.p, gateCommand: "/b/h", checks: { editTimeoutSec: 8, pushTimeoutSec: 600 } })!, "utf8")).hooks;
    expect(hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "/b/h gate", timeout: 10 }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "/b/h check-push --budget-ms 600000", timeout: 630 }] },
    ]);
    expect(hooks.PostToolUse.at(-1)).toEqual({ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "/b/h check --budget-ms 8000", timeout: 11 }] });
    expect(hooks.PostToolUseFailure).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "/b/h gate", timeout: 10 }] }, { matcher: "Bash", hooks: [{ type: "command", command: "/b/h", timeout: 10 }] }]);
    // 没有 hook 程序就没有检查。
    expect(Object.keys(read(projectMcpApprovalSettings([s.repo], { ...s.p, checks: { editTimeoutSec: 8, pushTimeoutSec: 600 } })!))).not.toContain("hooks");
  });

  it("writes the given tools as permissions.allow; without any there is no permissions key", () => {
    const s = setup();
    expect(Object.keys(read(projectMcpApprovalSettings([s.repo], { ...s.p, allowTools: [] })!))).not.toContain("permissions");
    const file = projectMcpApprovalSettings([s.repo], { ...s.p, allowTools: ["mcp__x__a", "mcp__x__b"] });
    expect(JSON.parse(readFileSync(file!, "utf8"))).toEqual({ enabledMcpjsonServers: [], disabledMcpjsonServers: [], permissions: { allow: ["mcp__x__a", "mcp__x__b"] } });
  });

  it("appends permission-profile rules after the given tools, re-checking each one so a write rule never gets in (ws-j)", () => {
    const s = setup();
    const file = projectMcpApprovalSettings([s.repo], {
      ...s.p, allowTools: ["mcp__x__a"], profileRules: ["Bash(gh pr view:*)", "Bash(git push:*)", "Edit", "mcp__x__a", "mcp__tracker__get_issue", "Bash(rm -rf a)"],
    });
    expect(JSON.parse(readFileSync(file!, "utf8")).permissions).toEqual({ allow: ["mcp__x__a", "Bash(gh pr view:*)", "mcp__tracker__get_issue"] });
    const only = projectMcpApprovalSettings([s.repo], { ...s.p, profileRules: ["Bash(gh pr list:*)"] });
    expect(JSON.parse(readFileSync(only!, "utf8")).permissions).toEqual({ allow: ["Bash(gh pr list:*)"] });
  });

  it("missing or corrupt ~/.claude.json still writes the settings file (nothing approved); an unwritable mcp dir gives null and a log line", () => {
    const s = setup();
    expect(projectMcpApprovalSettings([s.repo], s.p)).not.toBeNull();
    writeFileSync(s.paths.claudeJson, "{ broken");
    expect(projectMcpApprovalSettings([s.repo], s.p)).not.toBeNull();
    rmSync(s.mcpDir, { recursive: true });
    writeFileSync(s.mcpDir, "not a dir");
    expect(projectMcpApprovalSettings([s.repo], s.p)).toBeNull();
    expect(s.logs.some((l) => l.includes("approval settings not written"))).toBe(true);
  });
});

describe("opening a session does not re-read and re-ask what has not changed (BTL-275)", () => {
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { enabledMcpjsonServers: string[] };
  /** 把修改时间挪到一分钟前：刚写的文件（RECENT_WRITE_MS 以内）故意不缓存。 */
  const age = (file: string) => {
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
  };
  /** 照样真的跑 git，只数 rev-parse 的次数。 */
  const countRevParse = async () => {
    const real = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync as (...a: unknown[]) => unknown;
    const calls = { n: 0 };
    mocks.spawnSync = (...a: unknown[]) => {
      if ((a[1] as string[]).includes("rev-parse")) calls.n++;
      return real(...a);
    };
    return calls;
  };

  it("parses ~/.claude.json once while it is unchanged, and again as soon as it changes", () => {
    const s = setup();
    s.writeClaudeJson({ enabledMcpjsonServers: ["one"] });
    age(s.paths.claudeJson);
    const parse = vi.spyOn(JSON, "parse");
    const big = () => parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes('"/other"')).length;
    expect(read(projectMcpApprovalSettings([s.repo], s.p)!).enabledMcpjsonServers).toEqual(["one"]);
    expect(read(projectMcpApprovalSettings([s.repo], s.p)!).enabledMcpjsonServers).toEqual(["one"]);
    expect(big()).toBe(1);
    // 同样长度、不同内容：也要重读
    s.writeClaudeJson({ enabledMcpjsonServers: ["two"] });
    expect(read(projectMcpApprovalSettings([s.repo], s.p)!).enabledMcpjsonServers).toEqual(["two"]);
    expect(big()).toBe(2);
    parse.mockRestore();
  });

  it("does not cache a ~/.claude.json written in the last 2 seconds (a 1-second mtime could hide a same-size edit)", () => {
    const s = setup();
    s.writeClaudeJson({ enabledMcpjsonServers: ["one"] });
    const parse = vi.spyOn(JSON, "parse");
    const big = () => parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes('"/other"')).length;
    projectMcpApprovalSettings([s.repo], s.p);
    projectMcpApprovalSettings([s.repo], s.p);
    expect(big()).toBe(2);
    // 放够时间以后才缓存
    age(s.paths.claudeJson);
    projectMcpApprovalSettings([s.repo], s.p);
    projectMcpApprovalSettings([s.repo], s.p);
    expect(big()).toBe(3);
    parse.mockRestore();
  });

  it("asks git for a worktree's main checkout once, and again when the worktree is re-created for another repo at the same path", async () => {
    const s = setup();
    mkdirSync(s.repo, { recursive: true });
    s.gitInit();
    s.git("commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(s.root, "worktree");
    s.git("worktree", "add", "-q", "-b", "wt", worktree);
    // 仓库 B：同名分支，用户批准过的不一样
    const other = join(s.root, "other");
    mkdirSync(other);
    const gb = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: other, stdio: "pipe" });
    gb("init", "-q");
    gb("commit", "-q", "--allow-empty", "-m", "init");
    writeFileSync(s.paths.claudeJson, JSON.stringify({ projects: { [s.repo]: { enabledMcpjsonServers: ["a-only"] }, [other]: { enabledMcpjsonServers: ["b-only"] } } }));
    age(join(worktree, ".git"));
    const revParse = await countRevParse();
    expect(read(projectMcpApprovalSettings([worktree], s.p)!).enabledMcpjsonServers).toEqual(["a-only"]);
    expect(read(projectMcpApprovalSettings([worktree], s.p)!).enabledMcpjsonServers).toEqual(["a-only"]);
    expect(revParse.n).toBe(1);
    // 同一个路径换成仓库 B 的 worktree：A 的批准不能带过来
    s.git("worktree", "remove", "--force", worktree);
    gb("worktree", "add", "-q", "-b", "wt", worktree);
    expect(read(projectMcpApprovalSettings([worktree], s.p)!).enabledMcpjsonServers).toEqual(["b-only"]);
    expect(revParse.n).toBe(2);
  });

  it("asks git again when the main checkout was moved away and another repo now sits at its path (that repo's approvals must not apply)", async () => {
    const s = setup();
    mkdirSync(s.repo, { recursive: true });
    s.gitInit();
    s.git("commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(s.root, "worktree");
    s.git("worktree", "add", "-q", "-b", "wt", worktree);
    age(join(worktree, ".git"));
    writeFileSync(s.paths.claudeJson, JSON.stringify({ projects: { [s.repo]: { enabledMcpjsonServers: ["a-only"] } } }));
    const revParse = await countRevParse();
    expect(read(projectMcpApprovalSettings([worktree], s.p)!).enabledMcpjsonServers).toEqual(["a-only"]);
    expect(revParse.n).toBe(1);
    // A 挪走，原路径上新建仓库 B，用户给 B 批了全部；worktree 的 .git 文件一个字没变
    renameSync(s.repo, join(s.root, "repo-moved"));
    mkdirSync(s.repo);
    execFileSync("git", ["init", "-q"], { cwd: s.repo, stdio: "pipe" });
    writeFileSync(s.paths.claudeJson, JSON.stringify({ projects: { [s.repo]: { enableAllProjectMcpServers: true, enabledMcpjsonServers: ["b-only"] } } }));
    const out = projectMcpApprovalSettings([worktree], s.p);
    expect(revParse.n).toBe(2);
    const servers = out ? read(out).enabledMcpjsonServers : [];
    expect(servers).not.toContain("b-only");
    expect(out ? (JSON.parse(readFileSync(out, "utf8")) as { enableAllProjectMcpServers?: boolean }).enableAllProjectMcpServers : undefined).not.toBe(true);
  });
});
