import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaths } from "./paths";

describe("resolvePaths", () => {
  it("defaults to ~/.butler and ~/.claude", () => {
    const p = resolvePaths({}, "darwin", "/home/u");
    expect(p.home).toBe(join("/home/u", ".butler"));
    expect(p.db).toBe(join("/home/u", ".butler", "app.db"));
    expect(p.inbox).toBe(join("/home/u", ".butler", "inbox"));
    expect(p.inboxBad).toBe(join("/home/u", ".butler", "inbox", "bad"));
    expect(p.hookBin).toBe(join("/home/u", ".butler", "bin", "butler-hook"));
    expect(p.claudeSettings).toBe(join("/home/u", ".claude", "settings.json"));
    expect(p.claudeProjects).toBe(join("/home/u", ".claude", "projects"));
    expect(p.claudeCommands).toBe(join("/home/u", ".claude", "commands"));
  });

  it("honours BUTLER_HOME and CLAUDE_CONFIG_DIR", () => {
    const p = resolvePaths({ BUTLER_HOME: "/data/b", CLAUDE_CONFIG_DIR: "/data/c" }, "darwin", "/home/u");
    expect(p.home).toBe("/data/b");
    expect(p.claudeSettings).toBe(join("/data/c", "settings.json"));
  });

  it("uses .exe for the hook binary on Windows", () => {
    expect(resolvePaths({}, "win32", "/home/u").hookBin.endsWith("butler-hook.exe")).toBe(true);
  });

  it("resolves a relative BUTLER_HOME against the current directory", () => {
    expect(resolvePaths({ BUTLER_HOME: "rel/b" }, "darwin", "/home/u").home).toBe(resolve("rel/b"));
  });

  it("finds Claude Code's global config in the config dir only when CLAUDE_CONFIG_DIR is set, and the mcp dir under BUTLER_HOME", () => {
    expect(resolvePaths({}, "darwin", "/home/u").claudeJson).toBe(join("/home/u", ".claude.json"));
    expect(resolvePaths({ CLAUDE_CONFIG_DIR: "/data/c" }, "darwin", "/home/u").claudeJson).toBe(join("/data/c", ".claude.json"));
    expect(resolvePaths({}, "darwin", "/home/u").mcp).toBe(join("/home/u", ".butler", "mcp"));
    expect(resolvePaths({}, "darwin", "/home/u").statecore).toBe(join("/home/u", ".butler", "statecore"));
  });

  it("expands ~ in BUTLER_HOME and CLAUDE_CONFIG_DIR", () => {
    expect(resolvePaths({ BUTLER_HOME: "~/bh" }, "darwin", "/home/u").home).toBe(join("/home/u", "bh"));
    expect(resolvePaths({ BUTLER_HOME: "~" }, "darwin", "/home/u").home).toBe("/home/u");
    expect(resolvePaths({ CLAUDE_CONFIG_DIR: "~\\cc" }, "win32", "/home/u").claudeConfigDir).toBe(join("/home/u", "cc"));
  });
});
