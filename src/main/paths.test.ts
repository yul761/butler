import { join } from "node:path";
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
});
