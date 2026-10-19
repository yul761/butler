import { writeFileSync } from "node:fs";
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
    const run = async (_f: string, args: string[]) => (args[0] === "--version" ? "2.1.304" : "--print --session-id --resume --fork-session --mcp-config --output-format --json-schema --allowedTools");
    const health = new HealthService({ paths, platform: "darwin", env: {}, settings, bundledHookBin: bundled, readPath: async () => "/usr/bin", run });

    const first = await health.refresh();
    expect(first.claude).toMatchObject({ path: fakeClaude, version: "2.1.304", missingFlags: [] });
    expect(first.hooks).toBe("missing");
    expect(first.hookBinInstalled).toBe(false);
    expect(health.claude()).toEqual({ path: fakeClaude, pathValue: "/usr/bin" });

    const installed = await health.installHooks();
    expect(installed.hooks).toBe("installed");
    expect(installed.hookBinInstalled).toBe(true);

    expect((await health.uninstallHooks()).hooks).toBe("missing");

    writeFileSync(paths.claudeSettings, "{oops");
    expect((await health.refresh()).hooks).toBe("settings_invalid");
  });
});
