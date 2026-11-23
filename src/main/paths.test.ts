import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./test-utils";
import { ensureDirs, homeFromEnv, refreshTailPath, resolvePaths } from "./paths";
import { inboxDir, writeEnvelope } from "../../hook/shipherd-hook";

describe("resolvePaths", () => {
  it("defaults to ~/.shipherd and ~/.claude", () => {
    const p = resolvePaths({}, "darwin", "/home/u");
    expect(p.home).toBe(join("/home/u", ".shipherd"));
    expect(p.db).toBe(join("/home/u", ".shipherd", "app.db"));
    expect(p.inbox).toBe(join("/home/u", ".shipherd", "inbox"));
    expect(p.inboxBad).toBe(join("/home/u", ".shipherd", "inbox", "bad"));
    expect(p.hookBin).toBe(join("/home/u", ".shipherd", "bin", "shipherd-hook"));
    expect(p.claudeSettings).toBe(join("/home/u", ".claude", "settings.json"));
    expect(p.claudeProjects).toBe(join("/home/u", ".claude", "projects"));
    expect(p.claudeSessions).toBe(join("/home/u", ".claude", "sessions"));
    expect(p.claudeCommands).toBe(join("/home/u", ".claude", "commands"));
    expect(p.refresh).toBe(join("/home/u", ".shipherd", "refresh"));
    // Shipherd 总控（BTL-190 第 5 点）的工作目录：和 ticket 的工作区放在一起，名字以 _ 开头，不会和 ticket 号撞上。
    expect(p.shipherdWorkspace).toBe(join("/home/u", ".shipherd", "workspaces", "_shipherd"));
  });

  it("puts a session's refresh tail at refresh/<session id>.md and keeps odd ids inside that directory", () => {
    const p = resolvePaths({}, "darwin", "/home/u");
    expect(refreshTailPath(p, "0b6c-4e2f_9")).toBe(join("/home/u", ".shipherd", "refresh", "0b6c-4e2f_9.md"));
    expect(refreshTailPath(p, "../x/y")).toBe(join("/home/u", ".shipherd", "refresh", "___x_y.md"));
  });

  it("honours SHIPHERD_HOME and CLAUDE_CONFIG_DIR", () => {
    const p = resolvePaths({ SHIPHERD_HOME: "/data/b", CLAUDE_CONFIG_DIR: "/data/c" }, "darwin", "/home/u");
    expect(p.home).toBe("/data/b");
    expect(p.claudeSettings).toBe(join("/data/c", "settings.json"));
    expect(p.claudeSessions).toBe(join("/data/c", "sessions"));
  });

  it("uses .exe for the hook binary on Windows", () => {
    expect(resolvePaths({}, "win32", "/home/u").hookBin.endsWith("shipherd-hook.exe")).toBe(true);
  });

  it("resolves a relative SHIPHERD_HOME against the current directory", () => {
    expect(resolvePaths({ SHIPHERD_HOME: "rel/b" }, "darwin", "/home/u").home).toBe(resolve("rel/b"));
  });

  it("finds Claude Code's global config in the config dir only when CLAUDE_CONFIG_DIR is set, and the mcp dir under SHIPHERD_HOME", () => {
    expect(resolvePaths({}, "darwin", "/home/u").claudeJson).toBe(join("/home/u", ".claude.json"));
    expect(resolvePaths({ CLAUDE_CONFIG_DIR: "/data/c" }, "darwin", "/home/u").claudeJson).toBe(join("/data/c", ".claude.json"));
    expect(resolvePaths({}, "darwin", "/home/u").mcp).toBe(join("/home/u", ".shipherd", "mcp"));
    expect(resolvePaths({}, "darwin", "/home/u").statecore).toBe(join("/home/u", ".shipherd", "statecore"));
  });

  it("expands ~ in SHIPHERD_HOME and CLAUDE_CONFIG_DIR", () => {
    expect(resolvePaths({ SHIPHERD_HOME: "~/bh" }, "darwin", "/home/u").home).toBe(join("/home/u", "bh"));
    expect(resolvePaths({ SHIPHERD_HOME: "~" }, "darwin", "/home/u").home).toBe("/home/u");
    expect(resolvePaths({ CLAUDE_CONFIG_DIR: "~\\cc" }, "win32", "/home/u").claudeConfigDir).toBe(join("/home/u", "cc"));
  });

  // BTL-260：改名前的 BUTLER_HOME 还认（SHIPHERD_HOME 没设或是空的时候），主进程、hook、MCP 都走 homeFromEnv。
  it("falls back to the pre-rename BUTLER_HOME, with SHIPHERD_HOME taking priority", () => {
    expect(resolvePaths({ BUTLER_HOME: "/data/old" }, "darwin", "/home/u").home).toBe("/data/old");
    expect(resolvePaths({ BUTLER_HOME: "/data/old", SHIPHERD_HOME: "/data/new" }, "darwin", "/home/u").home).toBe("/data/new");
    expect(resolvePaths({ BUTLER_HOME: "/data/old", SHIPHERD_HOME: " " }, "darwin", "/home/u").home).toBe("/data/old");
    expect(homeFromEnv({ BUTLER_HOME: "~/bh" }, "/home/u")).toBe(join("/home/u", "bh"));
  });

  // BTL-260：还没迁移（或者这次迁移失败、Shipherd 用着旧目录）时，Shipherd 外面起的 claude 调 hook 没有 SHIPHERD_HOME：
  // 写到 ~/.butler，不建出一个只有 inbox 的 ~/.shipherd（下次启动会被当成已经迁移过，打开空库）。
  it("uses ~/.butler while ~/.shipherd does not exist yet, so a hook outside Shipherd does not create a shell ~/.shipherd", () => {
    const has = (...dirs: string[]) => (p: string) => dirs.includes(p);
    const u = (n: string) => join("/home/u", n);
    expect(homeFromEnv({}, "/home/u", has(u(".butler")))).toBe(u(".butler"));
    expect(homeFromEnv({}, "/home/u", has(u(".butler"), u(".shipherd")))).toBe(u(".shipherd"));
    expect(homeFromEnv({}, "/home/u", has())).toBe(u(".shipherd"));
    expect(homeFromEnv({ SHIPHERD_HOME: "/x" }, "/home/u", has(u(".butler")))).toBe("/x");
    const real = tempDir("shipherd-hook-home-");
    mkdirSync(join(real, ".butler"));
    expect(inboxDir({}, real)).toBe(join(real, ".butler", "inbox"));
    writeEnvelope(inboxDir({}, real), { v: 1, receivedAt: 1, ticket: null, shipherdSession: null, payload: {} });
    expect(existsSync(join(real, ".shipherd"))).toBe(false);
    expect(readdirSync(join(real, ".butler", "inbox"))).toHaveLength(1);
    expect(homeFromEnv({}, "/home/u")).toBe(join("/home/u", ".shipherd"));
  });

  it("puts the merge gate's requests, results and alive file under gate/", () => {
    const p = resolvePaths({}, "darwin", "/home/u");
    expect(p.gateRequests).toBe(join("/home/u", ".shipherd", "gate", "requests"));
    expect(p.gateResults).toBe(join("/home/u", ".shipherd", "gate", "results"));
    expect(p.gateAlive).toBe(join("/home/u", ".shipherd", "gate", "alive.json"));
  });

  it("ensureDirs creates both gate directories", async () => {
    const home = tempDir("shipherd-paths-");
    const p = resolvePaths({ SHIPHERD_HOME: home }, "darwin", "/home/u");
    await ensureDirs(p);
    expect(existsSync(p.gateRequests)).toBe(true);
    expect(existsSync(p.gateResults)).toBe(true);
  });
});
