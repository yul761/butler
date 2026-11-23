import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inboxDir } from "../../../hook/shipherd-hook";
import { AUTO_COMPACT_WINDOW_DEFAULT, SUBAGENT_MODEL_DEFAULT, bypassProxyForLoopback, claudeArgs, cmdShimSafe, headlessEnv, sessionEnv, storedModel } from "./spawn";

describe("claude spawn helpers", () => {
  it("adds the guide file after the other flags", () => {
    expect(claudeArgs({ mode: "new", sessionId: "u1", settingsPath: "/s.json", guidePath: "/g.md" })).toEqual(["--session-id", "u1", "--settings", "/s.json", "--append-system-prompt-file", "/g.md"]);
  });

  it("adds --model last when given, and not for null or undefined", () => {
    expect(claudeArgs({ mode: "new", sessionId: "s", model: "sonnet" })).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    expect(claudeArgs({ mode: "new", sessionId: "s", guidePath: "/g.md", model: "opus" }).slice(-2)).toEqual(["--model", "opus"]);
    expect(claudeArgs({ mode: "resume", sessionId: "s", model: null })).toEqual(["--resume", "s"]);
    expect(claudeArgs({ mode: "new", sessionId: "s" })).not.toContain("--model");
  });

  it("sets the subagent model and compact window by default", () => {
    const e = sessionEnv({}, { pathValue: "", sessionId: "s" });
    expect(e.CLAUDE_CODE_SUBAGENT_MODEL).toBe(SUBAGENT_MODEL_DEFAULT);
    expect(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(AUTO_COMPACT_WINDOW_DEFAULT);
    expect(e.CLAUDE_CODE_SUBAGENT_MODEL).toBe("sonnet");
    expect(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("250000");
  });

  it("keeps the user's own subagent model and compact window", () => {
    const e = sessionEnv({ CLAUDE_CODE_SUBAGENT_MODEL: "opus", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" }, { pathValue: "", sessionId: "s" });
    expect(e.CLAUDE_CODE_SUBAGENT_MODEL).toBe("opus");
    expect(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("400000");
  });

  it("headlessEnv does not add them", () => {
    const e = headlessEnv({}, { pathValue: "", runId: "r" });
    expect(e.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  it("builds new and resume args", () => {
    expect(claudeArgs({ mode: "new", sessionId: "u1" })).toEqual(["--session-id", "u1"]);
    expect(claudeArgs({ mode: "resume", sessionId: "u1", mcpConfigPath: "/m.json" })).toEqual(["--resume", "u1", "--mcp-config", "/m.json"]);
    expect(claudeArgs({ mode: "new", sessionId: "u1", settingsPath: "/s.json" })).toEqual(["--session-id", "u1", "--settings", "/s.json"]);
  });

  it("builds the session env", () => {
    const env = sessionEnv(
      { Path: "C:\\old", HOME: "/h", ELECTRON_RUN_AS_NODE: "1", CLAUDECODE: "1", EMPTY: undefined },
      { pathValue: "C:\\new", ticketKey: "PROJ-1", sessionId: "u1" },
    );
    expect(env).toEqual({ Path: "C:\\new", HOME: "/h", TERM: "xterm-256color", COLORTERM: "truecolor", SHIPHERD_TICKET: "PROJ-1", SHIPHERD_SESSION: "u1", CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "250000" });
  });

  it("drops the parent Claude Code session's markers but keeps user configuration", () => {
    const env = sessionEnv(
      {
        HOME: "/h",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_SESSION_ID: "parent",
        CLAUDE_CODE_SESSION_ATTENDED: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_EXECPATH: "/x/claude",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "secret",
        CLAUDE_CODE_SSE_PORT: "1234",
        CLAUDE_PID: "42",
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_MODEL: "m",
      },
      { pathValue: "", ticketKey: "T-1", sessionId: "u" },
    );
    expect(Object.keys(env).filter((k) => k.startsWith("CLAUDE") && k !== "CLAUDE_CODE_SUBAGENT_MODEL" && k !== "CLAUDE_CODE_AUTO_COMPACT_WINDOW")).toEqual(["CLAUDE_CODE_USE_BEDROCK"]);
    expect(env.ANTHROPIC_MODEL).toBe("m");
  });

  it("keeps the inherited PATH when the login PATH is empty", () => {
    expect(sessionEnv({ PATH: "/usr/bin" }, { pathValue: "", ticketKey: "T-1", sessionId: "u" }).PATH).toBe("/usr/bin");
  });

  it("builds a headless env: no ticket, a headless session marker, parent markers dropped", () => {
    const env = headlessEnv(
      { PATH: "/usr/bin", SHIPHERD_TICKET: "OLD-1", SHIPHERD_SESSION: "x", CLAUDECODE: "1", ELECTRON_RUN_AS_NODE: "1", HOME: "/h" },
      { pathValue: "/login/bin", runId: "r1" },
    );
    expect(env).toEqual({ PATH: "/login/bin", HOME: "/h", SHIPHERD_SESSION: "headless:r1" });
  });

  it("turns a relative SHIPHERD_HOME / CLAUDE_CONFIG_DIR into an absolute path for every child", () => {
    const base = { PATH: "/usr/bin", SHIPHERD_HOME: "rel/b", CLAUDE_CONFIG_DIR: "rel/c" };
    const s = sessionEnv(base, { pathValue: "", ticketKey: "T-1", sessionId: "u" });
    const h = headlessEnv(base, { pathValue: "", runId: "r" });
    for (const e of [s, h]) {
      expect(e.SHIPHERD_HOME).toBe(resolve("rel/b"));
      expect(e.CLAUDE_CONFIG_DIR).toBe(resolve("rel/c"));
    }
    expect("SHIPHERD_HOME" in headlessEnv({ PATH: "/usr/bin" }, { pathValue: "", runId: "r" })).toBe(false);
  });
});

describe("storedModel", () => {
  it("keeps aliases and names the registry has (even disabled ones), drops the rest like 2.1.0", () => {
    const registered = (m: string) => m === "claude-fake-high";
    expect(storedModel({ model: "opus" })).toBe("opus");
    expect(storedModel({ model: "claude-fake-high" }, registered)).toBe("claude-fake-high");
    expect(storedModel({ model: "claude-fake-high" })).toBeNull();
    expect(storedModel({ model: "gpt" }, registered)).toBeNull();
    expect(storedModel({ model: null }, registered)).toBeNull();
  });
});

describe("cmdShimSafe", () => {
  it("accepts anything when no cmd.exe is involved", () => {
    expect(cmdShimSafe("/usr/local/bin/claude", "/Users/John Smith/.shipherd/mcp/A-1.json", "darwin")).toBe(true);
    expect(cmdShimSafe("C:\\bin\\claude.exe", "C:\\Users\\John Smith\\x.json", "win32")).toBe(true);
  });

  it("rejects spaces, quotes and cmd metacharacters for a .cmd shim on Windows", () => {
    expect(cmdShimSafe("C:\\npm\\claude.cmd", "C:\\Users\\john\\.shipherd\\mcp\\A-1.json", "win32")).toBe(true);
    for (const bad of ["C:\\Users\\John Smith\\x.json", 'C:\\a"b.json', "C:\\a&b.json", "C:\\a%b.json", "C:\\a^b.json", "C:\\a(b).json"]) {
      expect(cmdShimSafe("C:\\npm\\claude.cmd", bad, "win32"), bad).toBe(false);
    }
  });
});

describe("SHIPHERD_HOME agreement between spawn env and the hook", () => {
  it("resolves ~/x and the equivalent absolute path to the same inbox", () => {
    const x = { pathValue: "", ticketKey: "t", sessionId: "s" };
    for (const home of ["~/x", join(homedir(), "x")]) {
      const env = sessionEnv({ SHIPHERD_HOME: home }, x);
      expect(env.SHIPHERD_HOME).toBe(join(homedir(), "x"));
      expect(inboxDir(env)).toBe(join(homedir(), "x", "inbox"));
      expect(inboxDir({ SHIPHERD_HOME: home })).toBe(inboxDir(env));
    }
  });
});

describe("loopback stays off the proxy (WS-M H)", () => {
  it("adds 127.0.0.1 to NO_PROXY only when a proxy is set, keeping what is there", () => {
    const none: Record<string, string> = { PATH: "/bin" };
    bypassProxyForLoopback(none);
    expect(none).toEqual({ PATH: "/bin" });
    const kept: Record<string, string> = { HTTPS_PROXY: "http://proxy:8080", no_proxy: "corp.example, localhost" };
    bypassProxyForLoopback(kept);
    expect(kept.no_proxy).toBe("corp.example,localhost,127.0.0.1");
    expect(Object.keys(kept).filter((k) => k.toLowerCase() === "no_proxy")).toEqual(["no_proxy"]);
    const fresh: Record<string, string> = { http_proxy: "http://p" };
    bypassProxyForLoopback(fresh);
    expect(fresh.NO_PROXY).toBe("127.0.0.1");
    const all: Record<string, string> = { HTTP_PROXY: "http://p", NO_PROXY: "*" };
    bypassProxyForLoopback(all);
    expect(all.NO_PROXY).toBe("*");
  });
});

// BTL-260：外层环境里漏进来的旧 BUTLER_TICKET 等（比如从旧 Butler 的终端里启动 Shipherd）不能传给子 claude：
// hook 在新名字没设时会退回旧名字，会被当成这个 session 的 ticket。BUTLER_HOME 换成 SHIPHERD_HOME 传下去。
describe("pre-rename variables in the parent environment", () => {
  it("drops BUTLER_TICKET, BUTLER_SESSION and BUTLER_HOME, keeps other BUTLER_ variables, and passes the data folder as SHIPHERD_HOME", () => {
    const base = { BUTLER_TICKET: "OLD-1", BUTLER_SESSION: "old", BUTLER_HOME: "/data/old", BUTLER_COLOR: "blue" };
    const e = sessionEnv(base, { pathValue: "", sessionId: "s" });
    expect(e.BUTLER_TICKET).toBeUndefined();
    expect(e.BUTLER_SESSION).toBeUndefined();
    expect(e.BUTLER_HOME).toBeUndefined();
    expect(e.SHIPHERD_TICKET).toBeUndefined();
    expect(e.SHIPHERD_SESSION).toBe("s");
    expect(e.SHIPHERD_HOME).toBe("/data/old");
    expect(e.BUTLER_COLOR).toBe("blue");
    const h = headlessEnv(base, { pathValue: "", runId: "r" });
    expect(h.BUTLER_TICKET).toBeUndefined();
    expect(h.SHIPHERD_HOME).toBe("/data/old");
  });
});
