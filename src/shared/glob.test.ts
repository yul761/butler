import { describe, expect, it } from "vitest";
import { inScope, matchGlob, normalizePath } from "./glob";

describe("glob", () => {
  it("matches ** across directories, including zero", () => {
    expect(matchGlob("src/main/a.ts", "src/**")).toBe(true);
    expect(matchGlob("src/a.ts", "src/**/a.ts")).toBe(true);
    expect(matchGlob("src/x/y/a.ts", "src/**/a.ts")).toBe(true);
    expect(matchGlob("lib/a.ts", "src/**")).toBe(false);
  });

  it("keeps * inside one segment", () => {
    expect(matchGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchGlob("src/x/a.ts", "src/*.ts")).toBe(false);
  });

  it("treats a pattern without / as a file name anywhere", () => {
    expect(matchGlob("deep/dir/file.tsx", "*.tsx")).toBe(true);
    expect(matchGlob("file.tsx", "*.tsx")).toBe(true);
    expect(matchGlob("deep/dir/file.ts", "*.tsx")).toBe(false);
  });

  it("supports ?, classes and braces", () => {
    expect(matchGlob("a1.ts", "a?.ts")).toBe(true);
    expect(matchGlob("ab.ts", "a[0-9].ts")).toBe(false);
    expect(matchGlob("ab.ts", "a[!0-9].ts")).toBe(true);
    expect(matchGlob("src/a.tsx", "src/*.{ts,tsx}")).toBe(true);
    expect(matchGlob("src/a.js", "src/*.{ts,tsx}")).toBe(false);
  });

  it("treats a trailing slash as everything below", () => {
    expect(matchGlob("src/renderer/x/y.ts", "src/renderer/")).toBe(true);
    expect(matchGlob("src/main/y.ts", "src/renderer/")).toBe(false);
  });

  it("gives the same answer for either separator in path or pattern", () => {
    for (const path of ["src/main/a.ts", "src\\main\\a.ts", "./src/main/a.ts"]) {
      for (const pat of ["src/main/**", "src\\main\\**", "src/**/*.ts", "src\\**\\*.ts"]) expect(matchGlob(path, pat), `${path} ${pat}`).toBe(true);
    }
    expect(normalizePath(".\\a\\\\b")).toBe("a/b");
  });

  it("escapes regex characters", () => {
    expect(matchGlob("a+b.ts", "a+b.ts")).toBe(true);
    expect(matchGlob("aab.ts", "a+b.ts")).toBe(false);
    expect(matchGlob("x(1).ts", "x(1).ts")).toBe(true);
  });

  it("inScope: empty globs = everywhere, exclude wins", () => {
    expect(inScope("a/b.ts", [])).toBe(true);
    expect(inScope("a/b.test.ts", ["a/**"], ["*.test.ts"])).toBe(false);
    expect(inScope("a/b.ts", ["a/**"], ["*.test.ts"])).toBe(true);
    expect(inScope("c/b.ts", ["a/**"])).toBe(false);
  });
});
