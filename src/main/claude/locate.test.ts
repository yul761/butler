import { describe, expect, it } from "vitest";
import { absolutePathEntries, findOnPath, locateClaude, readLoginShellPath, wellKnownClaudePaths } from "./locate";

describe("readLoginShellPath", () => {
  it("extracts PATH between markers, ignoring shell noise", async () => {
    const run = async () => "Welcome!\n__BUTLER_PATH_START__/opt/bin:/usr/bin__BUTLER_PATH_END__\n";
    expect(await readLoginShellPath("darwin", { SHELL: "/bin/zsh", PATH: "/usr/bin" }, run)).toBe("/opt/bin:/usr/bin");
  });

  it("falls back to the process PATH when the shell fails or prints no markers", async () => {
    expect(await readLoginShellPath("darwin", { PATH: "/usr/bin" }, async () => { throw new Error("boom"); })).toBe("/usr/bin");
    expect(await readLoginShellPath("darwin", { PATH: "/usr/bin" }, async () => "nothing")).toBe("/usr/bin");
  });

  it("uses the inherited PATH on Windows", async () => {
    expect(await readLoginShellPath("win32", { Path: "C:\\bin" }, async () => "unused")).toBe("C:\\bin");
  });
});

describe("findOnPath / locateClaude", () => {
  it("finds a posix binary", () => {
    const exists = (p: string) => p === "/opt/bin/claude";
    expect(findOnPath("claude", "/usr/bin:/opt/bin", "darwin", undefined, exists)).toBe("/opt/bin/claude");
  });

  it("searches PATH in order and prefers .exe within a directory on Windows", () => {
    const exists = (p: string) => p === "C:\\npm\\claude.cmd" || p === "C:\\tools\\claude.exe";
    expect(findOnPath("claude", "C:\\npm;C:\\tools", "win32", ".EXE;.CMD", exists)).toBe("C:\\npm\\claude.cmd");
    expect(findOnPath("claude", "C:\\tools;C:\\npm", "win32", ".EXE;.CMD", exists)).toBe("C:\\tools\\claude.exe");
  });

  it("uses an existing override and rejects a missing one", () => {
    expect(locateClaude({ override: "/x/claude", pathValue: "", platform: "darwin", exists: () => true })).toBe("/x/claude");
    expect(locateClaude({ override: "/x/claude", pathValue: "/opt/bin", platform: "darwin", exists: () => false })).toBeNull();
  });

  it("falls back to well-known install locations only when PATH has no claude", () => {
    const fallbacks = wellKnownClaudePaths("darwin", { home: "/Users/u" });
    expect(fallbacks).toEqual(["/Users/u/.local/bin/claude", "/Users/u/.claude/local/claude"]);
    const local = (p: string) => p === "/Users/u/.local/bin/claude";
    expect(locateClaude({ override: "", pathValue: "/usr/bin", platform: "darwin", exists: local, fallbacks })).toBe("/Users/u/.local/bin/claude");
    const both = (p: string) => local(p) || p === "/usr/bin/claude";
    expect(locateClaude({ override: "", pathValue: "/usr/bin", platform: "darwin", exists: both, fallbacks })).toBe("/usr/bin/claude");
    expect(locateClaude({ override: "", pathValue: "/usr/bin", platform: "darwin", exists: () => false, fallbacks })).toBeNull();
    // 填了路径就只认它，不回退。
    expect(locateClaude({ override: "/x/claude", pathValue: "", platform: "darwin", exists: local, fallbacks })).toBeNull();
  });

  it("lists the Windows install locations with Windows separators", () => {
    expect(wellKnownClaudePaths("win32", { home: "C:\\Users\\u", appData: "C:\\Users\\u\\AppData\\Roaming" })).toEqual([
      "C:\\Users\\u\\.local\\bin\\claude.exe",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd",
    ]);
    expect(wellKnownClaudePaths("linux", {})).toEqual([]);
  });
});

describe("absolutePathEntries", () => {
  it("drops relative and empty PATH entries and unquotes Windows entries", () => {
    expect(absolutePathEntries(".:/usr/bin::bin:/opt/x", "darwin")).toBe("/usr/bin:/opt/x");
    expect(absolutePathEntries('.;"C:\\Program Files\\Git\\cmd";bin;;D:\\tools', "win32")).toBe("C:\\Program Files\\Git\\cmd;D:\\tools");
  });
});
