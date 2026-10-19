import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import {
  applyInstall, applyUninstall, HOOK_EVENTS, hookCommand, hookStatus, installHooks, readSettings,
  SettingsParseError, uninstallHooks,
} from "./installer";

const CMD = hookCommand("/Users/张 三/.butler/bin/butler-hook", "darwin");
const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };

describe("hookCommand", () => {
  it("quotes paths with spaces and non-ASCII characters", () => {
    expect(CMD).toBe('"/Users/张 三/.butler/bin/butler-hook"');
  });

  it("uses forward slashes on Windows", () => {
    expect(hookCommand("C:\\Users\\张 三\\.butler\\bin\\butler-hook.exe", "win32")).toBe('"C:/Users/张 三/.butler/bin/butler-hook.exe"');
  });
});

describe("applyInstall / applyUninstall", () => {
  it("adds one Butler hook per event and keeps unrelated settings", () => {
    const before = { model: "opus", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [userHook] } };
    const after = applyInstall(before, CMD);
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash(ls)"] });
    const hooks = after.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toEqual([userHook, { hooks: [{ type: "command", command: CMD, timeout: 10 }] }]);
    for (const e of HOOK_EVENTS) expect(hooks[e]).toBeDefined();
    expect(hookStatus(after, CMD)).toBe("installed");
    expect(before.hooks.Stop).toEqual([userHook]);
  });

  it("is idempotent", () => {
    const once = applyInstall({}, CMD);
    expect(applyInstall(once, CMD)).toEqual(once);
  });

  it("detects a stale command after the binary moved, and reinstall replaces it", () => {
    const old = applyInstall({}, hookCommand("/old/butler-hook", "darwin"));
    expect(hookStatus(old, CMD)).toBe("stale");
    expect(hookStatus(applyInstall(old, CMD), CMD)).toBe("installed");
  });

  it("reports partial and missing", () => {
    const full = applyInstall({}, CMD) as { hooks: Record<string, unknown> };
    delete full.hooks.Stop;
    expect(hookStatus(full, CMD)).toBe("partial");
    expect(hookStatus({ hooks: { Stop: [userHook] } }, CMD)).toBe("missing");
  });

  it("uninstall removes only Butler entries and cleans up empty containers", () => {
    const installed = applyInstall({ hooks: { Stop: [userHook] } }, CMD);
    expect(applyUninstall(installed)).toEqual({ hooks: { Stop: [userHook] } });
    expect(applyUninstall(applyInstall({}, CMD))).toEqual({});
  });
});

describe("settings file IO", () => {
  it("creates settings.json, backs up the original once, and uninstalls", async () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ model: "opus" }));
    await installHooks(file, "/b/butler-hook", "darwin");
    expect(JSON.parse(readFileSync(`${file}.butler-backup`, "utf8"))).toEqual({ model: "opus" });
    expect(hookStatus(await readSettings(file), hookCommand("/b/butler-hook", "darwin"))).toBe("installed");
    await installHooks(file, "/b/butler-hook", "darwin");
    expect(JSON.parse(readFileSync(`${file}.butler-backup`, "utf8"))).toEqual({ model: "opus" });
    await uninstallHooks(file);
    expect(await readSettings(file)).toEqual({ model: "opus" });
  });

  it("treats a missing file as empty", async () => {
    const file = join(tempDir(), "nested", "settings.json");
    expect(await readSettings(file)).toEqual({});
    await installHooks(file, "/b/butler-hook", "darwin");
    expect(existsSync(file)).toBe(true);
  });

  it("refuses to touch a malformed settings.json", async () => {
    const file = join(tempDir(), "settings.json");
    writeFileSync(file, "{ not json");
    await expect(installHooks(file, "/b/butler-hook", "darwin")).rejects.toBeInstanceOf(SettingsParseError);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});
