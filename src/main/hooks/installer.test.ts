import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import {
  applyInstall, applyUninstall, HOOK_EVENTS, hookCommand, hookStatus, installHookBinary, installHooks, isButlerHook, readSettings,
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

describe("Butler hook identification is exact", () => {
  it("does not treat user commands that merely mention butler-hook as Butler hooks", () => {
    const foreign = [
      "~/bin/my-butler-hook",
      "echo butler-hook",
      '"/x/my-butler-hook"',
      "~/scripts/run-butler-hook",
      "/usr/local/bin/my-butler-hook",
    ];
    for (const command of foreign) {
      const settings = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } };
      expect(isButlerHook(command)).toBe(false);
      expect(applyUninstall(applyInstall(settings, CMD))).toEqual(settings);
    }
  });

  it("recognises both the macOS and Windows forms produced by hookCommand", () => {
    expect(isButlerHook(hookCommand("/Users/张 三/.butler/bin/butler-hook", "darwin"))).toBe(true);
    expect(isButlerHook(hookCommand("C:\\Users\\张 三\\.butler\\bin\\butler-hook.exe", "win32"))).toBe(true);
  });

  it("install then uninstall leaves a user hook whose path ends in my-butler-hook intact", () => {
    const userOwn = { hooks: [{ type: "command", command: "~/bin/my-butler-hook" }] };
    const settings = { hooks: { PreToolUse: [{ matcher: "Bash", ...userOwn }] } };
    expect(applyUninstall(applyInstall(settings, CMD))).toEqual(settings);
  });
});

describe("merge safety", () => {
  it("uninstall does not delete empty event arrays Butler never touched", () => {
    const settings = { hooks: { PreToolUse: [] } };
    expect(applyUninstall(applyInstall(settings, CMD))).toEqual(settings);
  });

  it("refuses a non-object hooks or non-array event, without writing", async () => {
    const file = join(tempDir(), "settings.json");
    const original = JSON.stringify({ hooks: ["x"] });
    writeFileSync(file, original);
    await expect(installHooks(file, "/b/butler-hook", "darwin")).rejects.toBeInstanceOf(SettingsParseError);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(existsSync(`${file}.butler-backup`)).toBe(false);

    const file2 = join(tempDir(), "settings.json");
    writeFileSync(file2, JSON.stringify({ hooks: { Stop: "x" } }));
    await expect(installHooks(file2, "/b/butler-hook", "darwin")).rejects.toBeInstanceOf(SettingsParseError);
  });

  it("treats null groups and entries as foreign and keeps them untouched", () => {
    const settings = { hooks: { Stop: [null] } };
    expect(applyUninstall(applyInstall(settings, CMD))).toEqual(settings);
    const nullEntry = { hooks: { Stop: [{ hooks: [null] }] } };
    expect(applyUninstall(applyInstall(nullEntry, CMD))).toEqual(nullEntry);
    expect(hookStatus(applyInstall(nullEntry, CMD), CMD)).toBe("installed");
  });

  it("reads settings with a leading UTF-8 BOM", async () => {
    const file = join(tempDir(), "settings.json");
    writeFileSync(file, `\uFEFF${JSON.stringify({ model: "opus" })}`);
    expect(await readSettings(file)).toEqual({ model: "opus" });
  });

  it.skipIf(process.platform === "win32")("writes through a symlinked settings.json and keeps the link", async () => {
    const dir = tempDir();
    const real = join(dir, "real.json");
    const link = join(dir, "settings.json");
    writeFileSync(real, JSON.stringify({ model: "opus" }));
    symlinkSync(real, link);
    await installHooks(link, "/b/butler-hook", "darwin");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(hookStatus(await readSettings(real), hookCommand("/b/butler-hook", "darwin"))).toBe("installed");
  });

  it.skipIf(process.platform === "win32")("preserves the mode of an existing settings.json", async () => {
    const file = join(tempDir(), "settings.json");
    writeFileSync(file, JSON.stringify({ model: "opus" }));
    chmodSync(file, 0o600);
    await installHooks(file, "/b/butler-hook", "darwin");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("installHookBinary", () => {
  it("copies the content, makes it executable and replaces an existing copy", async () => {
    const dir = tempDir();
    const src = join(dir, "src-hook");
    const dest = join(dir, "bin", "butler-hook");
    writeFileSync(src, "#!/bin/sh\nexit 0\n");
    await installHookBinary(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") expect(statSync(dest).mode & 0o777).toBe(0o755);
    writeFileSync(src, "v2");
    await installHookBinary(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("v2");
    expect(existsSync(`${dest}.tmp`)).toBe(false);
  });

  it("fails without leaving a temp file when the source is missing", async () => {
    const dir = tempDir();
    const dest = join(dir, "bin", "butler-hook");
    await expect(installHookBinary(join(dir, "missing"), dest)).rejects.toThrow();
    expect(existsSync(`${dest}.tmp`)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  // A browser-downloaded app keeps com.apple.quarantine on its inner files; the copy must not inherit it.
  it.runIf(process.platform === "darwin")("does not carry extended attributes such as com.apple.quarantine (macOS)", async () => {
    const dir = tempDir();
    const src = join(dir, "src-hook");
    const dest = join(dir, "bin", "butler-hook");
    writeFileSync(src, "#!/bin/sh\nexit 0\n");
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", src]);
    expect(execFileSync("/usr/bin/xattr", [src], { encoding: "utf8" })).toContain("com.apple.quarantine");
    await installHookBinary(src, dest);
    expect(execFileSync("/usr/bin/xattr", [dest], { encoding: "utf8" })).not.toContain("com.apple.quarantine");
  });
});
