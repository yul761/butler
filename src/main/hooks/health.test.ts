import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { resolvePaths } from "../paths";
import { memDb, tempDir } from "../test-utils";
import { HealthService } from "./health";

describe("HealthService", () => {
  it("reports claude, installs hooks + binary, and detects invalid settings", async () => {
    const home = tempDir();
    const paths = resolvePaths({ BUTLER_HOME: join(home, ".butler"), CLAUDE_CONFIG_DIR: join(home, ".claude") }, "darwin", home);
    const fakeClaude = join(home, "claude");
    writeFileSync(fakeClaude, "");
    const bundled = join(home, "bundled-hook");
    writeFileSync(bundled, "#!/bin/sh\n");
    const settings = new SettingsRepo(memDb());
    settings.set("claudePath", fakeClaude);
    const run = async (_f: string, args: string[]) => (args[0] === "--version" ? "2.1.304" : "--print --session-id --resume --fork-session --mcp-config --output-format --json-schema --allowedTools --disallowedTools --no-session-persistence --permission-mode --setting-sources --add-dir --settings");
    const health = new HealthService({ paths, platform: "darwin", env: {}, settings, bundledHookBin: bundled, readPath: async () => "/usr/bin", run });

    const first = await health.refresh();
    expect(first.claude).toMatchObject({ path: fakeClaude, version: "2.1.304", missingFlags: [] });
    expect(first.hooks).toBe("missing");
    expect(first.hookBinInstalled).toBe(false);
    expect(first.handoffCommand).toBe("missing");
    expect(health.claude()).toEqual({ path: fakeClaude, pathValue: "/usr/bin" });

    const installed = await health.installHooks();
    expect(installed.hooks).toBe("installed");
    expect(installed.hookBinInstalled).toBe(true);
    expect(installed.handoffCommand).toBe("installed");
    expect(existsSync(join(paths.claudeCommands, "handoff.md"))).toBe(true);

    const removed = await health.uninstallHooks();
    expect(removed.hooks).toBe("missing");
    expect(removed.handoffCommand).toBe("missing");

    writeFileSync(paths.claudeSettings, "{oops");
    expect((await health.refresh()).hooks).toBe("settings_invalid");
  });

  it("treats any settings read failure (e.g. a directory at the path) as settings_invalid", async () => {
    const home = tempDir();
    const paths = resolvePaths({ BUTLER_HOME: join(home, ".butler"), CLAUDE_CONFIG_DIR: join(home, ".claude") }, "darwin", home);
    mkdirSync(paths.claudeSettings, { recursive: true });
    const health = new HealthService({
      paths, platform: "darwin", env: {}, settings: new SettingsRepo(memDb()), bundledHookBin: "/none",
      readPath: async () => "/usr/bin", run: async () => "",
    });
    expect((await health.refresh()).hooks).toBe("settings_invalid");
  });

  it("keeps a user's own /handoff command and reports the conflict", async () => {
    const home = tempDir();
    const paths = resolvePaths({ BUTLER_HOME: join(home, ".butler"), CLAUDE_CONFIG_DIR: join(home, ".claude") }, "darwin", home);
    mkdirSync(paths.claudeCommands, { recursive: true });
    writeFileSync(join(paths.claudeCommands, "handoff.md"), "mine");
    const bundled = join(home, "bundled-hook");
    writeFileSync(bundled, "#!/bin/sh\n");
    const health = new HealthService({
      paths, platform: "darwin", env: {}, settings: new SettingsRepo(memDb()), bundledHookBin: bundled,
      readPath: async () => "/usr/bin", run: async () => "",
    });
    expect((await health.installHooks()).handoffCommand).toBe("conflict");
    expect(readFileSync(join(paths.claudeCommands, "handoff.md"), "utf8")).toBe("mine");
  });

  it("reports the memory store, the MCP bundle and a StateCore capture plugin the user installed", async () => {
    const home = tempDir();
    const paths = resolvePaths({ BUTLER_HOME: join(home, ".butler"), CLAUDE_CONFIG_DIR: join(home, ".claude") }, "darwin", home);
    mkdirSync(paths.claudeConfigDir, { recursive: true });
    const bundle = join(home, "statecore-mcp.cjs");
    const settings = new SettingsRepo(memDb());
    const health = new HealthService({
      paths, platform: "darwin", env: {}, settings, bundledHookBin: "/none", memoryMcpScript: bundle,
      readPath: async () => "/usr/bin", run: async () => "",
    });
    expect((await health.refresh()).memory).toEqual({ enabled: true, dataDir: paths.statecore, mcpBundle: false, statecorePlugin: false });
    writeFileSync(bundle, "");
    writeFileSync(paths.claudeSettings, JSON.stringify({ enabledPlugins: { "statecore@market": true } }));
    settings.set("memoryEnabled", "0");
    expect((await health.refresh()).memory).toEqual({ enabled: false, dataDir: paths.statecore, mcpBundle: true, statecorePlugin: true });
  });

  describe("syncHookBinary（最终审查 1：升级后旧的 butler-hook 不认 gate）", () => {
    const setup = () => {
      const home = tempDir();
      const paths = resolvePaths({ BUTLER_HOME: join(home, ".butler"), CLAUDE_CONFIG_DIR: join(home, ".claude") }, "darwin", home);
      const bundled = join(home, "bundled-hook");
      writeFileSync(bundled, "#!/bin/sh\necho new\n");
      const logs: string[] = [];
      const health = new HealthService({
        paths, platform: "darwin", env: {}, settings: new SettingsRepo(memDb()), bundledHookBin: bundled,
        readPath: async () => "/usr/bin", run: async () => "", log: (m) => logs.push(m),
      });
      return { paths, bundled, health, logs };
    };

    it("replaces a stale installed binary with the bundled one and turns the gate on", async () => {
      const { paths, health, logs } = setup();
      mkdirSync(join(paths.home, "bin"), { recursive: true });
      writeFileSync(paths.hookBin, "#!/bin/sh\necho an older version\n");
      expect(health.hookBinCurrent()).toBe(false);
      expect(await health.syncHookBinary()).toBe(true);
      expect(readFileSync(paths.hookBin, "utf8")).toBe("#!/bin/sh\necho new\n");
      expect(statSync(paths.hookBin).mode & 0o111).not.toBe(0);
      expect(health.hookBinCurrent()).toBe(true);
      expect(logs.some((m) => m.includes("out of date"))).toBe(true);
    });

    it("also replaces a binary of the same size but different content", async () => {
      const { paths, health } = setup();
      mkdirSync(join(paths.home, "bin"), { recursive: true });
      writeFileSync(paths.hookBin, "#!/bin/sh\necho old\n"); // 和 new 一样长
      expect(await health.syncHookBinary()).toBe(true);
      expect(readFileSync(paths.hookBin, "utf8")).toBe("#!/bin/sh\necho new\n");
    });

    it("leaves an identical binary alone", async () => {
      const { paths, health } = setup();
      mkdirSync(join(paths.home, "bin"), { recursive: true });
      writeFileSync(paths.hookBin, "#!/bin/sh\necho new\n");
      utimesSync(paths.hookBin, 1_000_000, 1_000_000);
      expect(await health.syncHookBinary()).toBe(true);
      expect(statSync(paths.hookBin).mtimeMs).toBe(1_000_000_000);
      expect(health.hookBinCurrent()).toBe(true);
    });

    it("keeps the gate off and does not throw when the copy fails", async () => {
      const { paths, health, logs } = setup();
      mkdirSync(join(paths.home, "bin"), { recursive: true });
      writeFileSync(paths.hookBin, "#!/bin/sh\necho old\n");
      mkdirSync(`${paths.hookBin}.tmp`); // 临时文件的位置是个目录：写不进去
      expect(await health.syncHookBinary()).toBe(false);
      expect(health.hookBinCurrent()).toBe(false);
      expect(readFileSync(paths.hookBin, "utf8")).toBe("#!/bin/sh\necho old\n");
      expect(logs.some((m) => m.includes("could not replace"))).toBe(true);
    });

    it("does not install a binary the user never installed", async () => {
      const { paths, health } = setup();
      expect(await health.syncHookBinary()).toBe(false);
      expect(existsSync(paths.hookBin)).toBe(false);
    });

    it("keeps the gate off when the bundled binary is missing", async () => {
      const { paths, bundled, health } = setup();
      mkdirSync(join(paths.home, "bin"), { recursive: true });
      writeFileSync(paths.hookBin, "#!/bin/sh\necho old\n");
      rmSync(bundled);
      expect(await health.syncHookBinary()).toBe(false);
      expect(readFileSync(paths.hookBin, "utf8")).toBe("#!/bin/sh\necho old\n");
    });

    it("installHooks turns the gate on", async () => {
      const { health } = setup();
      await health.installHooks();
      expect(health.hookBinCurrent()).toBe(true);
    });
  });
});
