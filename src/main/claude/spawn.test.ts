import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeArgs, cmdShimSafe, headlessEnv, sessionEnv } from "./spawn";

describe("claude spawn helpers", () => {
  it("builds new and resume args", () => {
    expect(claudeArgs({ mode: "new", sessionId: "u1" })).toEqual(["--session-id", "u1"]);
    expect(claudeArgs({ mode: "resume", sessionId: "u1", mcpConfigPath: "/m.json" })).toEqual(["--resume", "u1", "--mcp-config", "/m.json"]);
  });

  it("builds the session env", () => {
    const env = sessionEnv(
      { Path: "C:\\old", HOME: "/h", ELECTRON_RUN_AS_NODE: "1", CLAUDECODE: "1", EMPTY: undefined },
      { pathValue: "C:\\new", ticketKey: "PROJ-1", sessionId: "u1" },
    );
    expect(env).toEqual({ Path: "C:\\new", HOME: "/h", TERM: "xterm-256color", COLORTERM: "truecolor", BUTLER_TICKET: "PROJ-1", BUTLER_SESSION: "u1" });
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
    expect(Object.keys(env).filter((k) => k.startsWith("CLAUDE"))).toEqual(["CLAUDE_CODE_USE_BEDROCK"]);
    expect(env.ANTHROPIC_MODEL).toBe("m");
  });

  it("keeps the inherited PATH when the login PATH is empty", () => {
    expect(sessionEnv({ PATH: "/usr/bin" }, { pathValue: "", ticketKey: "T-1", sessionId: "u" }).PATH).toBe("/usr/bin");
  });

  it("builds a headless env: no ticket, a headless session marker, parent markers dropped", () => {
    const env = headlessEnv(
      { PATH: "/usr/bin", BUTLER_TICKET: "OLD-1", BUTLER_SESSION: "x", CLAUDECODE: "1", ELECTRON_RUN_AS_NODE: "1", HOME: "/h" },
      { pathValue: "/login/bin", runId: "r1" },
    );
    expect(env).toEqual({ PATH: "/login/bin", HOME: "/h", BUTLER_SESSION: "headless:r1" });
  });

  it("turns a relative BUTLER_HOME / CLAUDE_CONFIG_DIR into an absolute path for every child", () => {
    const base = { PATH: "/usr/bin", BUTLER_HOME: "rel/b", CLAUDE_CONFIG_DIR: "rel/c" };
    const s = sessionEnv(base, { pathValue: "", ticketKey: "T-1", sessionId: "u" });
    const h = headlessEnv(base, { pathValue: "", runId: "r" });
    for (const e of [s, h]) {
      expect(e.BUTLER_HOME).toBe(resolve("rel/b"));
      expect(e.CLAUDE_CONFIG_DIR).toBe(resolve("rel/c"));
    }
    expect("BUTLER_HOME" in headlessEnv({ PATH: "/usr/bin" }, { pathValue: "", runId: "r" })).toBe(false);
  });
});

describe("cmdShimSafe", () => {
  it("accepts anything when no cmd.exe is involved", () => {
    expect(cmdShimSafe("/usr/local/bin/claude", "/Users/John Smith/.butler/mcp/A-1.json", "darwin")).toBe(true);
    expect(cmdShimSafe("C:\\bin\\claude.exe", "C:\\Users\\John Smith\\x.json", "win32")).toBe(true);
  });

  it("rejects spaces, quotes and cmd metacharacters for a .cmd shim on Windows", () => {
    expect(cmdShimSafe("C:\\npm\\claude.cmd", "C:\\Users\\john\\.butler\\mcp\\A-1.json", "win32")).toBe(true);
    for (const bad of ["C:\\Users\\John Smith\\x.json", 'C:\\a"b.json', "C:\\a&b.json", "C:\\a%b.json", "C:\\a^b.json", "C:\\a(b).json"]) {
      expect(cmdShimSafe("C:\\npm\\claude.cmd", bad, "win32"), bad).toBe(false);
    }
  });
});
