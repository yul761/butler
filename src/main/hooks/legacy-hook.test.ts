// BTL-260：改名前装进 ~/.claude/settings.json 的是 <~/.butler>/bin/butler-hook。butler-hook 是旧名字，测的就是它还被认得、被换掉。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { resolvePaths } from "../paths";
import { memDb, tempDir } from "../test-utils";
import { MIGRATED_MARKER } from "../migrate/legacy-home";
import { HealthService } from "./health";
import { applyInstall, applyUninstall, hasLegacyHook, HOOK_EVENTS, hookCommand, hookStatus, isLegacyHook, isShipherdHook } from "./installer";

const OLD = hookCommand("/Users/张 三/.butler/bin/butler-hook", "darwin");
const OLD_WIN = hookCommand("C:\\Users\\张 三\\.butler\\bin\\butler-hook.exe", "win32");
const NEW = hookCommand("/Users/张 三/.shipherd/bin/shipherd-hook", "darwin");
const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };

/** 改名前 Butler 装好的设置：四个事件各一条旧 hook，外加用户自己的。 */
const oldSettings = (cmd = OLD) => ({
  theme: "dark",
  hooks: {
    ...Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command: cmd, timeout: 10 }] }]])),
    PreToolUse: [userHook],
  },
});

describe("legacy butler-hook entries", () => {
  it("are recognised in both the macOS and the Windows form, and nothing that merely mentions butler-hook is", () => {
    expect(isLegacyHook(OLD)).toBe(true);
    expect(isLegacyHook(OLD_WIN)).toBe(true);
    expect(isShipherdHook(OLD)).toBe(true);
    for (const foreign of ["~/bin/my-butler-hook", "echo butler-hook", '"/x/my-butler-hook"', '"/x/butler-hooks"']) {
      expect(isLegacyHook(foreign)).toBe(false);
      expect(isShipherdHook(foreign)).toBe(false);
    }
    expect(isLegacyHook(NEW)).toBe(false);
  });

  it("make the installed hooks read as stale, so the hook is reinstalled", () => {
    expect(hasLegacyHook(oldSettings())).toBe(true);
    expect(hookStatus(oldSettings(), NEW)).toBe("stale");
  });

  it("are replaced by the new hook on install, one per event, with the user's own hooks and settings untouched", () => {
    const out = applyInstall(oldSettings(), NEW) as ReturnType<typeof oldSettings>;
    expect(hasLegacyHook(out)).toBe(false);
    expect(hookStatus(out, NEW)).toBe("installed");
    for (const e of HOOK_EVENTS) expect(JSON.stringify(out.hooks[e as keyof typeof out.hooks])).not.toContain("butler-hook");
    expect(out.hooks.PreToolUse).toEqual([userHook]);
    expect(out.theme).toBe("dark");
    // 再装一次也只有一条。
    expect(hookStatus(applyInstall(out, NEW), NEW)).toBe("installed");
  });

  it("are removed on uninstall too", () => {
    expect(applyUninstall(oldSettings())).toEqual({ theme: "dark", hooks: { PreToolUse: [userHook] } });
  });
});

