import { describe, expect, it } from "vitest";
import { parseFlags, parseVersion, probeClaude, REQUIRED_FLAGS } from "./capabilities";

const HELP = `
  -p, --print                           Print response and exit
  -r, --resume [value]                  Resume a conversation
  --session-id <uuid>                   Use a specific session ID
  --fork-session                        When resuming, create a new session ID
  --mcp-config <configs...>             Load MCP servers
  --output-format <format>              Output format
  --json-schema <schema>                JSON Schema for structured output
  --allowedTools, --allowed-tools <tools...>
  --disallowedTools, --disallowed-tools <tools...>
  --no-session-persistence              Disable session persistence
  --permission-mode <mode>              Permission mode to use for the session
  --setting-sources <sources>           Comma-separated list of setting sources to load (user, project, local)
  --add-dir <directories...>            Additional directories to allow tool access to
`;

describe("capabilities", () => {
  it("warns when claude is too old to know --setting-sources", async () => {
    const old = HELP.split("\n").filter((l) => !l.includes("--setting-sources")).join("\n");
    const run = async (_f: string, args: string[]) => (args[0] === "--version" ? "2.0.0" : old);
    const h = await probeClaude("/bin/claude", {}, run);
    expect(h.missingFlags).toEqual(["--setting-sources"]);
  });

  it("parses the version", () => {
    expect(parseVersion("2.1.304 (Claude Code)\n")).toBe("2.1.304");
    expect(parseVersion("garbage")).toBeNull();
  });

  it("detects every required flag in real help text", () => {
    const flags = parseFlags(HELP);
    expect(REQUIRED_FLAGS.every((f) => flags[f])).toBe(true);
  });

  it("does not match a flag that is only a prefix of another", () => {
    expect(parseFlags("  --resume-later   nope")["--resume"]).toBe(false);
  });

  it("probe reports missing flags and errors", async () => {
    const run = async (_f: string, args: string[]) => (args[0] === "--version" ? "2.0.0" : "  -p, --print  x\n");
    const h = await probeClaude("/bin/claude", {}, run);
    expect(h.version).toBe("2.0.0");
    expect(h.missingFlags).toContain("--fork-session");
    expect(h.missingFlags).not.toContain("--print");

    const failed = await probeClaude("/bin/claude", {}, async () => { throw new Error("not executable"); });
    expect(failed.error).toContain("not executable");
    expect(await probeClaude(null, {})).toMatchObject({ path: null, error: "claude_not_found" });
  });
});
