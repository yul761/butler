// BTL-260：Electron 的 userData 从 <appData>/butler 变成 <appData>/shipherd。butler 是旧目录名。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { legacyUserDataDir } from "./legacy-user-data";

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