describe("HealthService replaces the legacy hook at startup", () => {
  /** marker：这个数据目录是从哪个旧目录搬来的（写迁移标记）；dataDir：数据目录名（BUTLER_HOME 原样沿用时就是 .butler）。 */
  const setup = (settings: object | undefined | ((home: string) => object), o: { marker?: (home: string) => string; dataDir?: string } = {}) => {
    const home = tempDir();
    const paths = resolvePaths({ SHIPHERD_HOME: join(home, o.dataDir ?? ".shipherd"), CLAUDE_CONFIG_DIR: join(home, ".claude") }, "darwin", home);
    mkdirSync(paths.home, { recursive: true });
    if (o.marker) writeFileSync(join(paths.home, MIGRATED_MARKER), JSON.stringify({ from: o.marker(home), to: paths.home, how: "rename", at: 1 }));
    if (typeof settings === "function") settings = settings(home);
    const bundled = join(home, "bundled-hook");
    writeFileSync(bundled, "#!/bin/sh\necho new\n");
    mkdirSync(join(home, ".claude"), { recursive: true });
    if (settings !== undefined) writeFileSync(paths.claudeSettings, JSON.stringify(settings));
    const logs: string[] = [];
    const health = new HealthService({
      paths, platform: "darwin", env: {}, settings: new SettingsRepo(memDb()), bundledHookBin: bundled,
      readPath: async () => "/usr/bin", run: async () => "", log: (m) => logs.push(m),
    });
    return { paths, health, logs };
  };

  const legacyBin = (h: string) => join(h, "bin", "butler-hook");

  it("swaps the old entries for the new hook binary and asks for one more refresh", async () => {
    const { paths, health } = setup((home) => oldSettings(hookCommand(legacyBin(join(home, ".butler")), "darwin")), { marker: (home) => join(home, ".butler") });
    expect(await health.syncHookBinary()).toBe(true);
    expect(readFileSync(paths.hookBin, "utf8")).toBe("#!/bin/sh\necho new\n");
    const settings = JSON.parse(readFileSync(paths.claudeSettings, "utf8")) as ReturnType<typeof oldSettings>;
    expect(hookStatus(settings, hookCommand(paths.hookBin, "darwin"))).toBe("installed");
    expect(settings.hooks.PreToolUse).toEqual([userHook]);
    expect(health.takeLegacyHookMigrated()).toBe(true);
    expect(health.takeLegacyHookMigrated()).toBe(false);
  });

  it("also swaps them when the old data folder is used as it is (BUTLER_HOME)", async () => {
    const { paths, health } = setup((home) => oldSettings(hookCommand(legacyBin(join(home, ".butler")), "darwin")), { dataDir: ".butler" });
    expect(await health.syncHookBinary()).toBe(true);
    const settings = JSON.parse(readFileSync(paths.claudeSettings, "utf8")) as ReturnType<typeof oldSettings>;
    expect(hookStatus(settings, hookCommand(paths.hookBin, "darwin"))).toBe("installed");
    expect(health.takeLegacyHookMigrated()).toBe(true);
  });

  it("reinstalls a new-name hook left pointing at the old folder by a launch whose migration failed", async () => {
    const { paths, health } = setup((home) => oldSettings(hookCommand(join(home, ".butler", "bin", "shipherd-hook"), "darwin")), { marker: (home) => join(home, ".butler") });
    expect(await health.syncHookBinary()).toBe(true);
    const settings = JSON.parse(readFileSync(paths.claudeSettings, "utf8")) as ReturnType<typeof oldSettings>;
    expect(hookStatus(settings, hookCommand(paths.hookBin, "darwin"))).toBe("installed");
    expect(settings.hooks.PreToolUse).toEqual([userHook]);
  });

  it("does not touch the real settings from an isolated instance (SHIPHERD_HOME pointing somewhere else)", async () => {
    const before = (home: string) => oldSettings(hookCommand(legacyBin(join(home, ".butler")), "darwin"));
    const { paths, health } = setup(before, { dataDir: "sandbox" });
    await health.syncHookBinary();
    expect(JSON.parse(readFileSync(paths.claudeSettings, "utf8"))).toEqual(before(join(paths.home, "..")));
    expect(health.takeLegacyHookMigrated()).toBe(false);
  });

  it("refreshes a butler-hook binary still in the data folder, for claude sessions started before the upgrade", async () => {
    const { paths, health } = setup(undefined);
    mkdirSync(join(paths.home, "bin"), { recursive: true });
    const legacy = join(paths.home, "bin", "butler-hook");
    writeFileSync(legacy, "#!/bin/sh\necho old\n");
    await health.syncHookBinary();
    expect(readFileSync(legacy, "utf8")).toBe("#!/bin/sh\necho new\n");
  });

  it("leaves settings without legacy entries alone (hooks the user never installed stay uninstalled)", async () => {
    const mine = { hooks: { PreToolUse: [userHook] } };
    const { paths, health } = setup(mine);
    await health.syncHookBinary();
    expect(JSON.parse(readFileSync(paths.claudeSettings, "utf8"))).toEqual(mine);
    expect(existsSync(paths.hookBin)).toBe(false);
    expect(health.takeLegacyHookMigrated()).toBe(false);
  });
});
