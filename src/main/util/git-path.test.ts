import { describe, expect, it } from "vitest";
import { GIT_SAFE_ARGS, gitBinary, resolveGit, setGitBinary } from "./git-path";

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
    setGitBinary("git");
    expect(GIT_SAFE_ARGS).toEqual(["-c", "core.fsmonitor=false"]);
  });
});
