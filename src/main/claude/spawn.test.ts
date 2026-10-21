import { describe, expect, it } from "vitest";
import { claudeArgs, sessionEnv, spawnSpec } from "./spawn";

describe("claude spawn helpers", () => {
  it("builds new and resume args", () => {
    expect(claudeArgs({ mode: "new", sessionId: "u1" })).toEqual(["--session-id", "u1"]);
    expect(claudeArgs({ mode: "resume", sessionId: "u1", mcpConfigPath: "/m.json" })).toEqual(["--resume", "u1", "--mcp-config", "/m.json"]);
  });

  it("runs .cmd shims through cmd.exe on Windows only", () => {
    expect(spawnSpec("C:\\npm\\claude.cmd", ["--resume", "u"], "win32")).toEqual({ file: "cmd.exe", args: ["/c", "C:\\npm\\claude.cmd", "--resume", "u"] });
    expect(spawnSpec("C:\\bin\\claude.exe", ["x"], "win32")).toEqual({ file: "C:\\bin\\claude.exe", args: ["x"] });
    expect(spawnSpec("/usr/local/bin/claude", ["x"], "darwin")).toEqual({ file: "/usr/local/bin/claude", args: ["x"] });
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
});
