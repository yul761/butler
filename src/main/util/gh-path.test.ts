import { describe, expect, it } from "vitest";
import { resolveGh } from "./gh-path";

describe("resolveGh", () => {
  it("finds gh only in absolute PATH directories", () => {
    const exists = (p: string) => p === "/opt/homebrew/bin/gh" || !p.startsWith("/");
    expect(resolveGh(".:relative/bin:/usr/bin:/opt/homebrew/bin", "darwin", exists)).toBe("/opt/homebrew/bin/gh");
    expect(resolveGh("relative/bin", "darwin", () => true)).toBeNull();
  });

  it("on Windows only takes gh.exe from absolute directories, never the current directory", () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p === "C:\\Program Files\\GitHub CLI\\gh.exe" || !/^[A-Za-z]:\\/.test(p);
    };
    expect(resolveGh('.;"C:\\Program Files\\GitHub CLI";bin', "win32", exists)).toBe("C:\\Program Files\\GitHub CLI\\gh.exe");
    expect(seen.every((p) => /^[A-Za-z]:\\/.test(p))).toBe(true);
    expect(resolveGh("C:\\tools", "win32", (p) => p.endsWith("gh.cmd"))).toBeNull();
  });
});
