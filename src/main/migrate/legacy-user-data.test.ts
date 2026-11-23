// BTL-260：Electron 的 userData 从 <appData>/butler 变成 <appData>/shipherd。butler 是旧目录名。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { legacyButlerHolder, legacyUserDataDir } from "./legacy-user-data";

describe("legacyUserDataDir", () => {
  it("keeps using the old userData of a Butler install (the Windows safeStorage key lives in its Local State)", () => {
    const appData = tempDir("shipherd-ud-");
    mkdirSync(join(appData, "butler"));
    writeFileSync(join(appData, "butler", "Local State"), "{}");
    expect(legacyUserDataDir(appData, existsSync)).toBe(join(appData, "butler"));
    // Electron 在 ready 之前就可能建好空的新目录：没有 Local State 就还算没用过。
    mkdirSync(join(appData, "shipherd"));
    expect(legacyUserDataDir(appData, existsSync)).toBe(join(appData, "butler"));
  });

  it("uses the new folder for a new user, or once the new folder has been used", () => {
    const fresh = tempDir("shipherd-ud-");
    expect(legacyUserDataDir(fresh, existsSync)).toBeNull();
    const both = tempDir("shipherd-ud-");
    mkdirSync(join(both, "butler"));
    mkdirSync(join(both, "shipherd"));
    writeFileSync(join(both, "shipherd", "Local State"), "{}");
    expect(legacyUserDataDir(both, existsSync)).toBeNull();
  });
});

describe("legacyButlerHolder", () => {
  const table = (...args: string[]) => new Map(args.map((a, i) => [i + 1, { args: a }]));
  it("finds the old Butler holding the shared single-instance lock on macOS and Windows", () => {
    expect(legacyButlerHolder(table("/sbin/launchd", "/Applications/Butler.app/Contents/MacOS/Butler"))).toBe("butler");
    expect(legacyButlerHolder(table("/Applications/Butler.app/Contents/MacOS/Butler -psn_0_1"))).toBe("butler");
    expect(legacyButlerHolder(table('"C:\\Users\\u\\AppData\\Local\\Programs\\Butler\\Butler.exe" --type=renderer'))).toBe("butler");
    expect(legacyButlerHolder(table("Butler.exe"))).toBe("butler");
  });

  it("is none for Shipherd itself or programs that only mention butler, and unknown without a process table", () => {
    expect(legacyButlerHolder(table("/Applications/Shipherd.app/Contents/MacOS/Shipherd", "/Applications/Butler.app/Contents/Frameworks/Butler Helper.app/Contents/MacOS/Butler Helper", "vim notes/Butler.md", "C:\\x\\NotButler.exe"))).toBe("none");
    expect(legacyButlerHolder(null)).toBe("unknown");
  });
});
