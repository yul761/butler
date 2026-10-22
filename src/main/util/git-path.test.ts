import { afterEach, describe, expect, it } from "vitest";
import { applyGitResolution, GIT_SAFE_ARGS, gitBinary, GitUnavailableError, resetGitBinary, resolveGit, setGitBinary } from "./git-path";

describe("git binary (plan 3 residual: Windows looks in the current directory first)", () => {
  it("finds git only in absolute PATH directories", () => {
    const exists = (p: string) => p === "/usr/bin/git" || !p.startsWith("/");
    expect(resolveGit(".:relative/bin:/usr/bin", "darwin", exists)).toBe("/usr/bin/git");
    expect(resolveGit("relative/bin", "darwin", () => true)).toBeNull();
  });

  it("never picks git from the current directory or a relative PATH entry on Windows (Review Focus 2)", () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p === "C:\\Program Files\\Git\\cmd\\git.exe" || !/^[A-Za-z]:\\/.test(p);
    };
    expect(resolveGit('.;"C:\\Program Files\\Git\\cmd";bin', "win32", exists)).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(seen.every((p) => /^[A-Za-z]:\\/.test(p))).toBe(true);
    // 只认 git.exe：git.cmd 需要 cmd.exe 才能执行。
    expect(resolveGit("C:\\tools", "win32", (p) => p.endsWith("git.cmd"))).toBeNull();
  });

  it("defaults to plain git until a path is set, and always disables fsmonitor", () => {
    expect(gitBinary()).toBe("git");
    setGitBinary("/opt/git/bin/git");
    expect(gitBinary()).toBe("/opt/git/bin/git");
    resetGitBinary();
    expect(GIT_SAFE_ARGS).toEqual(["-c", "core.fsmonitor=false"]);
  });
});

describe("git binary when PATH has no git", () => {
  afterEach(resetGitBinary);

  it("win32: refuses to run git (never a bare git, which Windows resolves in the cwd) and warns once", () => {
    const logs: string[] = [];
    applyGitResolution(null, "win32", (m) => logs.push(m));
    applyGitResolution(null, "win32", (m) => logs.push(m));
    expect(() => gitBinary()).toThrow(GitUnavailableError);
    expect(() => gitBinary()).toThrow("git not found; install Git for Windows or set PATH");
    expect(logs).toHaveLength(1);
  });

  it.each(["darwin", "linux"] as const)("%s: falls back to plain git and warns once", (platform) => {
    const logs: string[] = [];
    applyGitResolution(null, platform, (m) => logs.push(m));
    applyGitResolution(null, platform, (m) => logs.push(m));
    expect(gitBinary()).toBe("git");
    expect(logs).toHaveLength(1);
  });

  it("a later (login shell) result replaces a not-found state and an earlier PATH result, and a later miss does not undo it", () => {
    const log = () => undefined;
    applyGitResolution(null, "win32", log);
    applyGitResolution("C:\\Git\\cmd\\git.exe", "win32", log);
    expect(gitBinary()).toBe("C:\\Git\\cmd\\git.exe");
    applyGitResolution("D:\\other\\git.exe", "win32", log);
    expect(gitBinary()).toBe("D:\\other\\git.exe");
    applyGitResolution(null, "win32", log);
    expect(gitBinary()).toBe("D:\\other\\git.exe");
  });
});
